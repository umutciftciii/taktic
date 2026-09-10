import { Inject, Injectable } from '@nestjs/common';
import {
  Prisma,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  ShowcaseCardKind,
  ShowcaseCardStatus,
  ShowcasePlacementSuspendReason,
  ShowcaseVersionChangeTrigger,
  ShowcaseVersionReview,
} from '@prisma/client';
import { areaCovers, describeArea } from '../../common/provider-service-area-scope';
import { runSerializable } from '../../common/serializable-transaction';
import {
  showcaseAreaKey,
  toShowcaseAreaRow,
  type ShowcaseAreaLevels,
} from '../../common/showcase-area-key';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveArea } from '../locations/turkey-locations';
import {
  CreateShowcaseCardDto,
  ShowcaseCardContentDto,
  UpdateShowcaseCardDto,
} from './dto/create-showcase-card.dto';
import { SubmitShowcaseCardDto } from './dto/submit-showcase-card.dto';
import {
  canReceiveRequests,
  isActiveFor,
  isLiveProviderBinding,
} from '../categories/category-taxonomy';
import {
  showcaseAreaDuplicate,
  showcaseCardAlreadyArchived,
  showcaseAreaNotCovered,
  showcaseAreaOverlap,
  showcaseAreaUnknown,
  showcaseCardLocked,
  showcaseCardNotFound,
  showcaseCategoryNotOffered,
  showcaseContentInvalid,
  showcaseNothingToSubmit,
  showcaseNothingToWithdraw,
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
import { ShowcasePlacementService } from './showcase-placement.service';

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
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ShowcasePlacementService)
    private readonly placements: ShowcasePlacementService,
  ) {}

  /** The terms the submit endpoint requires acceptance of, for the form to show. */
  getPriceTerms() {
    return { version: SHOWCASE_PRICE_TERMS_VERSION, text: SHOWCASE_PRICE_TERMS_TEXT };
  }

  /**
   * The categories this provider may open a card under, per card kind.
   *
   * Derived here rather than assembled by the form, and that is the point: the
   * eligible set is a fact about the provider's bindings *and* the category
   * tree, and a client that guessed at it would be a client deciding what a
   * business is allowed to advertise. The form renders this list; the write
   * endpoints re-derive the same rule and refuse anything outside it, so the
   * list is a convenience and never the authority.
   *
   * Two lists rather than one flagged list, because the two card kinds accept
   * genuinely different shapes and a form that had to filter by a flag would be
   * a second place where that rule lives:
   *
   * - `service` — the provider's own leaves that can take a request.
   * - `promotion` — those leaves, plus every ACTIVE group above them.
   *
   * A group reached through three different leaves appears once. Ordering is the
   * catalogue's own, applied down the tree: each entry sorts by its ancestors'
   * `(sortOrder, name)` and then its own, so a group is immediately followed by
   * what sits under it and `depth` is enough for the form to indent by.
   */
  async listEligibleCategories(providerId: string) {
    const bindings = await this.prisma.providerServiceCategory.findMany({
      where: { providerId },
      select: { category: { select: eligibleCategorySelect } },
    });

    const leaves = bindings
      .map((binding) => binding.category)
      .filter(
        (category) => isLiveProviderBinding(category) && canReceiveRequests(category, false),
      );

    // Every ancestor of every offerable leaf, gathered level by level so the
    // number of queries is the tree's depth rather than the number of leaves.
    const known = new Map<string, EligibleCategoryRow>();
    for (const leaf of leaves) {
      known.set(leaf.id, leaf);
    }

    let frontier = [...new Set(leaves.map((leaf) => leaf.parentId).filter(isPresent))];
    for (let depth = 0; frontier.length > 0 && depth < SHOWCASE_MAX_CATEGORY_DEPTH; depth += 1) {
      const parents = await this.prisma.serviceCategory.findMany({
        where: { id: { in: frontier } },
        select: eligibleCategorySelect,
      });

      const next: string[] = [];
      for (const parent of parents) {
        if (known.has(parent.id)) continue;
        known.set(parent.id, parent);
        if (parent.parentId) next.push(parent.parentId);
      }

      frontier = [...new Set(next)];
    }

    // An ancestor is offerable for a promotion card when it is an ACTIVE group.
    // Its own ancestors are judged the same way and independently: the rule is
    // about the shelf the card points at, which is exactly what
    // `assertCategoryIsOffered` asks, so the list and the guard cannot drift.
    const groups = [...known.values()].filter(
      (category) =>
        category.kind === ServiceCategoryKind.GROUP &&
        isActiveFor(category.status) &&
        !leaves.some((leaf) => leaf.id === category.id),
    );

    const service = leaves.map((leaf) => toEligibleCategory(leaf, known));
    const promotion = [...leaves, ...groups].map((category) =>
      toEligibleCategory(category, known),
    );

    return {
      service: service.sort(compareEligibleCategories),
      promotion: promotion.sort(compareEligibleCategories),
    };
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
    await this.assertCategoryIsOffered(providerId, dto.categoryId, dto.kind);
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

    // Re-checked on every edit, not only at creation. A provider may have
    // dropped the service from their profile since the card was opened, and a
    // card is a claim about what the business does now — including a narrowing,
    // which is still a change to what is live.
    await this.assertCategoryIsOffered(providerId, card.categoryId, card.kind);

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

    // The category is re-checked here as well as at write time, and this is the
    // check that matters most: a draft written weeks ago may name a service the
    // business has since removed from its profile, and an operator must not be
    // asked to approve a claim nobody backs any more.
    await this.assertCategoryIsOffered(providerId, card.categoryId, card.kind);

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

  /**
   * Takes a submission back out of the review queue, before anybody has ruled
   * on it.
   *
   * ## Why this exists
   *
   * A submitted version is frozen — that is what makes `ShowcaseCardReview`
   * mean something. But frozen and *stuck* are different things: without a way
   * back, a provider who spots their own typo has to wait for an operator to
   * refuse it, which wastes the operator's time and teaches the provider to
   * submit carelessly. Withdrawing is the author retrieving their own draft, not
   * a decision about it.
   *
   * ## What it is not
   *
   * It writes no `ShowcaseCardReview`. Nobody judged anything, and a review row
   * with a fabricated reviewer would make "who decided this" unanswerable for
   * every row in that table. The record is a
   * `ShowcaseSubmissionWithdrawal` — the provider, the version, the submission
   * that was pulled, and when.
   *
   * ## The race with an operator
   *
   * Approve, reject and this all move a version *out of* PENDING under a
   * conditional update, inside a Serializable transaction. Whichever commits
   * first wins; the other either finds no row matching `reviewStatus = PENDING`
   * and refuses, or is retried by `runSerializable` and then finds none. There
   * is no ordering in which both land, and no ordering in which one silently
   * overwrites the other.
   *
   * ## What the provider gets back
   *
   * The same version, in DRAFT, with its price-terms acceptance cleared. That
   * clearing is deliberate rather than tidy-mindedness: the acceptance is an
   * acceptance *of a submission*, and the text may have changed by the time they
   * submit again. Re-submitting means accepting the current terms again, and a
   * DRAFT carrying an acceptance nobody has re-given would be a record of a
   * consent that no longer stands. A database CHECK insists on the same thing.
   */
  async withdrawSubmission(providerId: string, cardId: string) {
    const card = await this.loadOwnedCard(providerId, cardId);
    assertCardIsEditable(card);

    if (!card.draftVersion || card.draftVersion.reviewStatus !== ShowcaseVersionReview.PENDING) {
      throw showcaseNothingToWithdraw();
    }

    const versionId = card.draftVersion.id;

    await runSerializable(
      this.prisma,
      async (tx) => {
        // Read inside the transaction: `submittedAt` is about to be cleared, and
        // the audit row's copy of it has to be the value this transaction is
        // actually replacing rather than one read before a competing write.
        const pending = await tx.showcaseCardVersion.findFirst({
          where: { id: versionId, reviewStatus: ShowcaseVersionReview.PENDING },
          select: { id: true, submittedAt: true },
        });

        if (!pending?.submittedAt) {
          throw showcaseNothingToWithdraw();
        }

        const moved = await tx.showcaseCardVersion.updateMany({
          where: { id: versionId, reviewStatus: ShowcaseVersionReview.PENDING },
          data: {
            reviewStatus: ShowcaseVersionReview.DRAFT,
            submittedAt: null,
            priceTermsVersion: null,
            priceTermsAcceptedAt: null,
          },
        });

        if (moved.count !== 1) {
          throw showcaseNothingToWithdraw();
        }

        // The card goes back to what it was before the submission: still
        // APPROVED if it has something live — the live version is untouched and
        // this was only ever about its replacement — and DRAFT if it does not.
        await tx.showcaseCard.update({
          where: { id: card.id },
          data: {
            status: card.liveVersionId
              ? ShowcaseCardStatus.APPROVED
              : ShowcaseCardStatus.DRAFT,
          },
        });

        await tx.showcaseSubmissionWithdrawal.create({
          data: {
            cardVersionId: versionId,
            cardId: card.id,
            providerId,
            submittedAtSnapshot: pending.submittedAt,
          },
        });
      },
      { label: 'showcase.withdrawSubmission' },
    );

    return this.getCard(providerId, cardId);
  }

  /**
   * The provider retires a card.
   *
   * Phase one reserved `ARCHIVED` and left it with no writer. It gets one here
   * for the same reason `SUSPENDED` does: cards are now on a public page, and a
   * business that cannot take its own card down is a business advertising work
   * it has stopped doing.
   *
   * ## The clock keeps running, and that is the whole point
   *
   * Archiving takes every run of this card off the air, and the paid days go on
   * being spent. If they did not, a provider could archive a card in February,
   * bring it back in June and have their thirty days start then — turning a
   * dated run into an undated voucher, which is not what was sold. The cost is
   * real and is accepted: two weeks archived is two weeks lost.
   *
   * Bringing the card back resumes what is left, automatically, because
   * `CARD_ARCHIVED` is an observable condition rather than somebody's
   * judgement.
   *
   * There is still no delete. The versions are the record of what was claimed
   * and what was approved.
   */
  async archiveCard(providerId: string, cardId: string) {
    const card = await this.loadOwnedCard(providerId, cardId);

    if (card.status === ShowcaseCardStatus.ARCHIVED) {
      throw showcaseCardAlreadyArchived();
    }

    // An operator's hold outranks the provider's own retirement: a card pulled
    // by moderation is not theirs to file away.
    if (card.status === ShowcaseCardStatus.SUSPENDED) {
      throw showcaseCardLocked();
    }

    await runSerializable(
      this.prisma,
      async (tx) => {
        await tx.showcaseCard.update({
          where: { id: cardId },
          data: { status: ShowcaseCardStatus.ARCHIVED, archivedAt: new Date() },
        });

        await this.placements.suspendLiveFor(
          tx,
          { cardId },
          { reason: ShowcasePlacementSuspendReason.CARD_ARCHIVED, actorUserId: null },
        );
      },
      { label: 'showcase.archiveCard' },
    );

    return this.getCard(providerId, cardId);
  }

  /**
   * The provider brings a retired card back, and whatever is left of its run
   * comes back with it.
   *
   * Only from ARCHIVED, and only their own: a card an operator suspended stays
   * suspended until that operator lifts it.
   */
  async unarchiveCard(providerId: string, cardId: string) {
    const card = await this.loadOwnedCard(providerId, cardId);

    if (card.status !== ShowcaseCardStatus.ARCHIVED) {
      throw showcaseCardLocked();
    }

    await runSerializable(
      this.prisma,
      async (tx) => {
        await tx.showcaseCard.update({
          where: { id: cardId },
          data: {
            status: card.liveVersionId
              ? ShowcaseCardStatus.APPROVED
              : ShowcaseCardStatus.DRAFT,
            archivedAt: null,
          },
        });

        // Only suspensions this action caused. A run also held down by a closed
        // category stays down, and correctly so.
        await this.placements.resumeSuspendedFor(
          tx,
          { cardId },
          ShowcasePlacementSuspendReason.CARD_ARCHIVED,
        );
      },
      { label: 'showcase.unarchiveCard' },
    );

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

      /*
       * A paid run follows its card here too, in the same transaction.
       *
       * The provider narrowed their own claim and the system published it
       * without an operator, so what is live has genuinely changed and the home
       * page has to say the same thing the card's own page does. The shelves
       * are rebuilt from the new version, so the run stops appearing in the
       * areas that were dropped.
       *
       * `endAt` is untouched, deliberately. Narrowing is the provider's own
       * choice; giving time back for it would let a run be shrunk to nothing on
       * Monday and restored on Friday with the clock stopped in between.
       */
      await this.placements.repinToVersion(
        tx,
        card.id,
        version.id,
        ShowcaseVersionChangeTrigger.AREA_NARROWING,
      );
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

    assertAreasDoNotSwallowEachOther(resolved);

    await this.assertAreasAreCovered(providerId, resolved);

    const price = dto.listedServicePriceAmount ?? null;
    if (kind === ShowcaseCardKind.SERVICE && price === null) {
      throw showcaseContentInvalid('Hizmet vitrini kartı için sabit hizmet bedeli zorunludur.');
    }
    if (kind === ShowcaseCardKind.PROMOTION && price !== null) {
      throw showcaseContentInvalid(
        'Genel tanıtım kartı sabit hizmet bedeli taşıyamaz; müşteri hizmeti talep sırasında seçer.',
      );
    }

    const urgent = dto.responseSlaUrgentHours ?? SHOWCASE_SLA_URGENT_DEFAULT_HOURS;
    const normal = dto.responseSlaNormalHours ?? SHOWCASE_SLA_NORMAL_DEFAULT_HOURS;
    if (urgent > normal) {
      throw showcaseContentInvalid(
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
   * The category a card may be listed under — and whether this business
   * actually offers it.
   *
   * ## The shape rules
   *
   * A SERVICE card names one service, so it needs a LEAF: the same node a
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
   *
   * ## The binding rule
   *
   * **A card may not advertise a service the business does not offer.** Which
   * services it offers is `ProviderServiceCategory`, narrowed by
   * `isLiveProviderBinding` — the same rule that decides which bindings the
   * provider's own panel prints and which ones request matching reads. A DRAFT
   * binding is release preparation on the operator's side and buys nothing here.
   *
   * For a LEAF the test is direct membership. For a GROUP — only ever a
   * PROMOTION card — it is "at least one live LEAF binding sits under this
   * node": a general card on a shelf the business has nothing on is an
   * advertisement for services it does not perform.
   *
   * ## Why every refusal answers identically
   *
   * There is one exception body for all of it. A category that does not exist,
   * a DRAFT, a router, an unrelated group and a service they simply have not
   * signed up for are the same 400 with the same code and the same sentence.
   * Telling them apart would answer two questions this endpoint must not: does
   * this id name a real category, and what is in the unreleased catalogue.
   */
  private async assertCategoryIsOffered(
    providerId: string,
    categoryId: string,
    kind: ShowcaseCardKind,
  ) {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, kind: true, status: true },
    });

    if (!category) {
      throw showcaseCategoryNotOffered();
    }

    const offerableLeafIds = await this.offerableLeafIds(providerId);

    if (category.kind === ServiceCategoryKind.LEAF) {
      // Membership in this set is both facts at once: the provider is bound to
      // it, and it is a leaf that can take requests. Checking the category's own
      // status again here would be a second copy of a rule that is already the
      // reason it is in the set.
      if (!offerableLeafIds.has(categoryId)) {
        throw showcaseCategoryNotOffered();
      }
      return;
    }

    // A GROUP, and only for a PROMOTION card: a service card names one service.
    // A ROUTER is neither and falls through to the refusal below.
    if (category.kind !== ServiceCategoryKind.GROUP || kind !== ShowcaseCardKind.PROMOTION) {
      throw showcaseCategoryNotOffered();
    }

    // The shelf itself has to be open. A DRAFT group is unreleased catalogue and
    // an INACTIVE one is a branch the platform has closed; a general card
    // pointing at either would point at somewhere the customer surface will not
    // render.
    if (!isActiveFor(category.status)) {
      throw showcaseCategoryNotOffered();
    }

    // Only LEAF bindings count as something the business performs. Being bound
    // to the group itself is being bound to a shelf, which nothing else in this
    // product treats as supply.
    if (
      offerableLeafIds.size === 0 ||
      !(await this.someCategoryIsUnder(categoryId, [...offerableLeafIds]))
    ) {
      throw showcaseCategoryNotOffered();
    }
  }

  /**
   * The provider's own service leaves that can actually take a request.
   *
   * Two filters, and the second is what this round added. `isLiveProviderBinding`
   * says the binding is supply rather than an operator's release preparation;
   * `canReceiveRequests` says the category is one a request may land on at all.
   * A vitrin card is a surface that will take leads, so pointing it at a leaf
   * the platform has closed would be advertising a service nobody can ask for.
   *
   * `isAdmin` is `false` even when a SUPER_ADMIN is acting on a provider's
   * behalf. The flag exists so an operator can walk a DRAFT category end to end
   * before release; a card is not a walk-through, it is a claim the business
   * makes in public, and it must be judged by what a customer could reach.
   */
  private async offerableLeafIds(providerId: string): Promise<Set<string>> {
    const bindings = await this.prisma.providerServiceCategory.findMany({
      where: { providerId },
      select: {
        categoryId: true,
        category: { select: { kind: true, status: true } },
      },
    });

    return new Set(
      bindings
        .filter(
          (binding) =>
            isLiveProviderBinding(binding.category) &&
            canReceiveRequests(binding.category, false),
        )
        .map((binding) => binding.categoryId),
    );
  }

  /**
   * Whether any of `categoryIds` sits somewhere under `ancestorId`.
   *
   * Walked upwards, one level of the whole frontier per query, rather than by
   * expanding the ancestor downwards. A provider has a handful of bindings and
   * the tree is a few levels deep, so this is three or four queries whatever the
   * catalogue's size — where expanding a top-level group means pulling every
   * category beneath it to answer a yes/no question.
   *
   * The depth bound is the same guard `assertNotDescendant` uses: a tree that
   * has somehow become a ring stops the walk instead of hanging it.
   */
  private async someCategoryIsUnder(ancestorId: string, categoryIds: string[]): Promise<boolean> {
    let frontier = categoryIds.filter((id) => id !== ancestorId);
    const seen = new Set(frontier);

    for (let depth = 0; frontier.length > 0 && depth < SHOWCASE_MAX_CATEGORY_DEPTH; depth += 1) {
      const parents = await this.prisma.serviceCategory.findMany({
        where: { id: { in: frontier } },
        select: { parentId: true },
      });

      const next: string[] = [];
      for (const { parentId } of parents) {
        if (!parentId) continue;
        if (parentId === ancestorId) return true;
        if (seen.has(parentId)) continue;
        seen.add(parentId);
        next.push(parentId);
      }

      frontier = next;
    }

    return false;
  }
}

/**
 * How far up the category tree the binding check will walk.
 *
 * A bound rather than a fact about the taxonomy: the walk terminates on its own
 * for any tree, and this is what stops it if the tree is ever not one.
 */
const SHOWCASE_MAX_CATEGORY_DEPTH = 12;

/** The columns an eligibility decision and its ordering read. */
const eligibleCategorySelect = {
  id: true,
  name: true,
  slug: true,
  kind: true,
  status: true,
  parentId: true,
  sortOrder: true,
} satisfies Prisma.ServiceCategorySelect;

type EligibleCategoryRow = Prisma.ServiceCategoryGetPayload<{
  select: typeof eligibleCategorySelect;
}>;

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * One eligible category, with the ancestry the form needs to render it.
 *
 * `path` is the names from the root down, so a group and the leaves under it
 * read as a tree rather than as a flat list of words. `depth` is the same fact
 * as a number, because indenting by `path.length` in three places is three
 * places that can disagree.
 *
 * `sortKey` is what the ordering below compares: each ancestor's `sortOrder`
 * padded to a fixed width and then its name, joined down the chain. Padding
 * matters — without it "10" sorts before "9".
 */
function toEligibleCategory(
  category: EligibleCategoryRow,
  known: ReadonlyMap<string, EligibleCategoryRow>,
) {
  const chain: EligibleCategoryRow[] = [];
  let cursor: EligibleCategoryRow | undefined = category;

  for (let depth = 0; cursor && depth < SHOWCASE_MAX_CATEGORY_DEPTH; depth += 1) {
    chain.unshift(cursor);
    cursor = cursor.parentId ? known.get(cursor.parentId) : undefined;
  }

  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    kind: category.kind,
    depth: chain.length - 1,
    path: chain.map((node) => node.name),
    sortKey: chain
      .map((node) => `${String(node.sortOrder).padStart(6, '0')}|${node.name}`)
      .join('/'),
  };
}

type EligibleCategory = ReturnType<typeof toEligibleCategory>;

/** The catalogue's own order — `(sortOrder, name)` — applied down the tree. */
function compareEligibleCategories(left: EligibleCategory, right: EligibleCategory): number {
  return left.sortKey.localeCompare(right.sortKey, 'tr-TR');
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
    throw showcaseContentInvalid('Kapsam listeleri boş bırakılamaz.');
  }

  return cleaned;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * No area on a version may already reach everywhere another one does.
 *
 * "İstanbul geneli" beside "İstanbul/Kadıköy" is not a wider card: it is the
 * same card written twice, and the narrower row buys nothing the wider one has
 * not already claimed. The `(cardVersionId, areaKey)` unique index catches the
 * exact repeat; this catches the containment above it, which that index cannot
 * see because the two rows have genuinely different keys.
 *
 * `areaCovers` is the same containment test the provider's own profile form
 * applies to its own list, so a card is judged by the rule the business already
 * knows. It is reflexive — an area covers itself — but an exact repeat has
 * already been refused by key, so any pair reaching here is strict containment.
 *
 * This says nothing about `ProviderServiceArea`. A provider may hold "İstanbul
 * geneli" and "İstanbul/Kadıköy" together — rows that predate the rule refusing
 * new ones, and redundant rather than contradictory — and coverage still reads
 * as the wider of the two. That legacy pair is not a card, and nothing here
 * makes it one.
 */
function assertAreasDoNotSwallowEachOther(areas: readonly ShowcaseAreaLevels[]) {
  for (let outer = 0; outer < areas.length; outer += 1) {
    for (let inner = outer + 1; inner < areas.length; inner += 1) {
      const first = areas[outer];
      const second = areas[inner];
      if (!first || !second) continue;

      if (areaCovers(first, second)) {
        throw showcaseAreaOverlap(describeArea(first), describeArea(second));
      }

      if (areaCovers(second, first)) {
        throw showcaseAreaOverlap(describeArea(second), describeArea(first));
      }
    }
  }
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
