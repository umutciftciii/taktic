import { Inject, Injectable } from '@nestjs/common';
import {
  PackagePurchaseKind,
  PackagePurchaseStatus,
  ShowcaseCardStatus,
  ShowcasePlacementStatus,
  ShowcaseVersionReview,
} from '@prisma/client';
import { describeArea } from '../../common/provider-service-area-scope';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveShowcasePriceTerms } from './showcase.constants';

/**
 * Where each of a business's cards stands, as **one** fact with **one** next
 * action.
 *
 * ## Why this exists at all
 *
 * The provider's panel used to answer this question by assembling it on the
 * screen out of four different reads — the card's `status`, the pair of
 * versions and their `reviewStatus`, the placement list filtered by three
 * enum members, and an eligibility dry run whose refusal code decided which
 * form to render. Each read is correct; together they were a machine's model of
 * the feature rather than a person's, and they leaked straight through to the
 * provider: raw placement states, version numbers, a terms-acceptance ledger,
 * and an empty "Vitrin yayını" box on a card that had nothing to publish yet.
 *
 * Worse, the four could disagree. The card said APPROVED, the panel said
 * "yayına hazır", and the eligibility check said the price-responsibility text
 * needed re-accepting — because a card's *submission* records its acceptance on
 * the version while the *sale* reads a separate ledger, and a freshly approved
 * card has the first and not the second. The provider saw a notice about terms
 * being "updated" instead of the packages they were waiting for.
 *
 * So the resolution happens here, once, on the server, and the screen renders
 * what it is told. There is exactly one state per card and exactly one thing to
 * do about it.
 *
 * ## The order of the checks is the product
 *
 * It runs from the most operationally binding fact outwards: what an operator
 * did to the card, then what is on the air, then what money is in flight, then
 * what the review queue is holding, then what the provider has not done yet.
 * Reversing any two of them would tell somebody to buy a package for a card an
 * operator has just pulled.
 *
 * ## What is deliberately not returned
 *
 * Placement ids, card version ids, purchase ids, raw enum members, the terms
 * ledger row. None of them is a thing a provider acts on, and every one of them
 * is a thing that ends up in a support conversation the moment it is on screen.
 * `endAt` travels because a provider genuinely needs to know when their run
 * ends; `checkoutUrl` travels because it is the action itself.
 */
export type ShowcasePublicationState =
  /** Never submitted. */
  | 'DRAFT'
  /** With an operator right now. */
  | 'IN_REVIEW'
  /** An operator said no, and the provider has the note. */
  | 'REJECTED'
  /** Approved, but the sale terms in force have not been accepted for it. */
  | 'TERMS_REQUIRED'
  /** Approved and sellable: pick a package. */
  | 'READY_TO_PUBLISH'
  /** A run was bought before and has ended; the card can go up again. */
  | 'EXPIRED'
  /** A checkout is open and unpaid. */
  | 'AWAITING_PAYMENT'
  /** Paid, waiting for the payment provider's confirmation to land. */
  | 'ACTIVATING'
  /** On the air. */
  | 'LIVE'
  /** On the air but temporarily off it — an operator, or a condition that lifts by itself. */
  | 'PAUSED'
  /** The provider retired it. */
  | 'ARCHIVED'
  /** An operator pulled it. */
  | 'SUSPENDED';

export type ShowcaseCardPublication = {
  cardId: string;
  state: ShowcasePublicationState;
  /** When the current run ends. Only ever set while something is on the air. */
  endAt: string | null;
  /**
   * The hosted checkout to return to, when there is one and it is still usable.
   *
   * Null under the mock payment provider, which has no hosted page at all — the
   * purchase's own screen carries the in-app form instead. That is why
   * `purchaseId` travels beside it rather than this being the only way back to
   * an unpaid purchase.
   */
  checkoutUrl: string | null;
  /** The unpaid purchase, so the panel can send the provider back to it. */
  purchaseId: string | null;
  /** The package behind the current run or the open checkout, in the provider's words. */
  packageName: string | null;
  /** Where the run is publishing, already worded. Empty when nothing is on the air. */
  areaLabels: string[];
  /** Leads this run has produced. */
  leadCount: number;
  /**
   * A card that is live *and* has a replacement with an operator. The pair is
   * the one situation a single state genuinely cannot express, so it travels as
   * a flag rather than as a twelfth state nobody could act on.
   */
  hasPendingRevision: boolean;
};

@Injectable()
export class ShowcasePublicationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Every card this business owns, resolved.
   *
   * Four queries rather than four per card: the panel lists all of them at
   * once, and a per-card resolution would turn a page of ten cards into forty
   * round trips.
   */
  async listForProvider(providerId: string): Promise<{
    cards: ShowcaseCardPublication[];
    /**
     * Whether this business has ever published. The panel's lead inbox is
     * navigated to off this — a provider who has never bought a run has no
     * direct leads and never will until they do, and an entry that is always
     * empty teaches people to ignore the sidebar.
     */
    hasPublicationHistory: boolean;
  }> {
    const now = new Date();
    const terms = resolveShowcasePriceTerms();

    const [cards, placements, openCheckouts, acceptances] = await Promise.all([
      this.prisma.showcaseCard.findMany({
        where: { providerId },
        select: {
          id: true,
          status: true,
          liveVersionId: true,
          draftVersionId: true,
          draftVersion: { select: { id: true, reviewStatus: true } },
        },
      }),
      this.prisma.showcasePlacement.findMany({
        where: { providerId },
        orderBy: { startAt: 'desc' },
        select: {
          cardId: true,
          status: true,
          endAt: true,
          packageNameSnapshot: true,
          shelves: {
            where: { active: true },
            select: { city: true, district: true, neighborhood: true },
          },
          _count: { select: { leads: true } },
        },
      }),
      /*
       * Money in flight.
       *
       * Deliberately not narrowed to purchases that carry a hosted checkout
       * URL: under the mock payment provider there is never one, and a filter
       * on it made every mock purchase invisible — the card fell back to
       * "yayına hazır" while an unpaid purchase for it existed, which is the
       * kind of quiet disagreement this whole service exists to end.
       */
      this.prisma.packagePurchase.findMany({
        where: {
          providerId,
          kind: PackagePurchaseKind.SHOWCASE_PACKAGE,
          status: PackagePurchaseStatus.PENDING,
          showcaseCardId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          showcaseCardId: true,
          providerCheckoutUrl: true,
          providerCheckoutExpiresAt: true,
          packageNameSnapshot: true,
        },
      }),
      this.prisma.showcaseCardPriceTermsAcceptance.findMany({
        where: { providerId, termsVersion: terms.version },
        select: { cardId: true },
      }),
    ]);

    const accepted = new Set(acceptances.map((row) => row.cardId));
    const checkoutByCard = new Map(
      openCheckouts
        .filter((purchase) => purchase.showcaseCardId !== null)
        .map((purchase) => [purchase.showcaseCardId!, purchase] as const),
    );

    return {
      cards: cards.map((card) => {
        // `orderBy startAt desc` above makes the first match the current run and
        // any later match its history, which is what "expired before" needs.
        const runs = placements.filter((placement) => placement.cardId === card.id);
        const live =
          runs.find((placement) => placement.status === ShowcasePlacementStatus.ACTIVE) ??
          runs.find(
            (placement) =>
              placement.status === ShowcasePlacementStatus.PENDING_ACTIVATION ||
              placement.status === ShowcasePlacementStatus.SUSPENDED,
          ) ??
          null;
        const checkout = checkoutByCard.get(card.id) ?? null;
        const hasPendingRevision =
          card.draftVersion?.reviewStatus === ShowcaseVersionReview.PENDING &&
          card.draftVersionId !== card.liveVersionId;

        const base = {
          cardId: card.id,
          endAt: live ? live.endAt.toISOString() : null,
          checkoutUrl: null as string | null,
          purchaseId: null as string | null,
          packageName: live?.packageNameSnapshot ?? null,
          areaLabels: (live?.shelves ?? []).map((shelf) => describeArea(shelf)),
          leadCount: live?._count.leads ?? 0,
          hasPendingRevision,
        };

        if (card.status === ShowcaseCardStatus.ARCHIVED) {
          return { ...base, state: 'ARCHIVED' as const };
        }
        if (card.status === ShowcaseCardStatus.SUSPENDED) {
          return { ...base, state: 'SUSPENDED' as const };
        }

        if (live) {
          if (live.status === ShowcasePlacementStatus.ACTIVE) {
            return { ...base, state: 'LIVE' as const };
          }
          if (live.status === ShowcasePlacementStatus.PENDING_ACTIVATION) {
            return { ...base, state: 'ACTIVATING' as const };
          }
          return { ...base, state: 'PAUSED' as const };
        }

        if (checkout) {
          // An expired hosted session is not an action: sending somebody back
          // to a dead link is worse than sending them to the purchase, where
          // the checkout is opened again.
          const usable =
            checkout.providerCheckoutUrl !== null &&
            (checkout.providerCheckoutExpiresAt === null ||
              checkout.providerCheckoutExpiresAt > now);

          return {
            ...base,
            state: 'AWAITING_PAYMENT' as const,
            checkoutUrl: usable ? checkout.providerCheckoutUrl : null,
            purchaseId: checkout.id,
            packageName: checkout.packageNameSnapshot,
          };
        }

        if (card.draftVersion?.reviewStatus === ShowcaseVersionReview.PENDING) {
          return { ...base, state: 'IN_REVIEW' as const };
        }

        if (card.status === ShowcaseCardStatus.APPROVED && card.liveVersionId) {
          if (!accepted.has(card.id)) {
            return { ...base, state: 'TERMS_REQUIRED' as const };
          }
          // A card that has published before reads "yeniden yayınla" rather than
          // "vitrine çıkar": the provider is renewing something they already
          // know, not doing it for the first time.
          return { ...base, state: runs.length > 0 ? ('EXPIRED' as const) : ('READY_TO_PUBLISH' as const) };
        }

        if (card.status === ShowcaseCardStatus.REJECTED) {
          return { ...base, state: 'REJECTED' as const };
        }

        return { ...base, state: 'DRAFT' as const };
      }),
      hasPublicationHistory: placements.length > 0,
    };
  }

  /** One card's own answer, for the card screen. */
  async getForProvider(providerId: string, cardId: string): Promise<ShowcaseCardPublication | null> {
    const { cards } = await this.listForProvider(providerId);
    return cards.find((card) => card.cardId === cardId) ?? null;
  }
}
