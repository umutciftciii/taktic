import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { AcceptShowcasePriceTermsDto } from './dto/showcase-price-terms.dto';
import { resolveShowcasePriceTerms } from './showcase.constants';
import { showcaseCardNotFound, showcasePriceTermsRequired } from './showcase.errors';

/**
 * Accepting the price-responsibility text, as an act of its own.
 *
 * ## Why this is not part of the card service
 *
 * Phase one records an acceptance too — `ShowcaseCardVersion.priceTerms*`,
 * written when a version is submitted for review — and that record stays
 * exactly as it is. It cannot answer the question this service exists for,
 * because it is welded to a version and a version is frozen the moment it
 * leaves DRAFT. Re-accepting through that column would mean writing to frozen
 * content, or producing a new version and pushing an approved card back through
 * moderation.
 *
 * So this writes to a table of its own, and the separation is the feature: a
 * provider agreeing to new terms changes no card, no version pointer, no review
 * row and no placement. Nothing a customer or an operator looks at moves.
 *
 * ## Append-only
 *
 * There is no update and no delete here, and there is no admin route that
 * writes one either. A record of consent that can be edited afterwards is not a
 * record of consent. Re-accepting the same version is idempotent because
 * `UNIQUE ("cardId", "termsVersion")` makes a second row impossible — the
 * lookup below is the fast path, and the constraint is what holds when two
 * requests race.
 */
@Injectable()
export class ShowcasePriceTermsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * What this card is being asked to agree to, and whether it already has.
   *
   * `accepted` answers the question the buying screen needs — "is there an
   * acceptance for the version in force" — rather than "has this card ever
   * accepted anything". An acceptance of superseded terms reports `false` with
   * a `null` acceptance, because for every purpose this endpoint serves it is
   * not an acceptance at all. The history of what *was* agreed lives on the
   * operator's screen, which is where a question about a past version belongs.
   */
  async getForCard(providerId: string, cardId: string) {
    const terms = resolveShowcasePriceTerms();
    await this.assertOwnedCard(this.prisma, providerId, cardId);

    const acceptance = await findCurrentPriceTermsAcceptance(this.prisma, cardId, terms.version);

    return {
      version: terms.version,
      text: terms.text,
      accepted: acceptance !== null,
      acceptance: acceptance ? presentAcceptance(acceptance) : null,
    };
  }

  /**
   * Records the acceptance, or hands back the one that already stands.
   *
   * Stricter than `ProviderAccessGuard`, identically to the checkout: agreeing
   * to terms is an act of the account that owns the business. A SUPER_ADMIN
   * supporting a provider may read every one of these screens and may suspend a
   * run; they may not consent on somebody else's behalf, because consent given
   * by a third party is not consent.
   */
  async acceptForCard(
    providerId: string,
    cardId: string,
    user: AuthUser,
    dto: AcceptShowcasePriceTermsDto,
  ) {
    if (user.role !== UserRole.PROVIDER) {
      throw new ForbiddenException(
        'Only the provider account can accept the vitrin price-responsibility terms',
      );
    }

    const terms = resolveShowcasePriceTerms();
    await this.assertOwnedCard(this.prisma, providerId, cardId);

    // The version the client sent has to be the one in force. A stale browser
    // would otherwise record an agreement to a sentence nobody on that screen
    // ever read — which is the one thing a consent record must never contain.
    if (dto.priceTermsVersion !== terms.version) {
      throw showcasePriceTermsRequired();
    }

    const existing = await findCurrentPriceTermsAcceptance(this.prisma, cardId, terms.version);
    if (existing) {
      return { acceptance: presentAcceptance(existing) };
    }

    try {
      const created = await this.prisma.showcaseCardPriceTermsAcceptance.create({
        data: {
          providerId,
          cardId,
          termsVersion: terms.version,
          termsTextSnapshot: terms.text,
          acceptedByUserId: user.id,
        },
        select: acceptanceSelect,
      });

      return { acceptance: presentAcceptance(created) };
    } catch (error) {
      // Two requests raced and the index settled it. The winner's row is the
      // answer to both — re-reading is the whole of the reconciliation, because
      // an acceptance carries no state that could differ between them.
      if (isUniqueViolation(error)) {
        const winner = await findCurrentPriceTermsAcceptance(this.prisma, cardId, terms.version);
        if (winner) {
          return { acceptance: presentAcceptance(winner) };
        }
      }

      throw error;
    }
  }

  /**
   * The operator's read-only ledger.
   *
   * Every version ever accepted, not just the current one: the question an
   * operator asks here is historical — "what did this business agree to, and
   * when" — and answering it only for today's terms would make the table's
   * whole reason for existing invisible.
   */
  async listForAdmin(filters: { providerId?: string; cardId?: string; termsVersion?: string }) {
    const acceptances = await this.prisma.showcaseCardPriceTermsAcceptance.findMany({
      where: {
        ...(filters.providerId ? { providerId: filters.providerId } : {}),
        ...(filters.cardId ? { cardId: filters.cardId } : {}),
        ...(filters.termsVersion ? { termsVersion: filters.termsVersion } : {}),
      },
      orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: adminAcceptanceSelect,
    });

    return { acceptances };
  }

  /**
   * A card the caller may not read and a card that does not exist answer alike.
   *
   * The identical rule `loadOwnedCard` and the checkout already apply: a card is
   * an unpublished price list, and a distinguishable "exists but is not yours"
   * turns the id space into a way to learn who is about to advertise what.
   */
  private async assertOwnedCard(
    db: Prisma.TransactionClient,
    providerId: string,
    cardId: string,
  ) {
    const card = await db.showcaseCard.findFirst({
      where: { id: cardId, providerId },
      select: { id: true },
    });

    if (!card) {
      throw showcaseCardNotFound();
    }

    return card;
  }
}

const acceptanceSelect = {
  id: true,
  cardId: true,
  providerId: true,
  termsVersion: true,
  termsTextSnapshot: true,
  acceptedAt: true,
} satisfies Prisma.ShowcaseCardPriceTermsAcceptanceSelect;

const adminAcceptanceSelect = {
  ...acceptanceSelect,
  provider: { select: { id: true, businessName: true, status: true } },
  card: { select: { id: true, kind: true, status: true, categoryId: true } },
  acceptedByUser: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ShowcaseCardPriceTermsAcceptanceSelect;

type StoredAcceptance = Prisma.ShowcaseCardPriceTermsAcceptanceGetPayload<{
  select: typeof acceptanceSelect;
}>;

function presentAcceptance(acceptance: StoredAcceptance) {
  return {
    id: acceptance.id,
    cardId: acceptance.cardId,
    termsVersion: acceptance.termsVersion,
    termsText: acceptance.termsTextSnapshot,
    acceptedAt: acceptance.acceptedAt,
  };
}

/**
 * The acceptance the checkout consults, as one indexed lookup.
 *
 * A free function rather than a method, because the checkout has to run it
 * **inside its own transaction** — the same one that writes the purchase row —
 * and a service holding its own client could not. That is what makes "this
 * purchase exists" and "the buyer had accepted the terms then in force" one
 * fact instead of two a later read has to reconcile.
 *
 * Matching is exact equality on the version string, never "the newest
 * acceptance". A provider who accepted v1 and then v2 has, for a checkout under
 * v2, exactly the row this finds; under a later v3 it finds nothing, which is
 * the refusal.
 */
export function findCurrentPriceTermsAcceptance(
  db: Prisma.TransactionClient,
  cardId: string,
  termsVersion: string,
): Promise<StoredAcceptance | null> {
  return db.showcaseCardPriceTermsAcceptance.findUnique({
    where: { cardId_termsVersion: { cardId, termsVersion } },
    select: acceptanceSelect,
  });
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
