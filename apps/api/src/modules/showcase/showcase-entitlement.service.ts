import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  ShowcaseCardKind,
  ShowcaseEntitlementPauseEnd,
  ShowcaseEntitlementStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ShowcasePlacementService } from './showcase-placement.service';
import {
  showcaseEntitlementKindMismatch,
  showcaseEntitlementMissing,
  showcaseEntitlementRequired,
  showcaseEntitlementUnavailable,
} from './showcase.errors';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A right that can be bound to a new card right now. */
export function usableEntitlementWhere(now: Date): Prisma.ShowcaseEntitlementWhereInput {
  return { status: ShowcaseEntitlementStatus.AVAILABLE, expiresAt: { gt: now } };
}

/**
 * A right reserved for this card that can still be consumed. A paused right —
 * the card is with an operator — is valid regardless of `expiresAt`: review
 * time belongs to the operator and must never cost the provider their right.
 */
export function reservedEntitlementWhere(
  cardId: string,
  now: Date,
): Prisma.ShowcaseEntitlementWhereInput {
  return {
    cardId,
    status: ShowcaseEntitlementStatus.RESERVED,
    OR: [{ reviewPausedAt: { not: null } }, { expiresAt: { gt: now } }],
  };
}

/** The columns a settlement hands over. Narrowed by the caller, never asserted. */
export type SettledEntitlementPurchase = {
  id: string;
  providerId: string;
  showcasePackageId: string;
  durationDaysSnapshot: number;
  packageNameSnapshot: string;
  priceAmountSnapshot: number;
  currencySnapshot: string;
  showcasePackageTermsAcceptanceId: string;
};

export type ProviderEntitlementSummary = {
  id: string;
  packageName: string;
  durationDays: number;
  allowedCardKind: ShowcaseCardKind | null;
  expiresAt: string;
};

/**
 * The life of a purchased publication right: granted by a settlement, reserved
 * by a card, paused while that card is reviewed, released if the card is
 * discarded, consumed — once — when the card is first approved.
 *
 * Every write is conditional on the status it expects (`updateMany` with the
 * status in the WHERE and `count === 1` checked), inside the caller's
 * transaction. That is what makes two cards racing for one right, or two
 * approvals racing for one card, produce exactly one winner.
 */
@Injectable()
export class ShowcaseEntitlementService {
  private readonly logger = new Logger('ShowcaseEntitlement');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ShowcasePlacementService) private readonly placements: ShowcasePlacementService,
  ) {}

  async grantForPurchase(
    tx: Prisma.TransactionClient,
    purchase: SettledEntitlementPurchase,
    paidAt: Date,
  ): Promise<{ entitlementId: string }> {
    const [pkg, acceptance] = await Promise.all([
      tx.showcasePackage.findUniqueOrThrow({
        where: { id: purchase.showcasePackageId },
        select: { activationWindowDays: true, allowedCardKind: true, maxAreas: true },
      }),
      tx.showcasePackageTermsAcceptance.findUniqueOrThrow({
        where: { id: purchase.showcasePackageTermsAcceptanceId },
        select: { termsVersion: true, termsTextSnapshot: true },
      }),
    ]);

    const created = await tx.showcaseEntitlement.create({
      data: {
        providerId: purchase.providerId,
        purchaseId: purchase.id,
        showcasePackageId: purchase.showcasePackageId,
        packageNameSnapshot: purchase.packageNameSnapshot,
        durationDaysSnapshot: purchase.durationDaysSnapshot,
        priceAmountSnapshot: purchase.priceAmountSnapshot,
        currencySnapshot: purchase.currencySnapshot,
        allowedCardKindSnapshot: pkg.allowedCardKind,
        maxAreasSnapshot: pkg.maxAreas,
        priceTermsVersionSnapshot: acceptance.termsVersion,
        priceTermsTextSnapshot: acceptance.termsTextSnapshot,
        status: ShowcaseEntitlementStatus.AVAILABLE,
        grantedAt: paidAt,
        expiresAt: new Date(paidAt.getTime() + pkg.activationWindowDays * DAY_MS),
      },
      select: { id: true },
    });

    return { entitlementId: created.id };
  }

  /**
   * Binds one usable right to one card. The candidate is the caller's choice
   * or, absent one, the right that would expire soonest — spending the oldest
   * purchase first is what a provider holding two packages expects.
   */
  async reserveForCard(
    tx: Prisma.TransactionClient,
    input: {
      providerId: string;
      cardId: string;
      kind: ShowcaseCardKind;
      entitlementId: string | null;
      now: Date;
    },
  ) {
    const candidate = await tx.showcaseEntitlement.findFirst({
      where: {
        providerId: input.providerId,
        ...usableEntitlementWhere(input.now),
        ...(input.entitlementId
          ? { id: input.entitlementId }
          : // Unnamed search: only a right that could actually cover this card
            // kind is a candidate. A kind-restricted right the caller did not
            // name is simply not in the running — it is not what makes a later,
            // usable right unreachable.
            { OR: [{ allowedCardKindSnapshot: null }, { allowedCardKindSnapshot: input.kind }] }),
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      select: { id: true, allowedCardKindSnapshot: true },
    });

    if (!candidate) {
      throw showcaseEntitlementRequired();
    }

    if (candidate.allowedCardKindSnapshot !== null && candidate.allowedCardKindSnapshot !== input.kind) {
      // A named right of the wrong kind is a mismatch; an unnamed search simply
      // has no usable right of this kind.
      throw input.entitlementId ? showcaseEntitlementKindMismatch() : showcaseEntitlementRequired();
    }

    const moved = await tx.showcaseEntitlement.updateMany({
      where: { id: candidate.id, ...usableEntitlementWhere(input.now) },
      data: {
        status: ShowcaseEntitlementStatus.RESERVED,
        cardId: input.cardId,
        reservedAt: input.now,
      },
    });

    if (moved.count !== 1) {
      throw showcaseEntitlementUnavailable();
    }

    return tx.showcaseEntitlement.findUniqueOrThrow({ where: { id: candidate.id } });
  }

  /** The card was discarded before it went live: the right goes back on the shelf. */
  async releaseForCard(tx: Prisma.TransactionClient, cardId: string, now: Date): Promise<boolean> {
    const reserved = await tx.showcaseEntitlement.findFirst({
      where: { cardId, status: ShowcaseEntitlementStatus.RESERVED },
      select: { id: true, reviewPausedAt: true },
    });
    if (!reserved) {
      return false;
    }

    if (reserved.reviewPausedAt) {
      await this.closePause(tx, reserved.id, ShowcaseEntitlementPauseEnd.RELEASED, now);
    }

    const moved = await tx.showcaseEntitlement.updateMany({
      where: { id: reserved.id, status: ShowcaseEntitlementStatus.RESERVED },
      data: {
        status: ShowcaseEntitlementStatus.AVAILABLE,
        cardId: null,
        reservedAt: null,
        reviewPausedAt: null,
      },
    });
    return moved.count === 1;
  }

  /**
   * A right still marked RESERVED on this card whose window closed while the
   * card sat unsubmitted — the sweeper has not reached it yet — is moved to
   * EXPIRED so a fresh right can take the card's single reservation slot.
   * A paused right is never lapsed: review time is the operator's.
   */
  async expireLapsedReservationForCard(
    tx: Prisma.TransactionClient,
    cardId: string,
    now: Date,
  ): Promise<boolean> {
    const lapsed = await tx.showcaseEntitlement.findFirst({
      where: {
        cardId,
        status: ShowcaseEntitlementStatus.RESERVED,
        reviewPausedAt: null,
        expiresAt: { lte: now },
      },
      select: { id: true },
    });
    if (!lapsed) {
      return false;
    }

    const moved = await tx.showcaseEntitlement.updateMany({
      where: {
        id: lapsed.id,
        status: ShowcaseEntitlementStatus.RESERVED,
        reviewPausedAt: null,
        expiresAt: { lte: now },
      },
      data: { status: ShowcaseEntitlementStatus.EXPIRED, cardId: null, reservedAt: null },
    });
    return moved.count === 1;
  }

  /** The card entered review: stop the clock and write the audit row. */
  async pauseForReview(
    tx: Prisma.TransactionClient,
    cardId: string,
    cardVersionId: string,
    now: Date,
  ): Promise<boolean> {
    const reserved = await tx.showcaseEntitlement.findFirst({
      where: { cardId, status: ShowcaseEntitlementStatus.RESERVED, reviewPausedAt: null },
      select: { id: true, expiresAt: true },
    });
    if (!reserved) {
      return false;
    }

    await tx.showcaseEntitlement.update({
      where: { id: reserved.id },
      data: { reviewPausedAt: now },
    });
    await tx.showcaseEntitlementReviewPause.create({
      data: {
        entitlementId: reserved.id,
        cardVersionId,
        startedAt: now,
        expiresAtBefore: reserved.expiresAt,
      },
    });
    return true;
  }

  /** The card left review without going live: the clock resumes with the time given back. */
  async resumeAfterReview(
    tx: Prisma.TransactionClient,
    cardId: string,
    endReason: 'REJECTED' | 'WITHDRAWN',
    now: Date,
  ): Promise<boolean> {
    const reserved = await tx.showcaseEntitlement.findFirst({
      where: { cardId, status: ShowcaseEntitlementStatus.RESERVED, reviewPausedAt: { not: null } },
      select: { id: true },
    });
    if (!reserved) {
      return false;
    }
    await this.closePause(tx, reserved.id, endReason, now);
    return true;
  }

  /**
   * Spends the card's reserved right and births the placement, in one
   * transaction. Refuses when there is no valid reserved right — which is what
   * makes "approved but unpublishable" unrepresentable.
   */
  async consumeForCard(
    tx: Prisma.TransactionClient,
    input: {
      cardId: string;
      versionId: string;
      providerId: string;
      categoryId: string;
      kind: ShowcaseCardKind;
      now: Date;
    },
  ): Promise<{ placementId: string; entitlementId: string }> {
    const reserved = await tx.showcaseEntitlement.findFirst({
      where: reservedEntitlementWhere(input.cardId, input.now),
    });
    if (!reserved) {
      throw showcaseEntitlementMissing();
    }

    if (reserved.reviewPausedAt) {
      await this.closePause(tx, reserved.id, ShowcaseEntitlementPauseEnd.CONSUMED, input.now);
    }

    const { placementId } = await this.placements.createForEntitlement(tx, {
      entitlement: reserved,
      providerId: input.providerId,
      cardId: input.cardId,
      categoryId: input.categoryId,
      kind: input.kind,
      versionId: input.versionId,
      startAt: input.now,
    });

    const moved = await tx.showcaseEntitlement.updateMany({
      where: { id: reserved.id, status: ShowcaseEntitlementStatus.RESERVED, cardId: input.cardId },
      data: {
        status: ShowcaseEntitlementStatus.CONSUMED,
        consumedAt: input.now,
        placementId,
        reviewPausedAt: null,
      },
    });
    if (moved.count !== 1) {
      throw showcaseEntitlementMissing();
    }

    return { placementId, entitlementId: reserved.id };
  }

  findReservedForCard(db: Prisma.TransactionClient | PrismaService, cardId: string, now: Date) {
    return db.showcaseEntitlement.findFirst({
      where: reservedEntitlementWhere(cardId, now),
      include: { purchase: { select: { showcasePackageTermsAcceptance: { select: { acceptedAt: true } } } } },
    });
  }

  async listForProvider(providerId: string, now: Date) {
    const rows = await this.prisma.showcaseEntitlement.findMany({
      where: {
        providerId,
        OR: [usableEntitlementWhere(now), { status: ShowcaseEntitlementStatus.RESERVED }],
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, status: true, cardId: true, packageNameSnapshot: true,
        durationDaysSnapshot: true, allowedCardKindSnapshot: true, expiresAt: true, reviewPausedAt: true,
      },
    });

    const summary = (row: (typeof rows)[number]): ProviderEntitlementSummary => ({
      id: row.id,
      packageName: row.packageNameSnapshot,
      durationDays: row.durationDaysSnapshot,
      allowedCardKind: row.allowedCardKindSnapshot,
      expiresAt: row.expiresAt.toISOString(),
    });

    return {
      available: rows.filter((row) => row.status === ShowcaseEntitlementStatus.AVAILABLE).map(summary),
      reservedByCard: Object.fromEntries(
        rows
          .filter((row) => row.status === ShowcaseEntitlementStatus.RESERVED && row.cardId)
          .map((row) => [
            row.cardId!,
            { ...summary(row), pausedForReview: row.reviewPausedAt !== null, valid: row.reviewPausedAt !== null || row.expiresAt > now },
          ]),
      ) as Record<string, ProviderEntitlementSummary & { pausedForReview: boolean; valid: boolean }>,
    };
  }

  /** The sweeper: rights whose window closed while nobody was reviewing them. */
  async expireStale(now: Date, limit: number): Promise<number> {
    const candidates = await this.prisma.showcaseEntitlement.findMany({
      where: {
        status: { in: [ShowcaseEntitlementStatus.AVAILABLE, ShowcaseEntitlementStatus.RESERVED] },
        reviewPausedAt: null,
        expiresAt: { lte: now },
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });

    let expired = 0;
    for (const candidate of candidates) {
      const moved = await this.prisma.showcaseEntitlement.updateMany({
        where: {
          id: candidate.id,
          status: { in: [ShowcaseEntitlementStatus.AVAILABLE, ShowcaseEntitlementStatus.RESERVED] },
          reviewPausedAt: null,
          expiresAt: { lte: now },
        },
        data: { status: ShowcaseEntitlementStatus.EXPIRED },
      });
      expired += moved.count;
    }

    if (expired > 0) {
      this.logger.log(`vitrin entitlements expired=${expired}`);
    }
    return expired;
  }

  private async closePause(
    tx: Prisma.TransactionClient,
    entitlementId: string,
    endReason: ShowcaseEntitlementPauseEnd,
    now: Date,
  ) {
    const right = await tx.showcaseEntitlement.findUniqueOrThrow({
      where: { id: entitlementId },
      select: { expiresAt: true, reviewPausedAt: true, totalPausedSeconds: true },
    });
    const open = await tx.showcaseEntitlementReviewPause.findFirst({
      where: { entitlementId, endedAt: null },
      select: { id: true, startedAt: true },
    });
    if (!right.reviewPausedAt || !open) {
      return;
    }

    const elapsedMs = Math.max(0, now.getTime() - open.startedAt.getTime());
    const expiresAt = new Date(right.expiresAt.getTime() + elapsedMs);

    await tx.showcaseEntitlement.update({
      where: { id: entitlementId },
      data: {
        expiresAt,
        reviewPausedAt: null,
        totalPausedSeconds: right.totalPausedSeconds + Math.round(elapsedMs / 1000),
      },
    });
    await tx.showcaseEntitlementReviewPause.update({
      where: { id: open.id },
      data: { endedAt: now, expiresAtAfter: expiresAt, endReason },
    });
  }
}
