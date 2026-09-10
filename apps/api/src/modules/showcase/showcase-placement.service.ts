import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  ProviderServiceAreaScope,
  ShowcaseCardKind,
  ShowcaseCardStatus,
  ShowcasePlacementStatus,
  ShowcasePlacementSuspendReason,
  ShowcaseVersionChangeTrigger,
  ShowcaseVersionReview,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { showcasePlacementEndAt } from './showcase.constants';
import {
  suspensionExtendsClock,
  suspensionLiftsAutomatically,
} from './showcase-placement-suspension';

/**
 * The life of a paid vitrin run: born from a settled payment, published into a
 * shelf index, taken off the air and put back, and finally expired.
 *
 * ## The four rules this service holds
 *
 * 1. **A placement is only ever born from money.** There is no method here that
 *    creates one without a `PackagePurchase`, and `purchaseId` is unique, so one
 *    settled payment produces exactly one run. Nothing extends a run either:
 *    time is sold, not granted, and the single writer that moves `endAt` forward
 *    is {@link resume} paying back a clock-stopping suspension.
 *
 * 2. **What was sold is frozen; what is shown is not.** The price, the currency,
 *    the duration and the package name are snapshotted at settlement and never
 *    read back from the catalogue. The *content* is the exact opposite: the
 *    placement points at a version and renders whatever that version says, so a
 *    card's own page and the home page cannot disagree. When the live version
 *    changes, the placement is re-pinned in the same transaction — see
 *    {@link repin}.
 *
 * 3. **No reader trusts `status` alone.** Every publish path also asks
 *    `startAt <= now < endAt`. The expiry sweeper writes EXPIRED as an
 *    optimisation for queries and screens; a sweeper that has been switched off
 *    for a week cannot buy anybody an extra day of visibility, because the feed
 *    checks the window itself. This is the same discipline `isEntitlementUsable`
 *    applies to periods.
 *
 * 4. **The clock stops only for our own obstacles.** See
 *    `showcase-placement-suspension.ts` for the full reasoning; the mechanical
 *    consequence lives in {@link resume}, and a database CHECK makes the
 *    forbidden case unrepresentable rather than merely refused.
 *
 * ## Why every method takes a transaction client
 *
 * Suspensions are triggered by things that happen elsewhere — a category
 * closing, a card being archived, a provider being suspended — and each has to
 * commit with the change that caused it. A placement that is on the air because
 * the second half of somebody else's transaction failed is exactly the state
 * this shape makes impossible.
 */
@Injectable()
export class ShowcasePlacementService {
  private readonly logger = new Logger('ShowcasePlacement');

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────────────────────────────────────
  // Birth
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Turns a settled vitrin purchase into a live run, in the caller's
   * transaction.
   *
   * Called from exactly two places, both of them settlement paths: the Lemon
   * Squeezy webhook and the mock payment form. Both already run Serializable,
   * and both call this *before* they mark the purchase PAID, so a purchase can
   * never be PAID without its placement beside it.
   *
   * The run starts at the moment the payment settled rather than at midnight or
   * at the next whole hour. A provider who pays at 14:30 gets their thirty days
   * from 14:30; rounding either way would be the platform quietly deciding to
   * give away or keep back a few hours of something somebody bought.
   *
   * ## Idempotency
   *
   * `ShowcasePlacement.purchaseId` is unique. A redelivered webhook that
   * somehow got past the PROCESSED short-circuit fails on that index and the
   * whole settlement transaction rolls back — which is the correct outcome,
   * because the first delivery already committed everything.
   *
   * ## Why PENDING_ACTIVATION exists at all
   *
   * The row is created in that state and moved to ACTIVE by the same
   * transaction. It is not an observable waiting room; it is in the "live" set
   * of `ShowcasePlacement_one_live_per_card` so that two concurrent settlements
   * for one card cannot both slip through the instant between the insert and the
   * update.
   */
  async createForPurchase(
    tx: Prisma.TransactionClient,
    purchase: SettledShowcasePurchase,
    paidAt: Date,
  ): Promise<{ placementId: string }> {
    const card = await tx.showcaseCard.findUnique({
      where: { id: purchase.showcaseCardId },
      select: {
        id: true,
        providerId: true,
        kind: true,
        categoryId: true,
        status: true,
        liveVersionId: true,
      },
    });

    if (!card || card.providerId !== purchase.providerId) {
      // Unreachable through the checkout, which binds the card to the buyer
      // before the purchase row exists. Stated rather than assumed, because the
      // alternative is a placement published under somebody else's name.
      throw new Error(
        `showcase purchase ${purchase.id} names a card that does not belong to its provider`,
      );
    }

    const pkg = await tx.showcasePackage.findUniqueOrThrow({
      where: { id: purchase.showcasePackageId },
      select: { id: true, name: true, maxAreas: true },
    });

    /*
     * The price-responsibility terms this run is sold under.
     *
     * Read from the acceptance the *checkout* recorded, never from
     * `SHOWCASE_PRICE_TERMS_VERSION` as it stands now. A provider who opened a
     * checkout under v1 and paid an hour after the platform moved to v2 bought
     * the run they were shown — the version they agreed to is a fact about the
     * sale, and settlement is not the place to substitute a newer one.
     *
     * `findUniqueOrThrow` rather than a fallback: a vitrin purchase with no
     * acceptance behind it is refused by a CHECK constraint, so reaching here
     * without one means the row was written by something that bypassed the
     * checkout. Failing the settlement is the correct answer to that; inventing
     * a version would put terms nobody agreed to on a live card.
     */
    const acceptance = await tx.showcaseCardPriceTermsAcceptance.findUniqueOrThrow({
      where: { id: purchase.showcasePriceTermsAcceptanceId },
      select: { termsVersion: true, termsTextSnapshot: true },
    });

    /*
     * The version being published.
     *
     * Deliberately the card's *current* live version rather than the one
     * snapshotted on the purchase. Between opening a checkout and paying for it
     * an operator may have approved a newer version, and publishing the older
     * text would mean the home page showing something the card's own page no
     * longer says. The purchase keeps its own snapshot as the record of what the
     * provider was looking at when they paid; this is what goes on the air.
     *
     * A card with no live version cannot reach here — the checkout refuses it —
     * but the fallback to the purchase's snapshot is written out rather than
     * assumed, because a settlement is not a place to discover a null.
     */
    const pinnedVersionId = card.liveVersionId ?? purchase.showcaseCardVersionId;

    const startAt = paidAt;
    const endAt = showcasePlacementEndAt(startAt, purchase.durationDaysSnapshot);

    const placement = await tx.showcasePlacement.create({
      data: {
        purchaseId: purchase.id,
        providerId: purchase.providerId,
        showcasePackageId: pkg.id,
        cardId: card.id,
        pinnedVersionId,
        categoryId: card.categoryId,
        kindSnapshot: card.kind,
        packageNameSnapshot: purchase.packageNameSnapshot,
        priceAmountSnapshot: purchase.priceAmountSnapshot,
        currencySnapshot: purchase.currencySnapshot,
        durationDaysSnapshot: purchase.durationDaysSnapshot,
        priceTermsVersionSnapshot: acceptance.termsVersion,
        priceTermsTextSnapshot: acceptance.termsTextSnapshot,
        startAt,
        endAt,
        status: ShowcasePlacementStatus.PENDING_ACTIVATION,
      },
      select: { id: true },
    });

    await this.writeShelves(tx, {
      placementId: placement.id,
      providerId: card.providerId,
      categoryId: card.categoryId,
      versionId: pinnedVersionId,
      maxAreas: pkg.maxAreas,
      endAt,
      active: true,
    });

    await tx.showcasePlacement.update({
      where: { id: placement.id },
      data: { status: ShowcasePlacementStatus.ACTIVE },
    });

    return { placementId: placement.id };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Off the air, and back
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Takes a placement off the air and opens the suspension row that says why.
   *
   * Returns `false` when there was nothing to suspend — the placement is
   * already off the air, or already over. Callers treat that as an ordinary
   * outcome rather than an error, because most of them are reacting to an event
   * that touches many placements at once and some of them will legitimately not
   * apply.
   *
   * `extendsClock` is computed here and **written onto the row**. `resume`
   * reads the column and never calls the policy function again: if the policy
   * changes next year, what happened to this placement must not change with it.
   */
  async suspend(
    tx: Prisma.TransactionClient,
    placementId: string,
    input: {
      reason: ShowcasePlacementSuspendReason;
      actorUserId?: string | null;
      note?: string | null;
      now?: Date;
    },
  ): Promise<boolean> {
    const now = input.now ?? new Date();

    const placement = await tx.showcasePlacement.findUnique({
      where: { id: placementId },
      select: { id: true, status: true, endAt: true },
    });

    if (!placement || placement.status !== ShowcasePlacementStatus.ACTIVE) {
      return false;
    }

    // Conditional, so two events suspending one placement in the same instant
    // cannot both open a suspension row — the second matches nothing, and the
    // partial unique index on open suspensions would refuse it anyway.
    const moved = await tx.showcasePlacement.updateMany({
      where: { id: placementId, status: ShowcasePlacementStatus.ACTIVE },
      data: {
        status: ShowcasePlacementStatus.SUSPENDED,
        suspendedAt: now,
        suspendReason: input.reason,
      },
    });

    if (moved.count !== 1) {
      return false;
    }

    await tx.showcasePlacementSuspension.create({
      data: {
        placementId,
        reason: input.reason,
        extendsClock: suspensionExtendsClock(input.reason),
        startedAt: now,
        endAtBefore: placement.endAt,
        actorUserId: input.actorUserId ?? null,
        note: input.note?.trim() || null,
      },
    });

    // The shelf rows come down with it. The feed reads `active` and the
    // placement's own window, and both have to agree at every instant a reader
    // could observe.
    await tx.showcasePlacementShelf.updateMany({
      where: { placementId },
      data: { active: false },
    });

    return true;
  }

  /**
   * Puts a placement back on the air and settles what the interval cost.
   *
   * The clock rule lives here in three lines, and they are the point of the
   * whole feature:
   *
   * - a suspension whose `extendsClock` is **true** pushes `endAt` forward by
   *   exactly the interval it lasted, and records the total on the placement;
   * - one whose `extendsClock` is **false** leaves `endAt` untouched — the
   *   provider lost those days, which is the price of a run not being parkable;
   * - and either way, the suspension row records where the clock ended up.
   *
   * `expectedReason` is how an operator's "resume" is kept to their own hold.
   * The other five reasons lift when the condition behind them goes away, and
   * the code that changes that condition resumes the placement in the same
   * transaction — so an operator resuming, say, a `CATEGORY_CLOSED` suspension
   * would put a card back on a shelf the platform has closed.
   *
   * A placement whose `endAt` has already passed while it was suspended comes
   * back EXPIRED rather than ACTIVE, so resuming can never publish something
   * whose paid time is spent.
   */
  async resume(
    tx: Prisma.TransactionClient,
    placementId: string,
    input: { expectedReason?: ShowcasePlacementSuspendReason; now?: Date } = {},
  ): Promise<boolean> {
    const now = input.now ?? new Date();

    const placement = await tx.showcasePlacement.findUnique({
      where: { id: placementId },
      select: {
        id: true,
        status: true,
        endAt: true,
        suspendedAt: true,
        suspendReason: true,
        totalExtendedMs: true,
      },
    });

    if (
      !placement ||
      placement.status !== ShowcasePlacementStatus.SUSPENDED ||
      !placement.suspendedAt ||
      !placement.suspendReason
    ) {
      return false;
    }

    if (input.expectedReason && placement.suspendReason !== input.expectedReason) {
      return false;
    }

    const open = await tx.showcasePlacementSuspension.findFirst({
      where: { placementId, endedAt: null },
      orderBy: [{ startedAt: 'desc' }],
      select: { id: true, extendsClock: true, endAtBefore: true },
    });

    // The stored verdict, never a fresh call to the policy function.
    const extendsClock = open?.extendsClock ?? false;
    const suspendedForMs = Math.max(0, now.getTime() - placement.suspendedAt.getTime());
    const endAt = extendsClock
      ? new Date(placement.endAt.getTime() + suspendedForMs)
      : placement.endAt;

    // Paid time that ran out while the card was off the air does not come back
    // just because the reason did.
    const nextStatus =
      endAt.getTime() > now.getTime()
        ? ShowcasePlacementStatus.ACTIVE
        : ShowcasePlacementStatus.EXPIRED;

    const moved = await tx.showcasePlacement.updateMany({
      where: { id: placementId, status: ShowcasePlacementStatus.SUSPENDED },
      data: {
        status: nextStatus,
        suspendedAt: null,
        suspendReason: null,
        endAt,
        ...(extendsClock
          ? { totalExtendedMs: placement.totalExtendedMs + suspendedForMs }
          : {}),
      },
    });

    if (moved.count !== 1) {
      return false;
    }

    if (open) {
      await tx.showcasePlacementSuspension.update({
        where: { id: open.id },
        data: { endedAt: now, endAtAfter: endAt },
      });
    }

    await tx.showcasePlacementShelf.updateMany({
      where: { placementId },
      data: {
        active: nextStatus === ShowcasePlacementStatus.ACTIVE,
        endAt,
      },
    });

    return true;
  }

  /**
   * Every placement of one card that is currently on the air, suspended for a
   * reason that lifts by itself.
   *
   * The read half of the "resume when the obstacle goes away" contract: a
   * category reopening asks for its own reason, a card leaving the archive asks
   * for its own, and neither can accidentally lift an operator's hold —
   * `ADMIN_ACTION` is excluded by {@link suspensionLiftsAutomatically} and by
   * the `expectedReason` guard in {@link resume}.
   */
  async resumeSuspendedFor(
    tx: Prisma.TransactionClient,
    where: { cardId?: string; providerId?: string; categoryId?: string },
    reason: ShowcasePlacementSuspendReason,
    now: Date = new Date(),
  ): Promise<number> {
    if (!suspensionLiftsAutomatically(reason)) {
      return 0;
    }

    const placements = await tx.showcasePlacement.findMany({
      where: {
        ...(where.cardId ? { cardId: where.cardId } : {}),
        ...(where.providerId ? { providerId: where.providerId } : {}),
        ...(where.categoryId ? { categoryId: where.categoryId } : {}),
        status: ShowcasePlacementStatus.SUSPENDED,
        suspendReason: reason,
      },
      select: { id: true },
    });

    let resumed = 0;
    for (const placement of placements) {
      if (await this.resume(tx, placement.id, { expectedReason: reason, now })) {
        resumed += 1;
      }
    }

    return resumed;
  }

  /** The mirror image: suspend every live placement matching a predicate. */
  async suspendLiveFor(
    tx: Prisma.TransactionClient,
    where: { cardId?: string; providerId?: string; categoryId?: string },
    input: {
      reason: ShowcasePlacementSuspendReason;
      actorUserId?: string | null;
      note?: string | null;
      now?: Date;
    },
  ): Promise<number> {
    const placements = await tx.showcasePlacement.findMany({
      where: {
        ...(where.cardId ? { cardId: where.cardId } : {}),
        ...(where.providerId ? { providerId: where.providerId } : {}),
        ...(where.categoryId ? { categoryId: where.categoryId } : {}),
        status: ShowcasePlacementStatus.ACTIVE,
      },
      select: { id: true },
    });

    let suspended = 0;
    for (const placement of placements) {
      if (await this.suspend(tx, placement.id, input)) {
        suspended += 1;
      }
    }

    return suspended;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Following the card
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Moves every live placement of a card onto a newly published version, and
   * rewrites their shelves from it.
   *
   * Called from the two places that make a version live — an operator's
   * approval and the narrowing rule's auto-publish — and always inside their
   * transaction. That is the whole reason it exists: a placement still serving
   * last week's text after somebody decided this week's should be live means the
   * home page and the card's own page say different things about the same
   * business.
   *
   * Widening is allowed here and is not a conflict. A new version may add areas,
   * and the shelves simply grow: an earlier draft of this design refused an
   * overlapping shelf, and that refusal is what made a second card unsellable.
   * Balance between providers is a ranking concern, not a publishing one.
   *
   * `endAt` is untouched. Re-pinning is not a change to what was bought.
   */
  async repinToVersion(
    tx: Prisma.TransactionClient,
    cardId: string,
    toVersionId: string,
    trigger: ShowcaseVersionChangeTrigger,
  ): Promise<number> {
    const placements = await tx.showcasePlacement.findMany({
      where: {
        cardId,
        status: {
          in: [
            ShowcasePlacementStatus.PENDING_ACTIVATION,
            ShowcasePlacementStatus.ACTIVE,
            ShowcasePlacementStatus.SUSPENDED,
          ],
        },
      },
      select: {
        id: true,
        providerId: true,
        categoryId: true,
        pinnedVersionId: true,
        endAt: true,
        status: true,
        package: { select: { maxAreas: true } },
      },
    });

    let repinned = 0;

    for (const placement of placements) {
      if (placement.pinnedVersionId === toVersionId) {
        continue;
      }

      await tx.showcasePlacement.update({
        where: { id: placement.id },
        data: { pinnedVersionId: toVersionId },
      });

      // Replaced wholesale rather than diffed, exactly as a draft's areas are:
      // the shelf set is derived from the version, and a diff would be a second
      // definition of what "the same shelf" means beside the key that already
      // answers it.
      await tx.showcasePlacementShelf.deleteMany({ where: { placementId: placement.id } });
      await this.writeShelves(tx, {
        placementId: placement.id,
        providerId: placement.providerId,
        categoryId: placement.categoryId,
        versionId: toVersionId,
        maxAreas: placement.package.maxAreas,
        endAt: placement.endAt,
        active: placement.status === ShowcasePlacementStatus.ACTIVE,
      });

      await tx.showcasePlacementVersionChange.create({
        data: {
          placementId: placement.id,
          fromVersionId: placement.pinnedVersionId,
          toVersionId,
          trigger,
        },
      });

      repinned += 1;
    }

    return repinned;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * The shelf rows one placement publishes into, derived from its pinned
   * version's own areas.
   *
   * ## Which areas are dropped when a package caps them
   *
   * The widest first. `maxAreas` is a package's ceiling on how many shelves one
   * run may occupy, and when a version claims more than that the ones kept are
   * the broadest — a province before a district, a district before a
   * neighbourhood — because a broader area reaches strictly more of the people
   * the provider paid to reach. Sorting by `areaKey` inside each scope keeps the
   * choice deterministic, so the same version and the same package always
   * publish the same set.
   *
   * The cap is not a product rule about coverage; it is a price tier. A provider
   * who wants all of their areas published buys the package that allows them.
   */
  private async writeShelves(
    tx: Prisma.TransactionClient,
    input: {
      placementId: string;
      providerId: string;
      categoryId: string;
      versionId: string;
      maxAreas: number | null;
      endAt: Date;
      active: boolean;
    },
  ): Promise<number> {
    const areas = await tx.showcaseCardVersionArea.findMany({
      where: { cardVersionId: input.versionId },
      select: {
        scope: true,
        city: true,
        district: true,
        neighborhood: true,
        areaKey: true,
      },
    });

    const ordered = [...areas].sort(
      (left, right) =>
        scopeBreadth(left.scope) - scopeBreadth(right.scope) ||
        left.areaKey.localeCompare(right.areaKey),
    );

    const published =
      input.maxAreas === null ? ordered : ordered.slice(0, Math.max(0, input.maxAreas));

    if (published.length === 0) {
      return 0;
    }

    await tx.showcasePlacementShelf.createMany({
      data: published.map((area) => ({
        placementId: input.placementId,
        providerId: input.providerId,
        categoryId: input.categoryId,
        areaKey: area.areaKey,
        scope: area.scope,
        city: area.city,
        district: area.district,
        neighborhood: area.neighborhood,
        active: input.active,
        endAt: input.endAt,
      })),
    });

    return published.length;
  }
}

/**
 * The columns {@link ShowcasePlacementService.createForPurchase} needs from the
 * purchase it is settling.
 *
 * Spelled out rather than taken as a whole `PackagePurchase`, because the four
 * showcase columns are nullable on the model and NOT NULL in every case that
 * reaches here — the CHECK constraint says so — and naming them non-nullable in
 * the type is what makes the caller narrow them before calling.
 */
export type SettledShowcasePurchase = {
  id: string;
  providerId: string;
  showcasePackageId: string;
  showcaseCardId: string;
  showcaseCardVersionId: string;
  durationDaysSnapshot: number;
  packageNameSnapshot: string;
  priceAmountSnapshot: number;
  currencySnapshot: string;
  /**
   * The acceptance the checkout was opened against. Non-nullable here for the
   * same reason the four above are: the column is nullable on the model and
   * NOT NULL for every SHOWCASE_PACKAGE row by CHECK, and naming it
   * non-nullable is what forces the caller to narrow it before settling.
   */
  showcasePriceTermsAcceptanceId: string;
};

/** Province first, neighbourhood last: smaller number means wider reach. */
function scopeBreadth(scope: ProviderServiceAreaScope): number {
  switch (scope) {
    case ProviderServiceAreaScope.CITY:
      return 0;
    case ProviderServiceAreaScope.DISTRICT:
      return 1;
    case ProviderServiceAreaScope.NEIGHBORHOOD:
      return 2;
  }
}

/**
 * The full "is this card actually on the air" predicate, as a Prisma filter.
 *
 * Every one of the last three conditions is a join rather than a denormalised
 * column, and that is deliberate: the card's status, the pinned version's review
 * state and the provider's own approval are facts owned by phase one and by the
 * provider lifecycle, and a stale copy of any of them means an unapproved card
 * sitting on the home page.
 */
export function livePlacementWhere(now: Date): Prisma.ShowcasePlacementWhereInput {
  return {
    status: ShowcasePlacementStatus.ACTIVE,
    startAt: { lte: now },
    endAt: { gt: now },
    card: { status: ShowcaseCardStatus.APPROVED },
    pinnedVersion: { reviewStatus: ShowcaseVersionReview.APPROVED },
  };
}

/** The card kinds a package may be bought for, as a readable predicate. */
export function packageAllowsCardKind(
  allowedCardKind: ShowcaseCardKind | null,
  cardKind: ShowcaseCardKind,
): boolean {
  return allowedCardKind === null || allowedCardKind === cardKind;
}
