import { Inject, Injectable } from '@nestjs/common';
import {
  Prisma,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  ShowcaseCardKind,
  ShowcaseCardStatus,
  ShowcaseVersionReview,
} from '@prisma/client';
import { areaCovers, describeArea } from '../../common/provider-service-area-scope';
import { runSerializable } from '../../common/serializable-transaction';
import { showcaseAreaKey, toShowcaseAreaRow } from '../../common/showcase-area-key';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveArea } from '../locations/turkey-locations';
import {
  CreateShowcaseCardDto,
  ShowcaseCardContentDto,
  UpdateShowcaseCardDto,
} from './dto/create-showcase-card.dto';
import { SubmitShowcaseCardDto } from './dto/submit-showcase-card.dto';
import {
  showcaseAreaDuplicate,
  showcaseAreaNotCovered,
  showcaseAreaUnknown,
  showcaseCardLocked,
  showcaseCardNotFound,
  showcaseCategoryInvalid,
  showcaseNothingToSubmit,
  showcasePriceTermsRequired,
  showcaseVersionUnderReview,
} from './showcase.errors';
import { showcaseCardInclude, toShowcaseCard } from './showcase.projection';
import {
  SHOWCASE_PRICE_TERMS_TEXT,
  SHOWCASE_PRICE_TERMS_VERSION,
  SHOWCASE_SLA_NORMAL_DEFAULT_HOURS,
  SHOWCASE_SLA_URGENT_DEFAULT_HOURS,
} from './showcase.constants';
import { classifyShowcaseEdit, type ShowcaseVersionShape } from './showcase-version.rules';

/**
 * A provider's own vitrin cards: creating them, editing them, and handing one to
 * an operator.
 *
 * ## The one rule this service exists to hold
 *
 * **Nothing a provider writes reaches a live card without an operator, except a
 * change that removes areas and alters nothing else.**
 *
 * Every method below is a consequence of that sentence:
 *
 * - Content is never written onto a live version. An edit to an approved card
 *   creates the *next* version and leaves `liveVersionId` where it was, so the
 *   card on the air is the text somebody approved until somebody approves
 *   another one.
 * - A submitted version is frozen. `ShowcaseCardReview.cardVersionId` names the
 *   exact text an operator read, and that is only true if the text cannot move
 *   underneath them.
 * - The narrowing exemption publishes without a review row and writes
 *   `ShowcaseCardAutoPublishAudit` instead. A system-authored row in the review
 *   table would make "who approved this" unanswerable for every row in it.
 *
 * ## What this phase deliberately does not do
 *
 * An approved card is a reviewed text and nothing more. There is no package, no
 * placement, no customer surface and no lead: nothing in the product renders one
 * of these to a visitor, and no endpoint here publishes anything beyond setting
 * the pointer that a later phase will read.
 */
@Injectable()
export class ProviderShowcaseCardsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The terms the submit endpoint requires acceptance of, for the form to show. */
  getPriceTerms() {
    return { version: SHOWCASE_PRICE_TERMS_VERSION, text: SHOWCASE_PRICE_TERMS_TEXT };
  }

  async listCards(providerId: string) {
    const cards = await this.prisma.showcaseCard.findMany({
      where: { providerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: showcaseCardInclude,
    });

    return cards.map(toShowcaseCard);
  }

  async getCard(providerId: string, cardId: string) {
    const card = await this.loadOwnedCard(providerId, cardId);
    return toShowcaseCard(card);
  }

  /**
   * A new card, and its first version, in one transaction.
   *
   * The card is created before the version because the version's foreign key
   * points at it, and the card's `draftVersionId` is set afterwards because that
   * foreign key points back — a deliberate cycle, and the same one
   * `ServiceRequest.matchedOfferId` already forms with `Offer.requestId`. Both
   * pointers are nullable, so there is an order that works; all three statements
   * are in one transaction, so no reader sees a card with no draft.
   */
  async createCard(providerId: string, dto: CreateShowcaseCardDto) {
    await this.assertCategoryFitsKind(dto.categoryId, dto.kind);
    const content = await this.normalizeContent(providerId, dto, dto.kind);

    const cardId = await this.prisma.$transaction(async (tx) => {
      const card = await tx.showcaseCard.create({
        data: {
          providerId,
          kind: dto.kind,
          categoryId: dto.categoryId,
          status: ShowcaseCardStatus.DRAFT,
        },
        select: { id: true },
      });

      const version = await this.writeVersion(tx, {
        cardId: card.id,
        versionNumber: 1,
        content,
        reviewStatus: ShowcaseVersionReview.DRAFT,
      });

      await tx.showcaseCard.update({
        where: { id: card.id },
        data: { draftVersionId: version.id },
      });

      return card.id;
    });

    return this.getCard(providerId, cardId);
  }

  /**
   * An edit, routed to one of four outcomes by what the card currently holds.
   *
   * 1. **A draft under review** — refused. The version an operator is holding
   *    does not change.
   * 2. **An open draft** — rewritten in place. It has never been seen by anybody
   *    but its owner, so there is no history to preserve and no reason to burn a
   *    version number on every keystroke.
   * 3. **No draft, no live version** — a new draft. This is the card whose first
   *    version was rejected: the rejected version stays in history exactly as it
   *    was refused, and the provider's next attempt is version two.
   * 4. **No draft, a live version** — the narrowing rule decides. See
   *    `classifyShowcaseEdit`.
   */
  async updateCard(providerId: string, cardId: string, dto: UpdateShowcaseCardDto) {
    const card = await this.loadOwnedCard(providerId, cardId);
    assertCardIsEditable(card);

    // Checked before the body is normalised, so a provider editing a card that
    // is with an operator is told that — rather than being told about an area
    // they cannot save either way.
    if (card.draftVersion && card.draftVersion.reviewStatus !== ShowcaseVersionReview.DRAFT) {
      throw showcaseVersionUnderReview();
    }

    const content = await this.normalizeContent(providerId, dto, card.kind);

    if (card.draftVersion) {
      await this.rewriteDraft(card.draftVersion.id, content);
      return this.getCard(providerId, cardId);
    }

    if (!card.liveVersion) {
      await this.openNewDraft(card, content);
      return this.getCard(providerId, cardId);
    }

    const live: ShowcaseVersionShape = {
      kind: card.liveVersion.kindSnapshot,
      title: card.liveVersion.title,
      summary: card.liveVersion.summary,
      scopeIncluded: card.liveVersion.scopeIncluded,
      scopeExcluded: card.liveVersion.scopeExcluded,
      listedServicePriceAmount: card.liveVersion.listedServicePriceAmount,
      listedServiceCurrency: card.liveVersion.listedServiceCurrency,
      imageUrl: card.liveVersion.imageUrl,
      responseSlaUrgentHours: card.liveVersion.responseSlaUrgentHours,
      responseSlaNormalHours: card.liveVersion.responseSlaNormalHours,
      areaKeys: card.liveVersion.areas.map((area) => area.areaKey),
    };

    const verdict = classifyShowcaseEdit(live, {
      ...content,
      kind: card.kind,
      areaKeys: content.areas.map((area) => area.areaKey),
    });

    if (verdict.kind === 'NO_CHANGE') {
      return this.getCard(providerId, cardId);
    }

    if (verdict.kind === 'REVIEW') {
      await this.openNewDraft(card, content);
      return this.getCard(providerId, cardId);
    }

    await this.publishNarrowedVersion(card, content, verdict.removedAreaKeys);
    return this.getCard(providerId, cardId);
  }

  /**
   * Hands the open draft to an operator, with the provider's acceptance of the
   * price-responsibility text attached.
   *
   * The acceptance and the transition are one statement. The database refuses a
   * non-DRAFT version carrying no acceptance, so "submitted without accepting"
   * is not a case the reviewer has to think about — it cannot be stored.
   *
   * The card's own status moves to PENDING_REVIEW only when there is nothing
   * live to protect. A card that already serves an approved version stays
   * APPROVED throughout: what is under review is the replacement, and the card
   * is not off the air while somebody reads it.
   */
  async submitCard(providerId: string, cardId: string, dto: SubmitShowcaseCardDto) {
    const card = await this.loadOwnedCard(providerId, cardId);
    assertCardIsEditable(card);

    if (!card.draftVersion) {
      throw showcaseNothingToSubmit();
    }

    if (card.draftVersion.reviewStatus !== ShowcaseVersionReview.DRAFT) {
      throw showcaseVersionUnderReview();
    }

    if (!dto.priceTermsAccepted || dto.priceTermsVersion !== SHOWCASE_PRICE_TERMS_VERSION) {
      throw showcasePriceTermsRequired();
    }

    // The areas are re-checked against the provider's coverage at submit time as
    // well as at write time. A provider may have removed a service area from
    // their profile since the draft was written, and an operator must not be
    // asked to approve a claim the business no longer backs.
    await this.assertAreasAreCovered(
      providerId,
      card.draftVersion.areas.map((area) => ({
        city: area.city,
        district: area.district,
        neighborhood: area.neighborhood,
      })),
    );

    const now = new Date();
    const draftId = card.draftVersion.id;

    await this.prisma.$transaction(async (tx) => {
      // Conditional, so two submits of one draft cannot both land: the second
      // matches nothing and is reported as the conflict it is.
      const moved = await tx.showcaseCardVersion.updateMany({
        where: { id: draftId, reviewStatus: ShowcaseVersionReview.DRAFT },
        data: {
          reviewStatus: ShowcaseVersionReview.PENDING,
          submittedAt: now,
          priceTermsVersion: SHOWCASE_PRICE_TERMS_VERSION,
          priceTermsAcceptedAt: now,
        },
      });

      if (moved.count !== 1) {
        throw showcaseVersionUnderReview();
      }

      if (!card.liveVersionId) {
        await tx.showcaseCard.update({
          where: { id: card.id },
          data: { status: ShowcaseCardStatus.PENDING_REVIEW },
        });
      }
    });

    return this.getCard(providerId, cardId);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * The card, or a 404 that says nothing about whether it exists.
   *
   * The provider id comes from the route and has already been checked against
   * the session by ProviderAccessGuard; putting it in the `where` as well is
   * what makes another provider's card id indistinguishable from a made-up one.
   */
  private async loadOwnedCard(providerId: string, cardId: string) {
    const card = await this.prisma.showcaseCard.findFirst({
      where: { id: cardId, providerId },
      include: showcaseCardInclude,
    });

    if (!card) {
      throw showcaseCardNotFound();
    }

    return card;
  }

  private async rewriteDraft(versionId: string, content: NormalizedContent) {
    await this.prisma.$transaction(async (tx) => {
      await tx.showcaseCardVersion.update({
        where: { id: versionId },
        data: versionContentData(content),
      });

      // Replaced wholesale rather than diffed. The areas of a draft are a set the
      // provider restates on every save, and a diff would be a second definition
      // of what "the same area" means beside the key that already answers it.
      await tx.showcaseCardVersionArea.deleteMany({ where: { cardVersionId: versionId } });
      await tx.showcaseCardVersionArea.createMany({
        data: content.areas.map((area) => ({ cardVersionId: versionId, ...area })),
      });
    });
  }

  /**
   * The next version, opened as a draft.
   *
   * The card's own status follows one rule: a card with something live keeps
   * saying APPROVED, because it is — what is being drafted is the replacement.
   * A card with nothing live goes back to DRAFT, which matters for exactly one
   * case: the card whose first version was refused. Leaving it REJECTED while
   * its owner is actively rewriting it would show them a verdict on a text that
   * no longer exists.
   */
  private async openNewDraft(
    card: { id: string; liveVersionId: string | null },
    content: NormalizedContent,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const version = await this.writeVersion(tx, {
        cardId: card.id,
        versionNumber: await nextVersionNumber(tx, card.id),
        content,
        reviewStatus: ShowcaseVersionReview.DRAFT,
      });

      await tx.showcaseCard.update({
        where: { id: card.id },
        data: {
          draftVersionId: version.id,
          ...(card.liveVersionId ? {} : { status: ShowcaseCardStatus.DRAFT }),
        },
      });
    });
  }

  /**
   * The narrowing case: a new version that goes live without an operator, and
   * the audit row that records it did.
   *
   * Serializable, because three things have to be true together — the new
   * version exists, the card points at it, and the audit names both. A crash
   * between them would leave either a live card nobody can explain or an audit
   * row for a publication that did not happen.
   *
   * The price-terms acceptance is copied forward from the version being
   * replaced. That is the truthful record: this text is word for word the text
   * the provider already accepted, and stamping today's terms version onto it
   * would claim an acceptance that was never given. If the terms have been
   * bumped since, the new live version honestly carries the older acceptance.
   */
  private async publishNarrowedVersion(
    card: { id: string; providerId: string; liveVersionId: string | null },
    content: NormalizedContent,
    removedAreaKeys: string[],
  ) {
    const previousVersionId = card.liveVersionId;
    if (!previousVersionId) {
      // Unreachable: the caller only classifies an edit when a live version
      // exists. Stated rather than assumed, because the audit row's
      // `previousVersionId` is NOT NULL and a silent undefined here would
      // surface as a foreign-key error nobody could read.
      throw showcaseCardNotFound();
    }

    await runSerializable(this.prisma, async (tx) => {
      const previous = await tx.showcaseCardVersion.findUnique({
        where: { id: previousVersionId },
        select: { priceTermsVersion: true, priceTermsAcceptedAt: true },
      });

      const now = new Date();
      const version = await this.writeVersion(tx, {
        cardId: card.id,
        versionNumber: await nextVersionNumber(tx, card.id),
        content,
        reviewStatus: ShowcaseVersionReview.APPROVED,
        priceTerms: {
          version: previous?.priceTermsVersion ?? SHOWCASE_PRICE_TERMS_VERSION,
          acceptedAt: previous?.priceTermsAcceptedAt ?? now,
        },
        submittedAt: now,
        publishedAt: now,
      });

      await tx.showcaseCard.update({
        where: { id: card.id },
        data: { liveVersionId: version.id },
      });

      await tx.showcaseCardAutoPublishAudit.create({
        data: {
          cardVersionId: version.id,
          cardId: card.id,
          previousVersionId,
          providerId: card.providerId,
          removedAreaKeys,
        },
      });
    }, { label: 'showcase.publishNarrowedVersion' });
  }

  private async writeVersion(
    tx: Prisma.TransactionClient,
    input: {
      cardId: string;
      versionNumber: number;
      content: NormalizedContent;
      reviewStatus: ShowcaseVersionReview;
      priceTerms?: { version: string; acceptedAt: Date };
      submittedAt?: Date;
      publishedAt?: Date;
    },
  ) {
    const version = await tx.showcaseCardVersion.create({
      data: {
        cardId: input.cardId,
        versionNumber: input.versionNumber,
        kindSnapshot: input.content.kind,
        ...versionContentData(input.content),
        reviewStatus: input.reviewStatus,
        priceTermsVersion: input.priceTerms?.version ?? null,
        priceTermsAcceptedAt: input.priceTerms?.acceptedAt ?? null,
        submittedAt: input.submittedAt ?? null,
        publishedAt: input.publishedAt ?? null,
      },
      select: { id: true },
    });

    await tx.showcaseCardVersionArea.createMany({
      data: input.content.areas.map((area) => ({ cardVersionId: version.id, ...area })),
    });

    return version;
  }

  /**
   * Turns a request body into the rows this feature stores, refusing everything
   * it cannot make canonical.
   *
   * Four checks, and none of them trusts the client:
   *
   * 1. Every area resolves against the shipped Turkish location list, and the
   *    *canonical* spelling is what gets stored — so "kadikoy" and "Kadıköy" are
   *    one area rather than two that never match each other.
   * 2. The scope and the comparison key are derived from those levels here. A
   *    body carries places; it never carries a key or a scope.
   * 3. No area appears twice, judged by the key rather than by the text.
   * 4. Every area is inside the provider's own service areas. A card cannot
   *    claim reach the business has not claimed.
   */
  private async normalizeContent(
    providerId: string,
    dto: ShowcaseCardContentDto,
    kind: ShowcaseCardKind,
  ): Promise<NormalizedContent> {
    const resolved = dto.areas.map((area) => {
      const canonical = resolveArea({
        city: area.city,
        district: area.district ?? null,
        neighborhood: area.neighborhood ?? null,
      });

      if (!canonical) {
        throw showcaseAreaUnknown();
      }

      return canonical;
    });

    const seen = new Set<string>();
    for (const area of resolved) {
      const key = showcaseAreaKey(area);
      if (seen.has(key)) {
        throw showcaseAreaDuplicate(describeArea(area));
      }
      seen.add(key);
    }

    await this.assertAreasAreCovered(providerId, resolved);

    const price = dto.listedServicePriceAmount ?? null;
    if (kind === ShowcaseCardKind.SERVICE && price === null) {
      throw showcaseCategoryInvalid('Hizmet vitrini kartı için sabit hizmet bedeli zorunludur.');
    }
    if (kind === ShowcaseCardKind.PROMOTION && price !== null) {
      throw showcaseCategoryInvalid(
        'Genel tanıtım kartı sabit hizmet bedeli taşıyamaz; müşteri hizmeti talep sırasında seçer.',
      );
    }

    const urgent = dto.responseSlaUrgentHours ?? SHOWCASE_SLA_URGENT_DEFAULT_HOURS;
    const normal = dto.responseSlaNormalHours ?? SHOWCASE_SLA_NORMAL_DEFAULT_HOURS;
    if (urgent > normal) {
      throw showcaseCategoryInvalid(
        'Acil talep yanıt süresi, normal talep yanıt süresinden uzun olamaz.',
      );
    }

    return {
      kind,
      title: dto.title.trim(),
      summary: dto.summary.trim(),
      scopeIncluded: normalizeScope(dto.scopeIncluded),
      scopeExcluded: normalizeScope(dto.scopeExcluded),
      listedServicePriceAmount: price,
      listedServiceCurrency: 'TRY',
      imageUrl: normalizeOptional(dto.imageUrl),
      responseSlaUrgentHours: urgent,
      responseSlaNormalHours: normal,
      areas: resolved.map(toShowcaseAreaRow),
    };
  }

  /**
   * Every card area has to sit inside one of the provider's own service areas.
   *
   * `areaCovers` is the same containment test the profile form applies to its
   * own list — "İstanbul geneli" covers "İstanbul/Kadıköy", which covers
   * "İstanbul/Kadıköy/Moda" — so a card cannot reach further than the business
   * says it works, and the two definitions of reach cannot drift apart.
   *
   * This is not a substitute for the wider question of who approves a change to
   * `ProviderServiceArea` itself; that flow is untouched by this phase.
   */
  private async assertAreasAreCovered(
    providerId: string,
    areas: Array<{ city: string; district: string | null; neighborhood: string | null }>,
  ) {
    const coverage = await this.prisma.providerServiceArea.findMany({
      where: { providerId },
      select: { city: true, district: true, neighborhood: true },
    });

    for (const area of areas) {
      if (!coverage.some((owned) => areaCovers(owned, area))) {
        throw showcaseAreaNotCovered(describeArea(area));
      }
    }
  }

  /**
   * The category a card may be listed under.
   *
   * A SERVICE card names one service, so it needs a LEAF — the same node a
   * request, an offer and a price already attach to. A PROMOTION card is the
   * business itself on a shelf, so a GROUP is allowed too.
   *
   * A ROUTER is refused for both. A router is a question whose options name
   * other categories; it is not somewhere a business can be listed, and a card
   * pointing at one would have no answer to "which service is this".
   *
   * A DRAFT category is refused for the reason `fanOutApprovedRequest` already
   * refuses one: it is an operator's release preparation, and an unreleased
   * service's name must not leave the admin surface.
   */
  private async assertCategoryFitsKind(categoryId: string, kind: ShowcaseCardKind) {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, kind: true, status: true },
    });

    if (!category) {
      throw showcaseCategoryInvalid('Seçilen kategori bulunamadı.');
    }

    if (category.status === ServiceCategoryStatus.DRAFT) {
      throw showcaseCategoryInvalid('Bu kategori henüz yayında değil.');
    }

    if (category.kind === ServiceCategoryKind.ROUTER) {
      throw showcaseCategoryInvalid('Yönlendirme kategorisi altında vitrin kartı açılamaz.');
    }

    if (kind === ShowcaseCardKind.SERVICE && category.kind !== ServiceCategoryKind.LEAF) {
      throw showcaseCategoryInvalid(
        'Hizmet vitrini kartı yalnız tek bir hizmet kategorisine bağlanabilir.',
      );
    }
  }
}

type NormalizedContent = {
  kind: ShowcaseCardKind;
  title: string;
  summary: string;
  scopeIncluded: string[];
  scopeExcluded: string[];
  listedServicePriceAmount: number | null;
  listedServiceCurrency: string;
  imageUrl: string | null;
  responseSlaUrgentHours: number;
  responseSlaNormalHours: number;
  areas: ReturnType<typeof toShowcaseAreaRow>[];
};

function versionContentData(content: NormalizedContent) {
  return {
    title: content.title,
    summary: content.summary,
    scopeIncluded: content.scopeIncluded,
    scopeExcluded: content.scopeExcluded,
    listedServicePriceAmount: content.listedServicePriceAmount,
    listedServiceCurrency: content.listedServiceCurrency,
    imageUrl: content.imageUrl,
    responseSlaUrgentHours: content.responseSlaUrgentHours,
    responseSlaNormalHours: content.responseSlaNormalHours,
  };
}

/**
 * The next version number for a card.
 *
 * Read off the highest one that exists rather than counted, so a history with a
 * gap in it — which nothing produces today, and a future archive step might —
 * cannot hand out a number that is already taken. The unique index on
 * `(cardId, versionNumber)` is what turns a race here into a refusal rather than
 * two versions wearing one number.
 */
async function nextVersionNumber(tx: Prisma.TransactionClient, cardId: string): Promise<number> {
  const highest = await tx.showcaseCardVersion.findFirst({
    where: { cardId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  });

  return (highest?.versionNumber ?? 0) + 1;
}

/** Trimmed, with the empties dropped — a blank bullet is not a scope item. */
function normalizeScope(items: string[]): string[] {
  const cleaned = items.map((item) => item.trim()).filter((item) => item.length > 0);

  if (cleaned.length === 0) {
    throw showcaseCategoryInvalid('Kapsam listeleri boş bırakılamaz.');
  }

  return cleaned;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Suspended and archived cards are not editable.
 *
 * Nothing writes either state in this phase, so nothing reaches this today. It
 * is here because the states exist, and the day an operator gets a pull-down
 * button the alternative would be a provider quietly editing a card that has
 * been taken off the air.
 */
function assertCardIsEditable(card: { status: ShowcaseCardStatus }) {
  if (
    card.status === ShowcaseCardStatus.SUSPENDED ||
    card.status === ShowcaseCardStatus.ARCHIVED
  ) {
    throw showcaseCardLocked();
  }
}
