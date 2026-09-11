import { Inject, Injectable } from '@nestjs/common';
import { ShowcaseCardStatus, ShowcasePlacementStatus, ShowcaseVersionReview } from '@prisma/client';
import { describeArea } from '../../common/provider-service-area-scope';
import { PrismaService } from '../../prisma/prisma.service';
import { ShowcaseEntitlementService } from './showcase-entitlement.service';

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
 * provider: raw placement states, version numbers, an empty "Vitrin yayını"
 * box on a card that had nothing to publish yet.
 *
 * ## Phase two: a right, not a checkout
 *
 * The package-first flow replaced "money in flight" with "a right reserved or
 * on the shelf" as the fact this resolves against. `TERMS_REQUIRED`,
 * `READY_TO_PUBLISH` and `AWAITING_PAYMENT` are gone with the acceptance
 * ledger and the pending-checkout read they were built on: a card either
 * holds a valid right (reserved by it, or on the shelf waiting to be spent)
 * or it needs one, and that is `NEEDS_PACKAGE` / `EXPIRED` with
 * `needsPackage: true` rather than a state of its own.
 *
 * ## The order of the checks is the product
 *
 * It runs from the most operationally binding fact outwards: what an operator
 * did to the card, then what is on the air, then what the review queue is
 * holding, then what the provider has not done yet.
 *
 * ## What is deliberately not returned
 *
 * Placement ids, card version ids, purchase ids, the right's own id, raw enum
 * members. None of them is a thing a provider acts on, and every one of them
 * is a thing that ends up in a support conversation the moment it is on
 * screen. `endAt` travels because a provider genuinely needs to know when
 * their run ends; the reserved right's package name, duration and pause flag
 * travel because they are what the screen tells the provider they are
 * holding.
 */
export type ShowcasePublicationState =
  /** Never submitted. */
  | 'DRAFT'
  /**
   * With an operator right now, and never having gone live yet. A card that
   * is already on the air and has a fresh draft with an operator stays
   * `LIVE`/`EXPIRED` with `hasPendingRevision: true` instead — see that flag.
   */
  | 'IN_REVIEW'
  /** An operator said no, and the provider has the note. */
  | 'REJECTED'
  /** Nothing on the air and no valid right to publish with. */
  | 'NEEDS_PACKAGE'
  /** A run was bought before and has ended; the card needs a fresh right. */
  | 'EXPIRED'
  /**
   * The instant between an approval spending the right and the placement row
   * landing ACTIVE, both inside the same transaction — there is no payment
   * provider any more to wait on, so in practice this is not an observable
   * waiting room, only a state the type has to admit exists.
   */
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
  /** The package behind the current run or the reserved right, in the provider's words. */
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
  /** Whether a run has ever gone up for this card, live or past. */
  hasRunBefore: boolean;
  /** Whether the next action is buying a package. */
  needsPackage: boolean;
  /** The right reserved by this card, when it still holds a valid one. */
  entitlement: {
    packageName: string;
    durationDays: number;
    expiresAt: string;
    pausedForReview: boolean;
  } | null;
};

export type ShowcasePublicationList = {
  cards: ShowcaseCardPublication[];
  availableEntitlements: Array<{
    id: string;
    packageName: string;
    durationDays: number;
    allowedCardKind: 'SERVICE' | 'PROMOTION' | null;
    expiresAt: string;
  }>;
  /**
   * Whether this business has ever published. The panel's lead inbox is
   * navigated to off this — a provider who has never bought a run has no
   * direct leads and never will until they do, and an entry that is always
   * empty teaches people to ignore the sidebar.
   */
  hasPublicationHistory: boolean;
};

@Injectable()
export class ShowcasePublicationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ShowcaseEntitlementService) private readonly entitlements: ShowcaseEntitlementService,
  ) {}

  /**
   * Every card this business owns, resolved.
   *
   * Three queries rather than one per card: the panel lists all of them at
   * once, and a per-card resolution would turn a page of ten cards into
   * dozens of round trips.
   */
  async listForProvider(providerId: string): Promise<ShowcasePublicationList> {
    const now = new Date();

    const [cards, placements, rights] = await Promise.all([
      this.prisma.showcaseCard.findMany({
        where: { providerId },
        orderBy: [{ createdAt: 'desc' }],
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
      this.entitlements.listForProvider(providerId, now),
    ]);

    const cardsOut: ShowcaseCardPublication[] = [];

    for (const card of cards) {
      // `orderBy startAt desc` above makes the first match the current run and
      // any later match its history.
      const runs = placements.filter((placement) => placement.cardId === card.id);
      const live =
        runs.find((placement) => placement.status === ShowcasePlacementStatus.ACTIVE) ??
        runs.find(
          (placement) =>
            placement.status === ShowcasePlacementStatus.PENDING_ACTIVATION ||
            placement.status === ShowcasePlacementStatus.SUSPENDED,
        ) ??
        null;
      const reserved = rights.reservedByCard[card.id] ?? null;
      const validRight = reserved && reserved.valid ? reserved : null;
      const inReview = card.draftVersion?.reviewStatus === ShowcaseVersionReview.PENDING;
      const hasPendingRevision = inReview && card.draftVersionId !== card.liveVersionId && card.liveVersionId !== null;

      // A card that never went live and was discarded is gone from the
      // provider's screen: "sil" is what the button said.
      if (card.status === ShowcaseCardStatus.ARCHIVED && !card.liveVersionId) {
        continue;
      }

      const base = {
        cardId: card.id,
        endAt: live ? live.endAt.toISOString() : null,
        packageName: live?.packageNameSnapshot ?? validRight?.packageName ?? null,
        areaLabels: (live?.shelves ?? []).map((shelf) => describeArea(shelf)),
        leadCount: live?._count.leads ?? 0,
        hasPendingRevision,
        hasRunBefore: runs.length > 0,
        needsPackage: false,
        entitlement: validRight
          ? {
              packageName: validRight.packageName,
              durationDays: validRight.durationDays,
              expiresAt: validRight.expiresAt,
              pausedForReview: validRight.pausedForReview,
            }
          : null,
      };

      const resolve = (): ShowcaseCardPublication => {
        if (card.status === ShowcaseCardStatus.ARCHIVED) {
          return { ...base, state: 'ARCHIVED' };
        }
        if (card.status === ShowcaseCardStatus.SUSPENDED) {
          return { ...base, state: 'SUSPENDED' };
        }
        if (live) {
          if (live.status === ShowcasePlacementStatus.ACTIVE) {
            return { ...base, state: 'LIVE' };
          }
          if (live.status === ShowcasePlacementStatus.PENDING_ACTIVATION) {
            return { ...base, state: 'ACTIVATING' };
          }
          return { ...base, state: 'PAUSED' };
        }
        if (inReview && !card.liveVersionId) {
          return { ...base, state: 'IN_REVIEW' };
        }
        // REJECTED before the right check: a rejected card keeps its reason
        // even when its right has lapsed; the flag says what to do about it.
        if (card.status === ShowcaseCardStatus.REJECTED) {
          return { ...base, state: 'REJECTED', needsPackage: validRight === null };
        }
        if (card.liveVersionId && card.status === ShowcaseCardStatus.APPROVED) {
          // Approved text, nothing on the air: a run that ended, or an
          // approval that predates rights. Either way the next step is a
          // package.
          return { ...base, state: 'EXPIRED', needsPackage: true };
        }
        if (!validRight) {
          return { ...base, state: 'NEEDS_PACKAGE', needsPackage: true };
        }
        return { ...base, state: 'DRAFT' };
      };

      cardsOut.push(resolve());
    }

    return {
      cards: cardsOut,
      availableEntitlements: rights.available,
      hasPublicationHistory: placements.length > 0,
    };
  }

  /** One card's own answer, for the card screen. */
  async getForProvider(providerId: string, cardId: string): Promise<ShowcaseCardPublication | null> {
    const { cards } = await this.listForProvider(providerId);
    return cards.find((card) => card.cardId === cardId) ?? null;
  }
}
