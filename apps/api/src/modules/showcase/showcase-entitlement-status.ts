import { Prisma, ShowcaseEntitlementStatus } from '@prisma/client';
import { usableEntitlementWhere } from './showcase-entitlement.service';

/**
 * What a vitrin publication right *is* right now, read from its row
 * (API-SHOWCASE-ENTITLEMENT-STATUS-001).
 *
 * The stored `status` lags the clock by up to one sweep: a right whose window
 * closed stays AVAILABLE (or RESERVED) until `expireStale` runs. Every place
 * that acts on a right already reads the clock instead — `usableEntitlementWhere`
 * for binding, `reservedEntitlementWhere` for consuming — so the status a
 * screen shows is derived the same way, here and only here:
 *
 * - CONSUMED  — stored CONSUMED: the card was approved and the right became a
 *               run (`consumedAt`, `placementId`). "Used".
 * - EXPIRED   — stored EXPIRED, or a window that closed while the right was
 *               not paused: AVAILABLE with `expiresAt <= now`, or RESERVED with
 *               no open review pause and `expiresAt <= now`.
 * - RESERVED  — bound to a card and still consumable: paused for review (the
 *               clock is stopped, whatever `expiresAt` says) or inside its window.
 * - AVAILABLE — unbound and inside its window.
 *
 * The domain has no cancelled or revoked right: a refund or chargeback on the
 * purchase does not touch it (payments-webhook.service.ts flags the purchase
 * for manual review and leaves the right as it is). That is reported as it
 * is — the purchase's own status sits beside this one on every projection —
 * rather than invented here.
 *
 * Time is compared as instants (UTC milliseconds), never as calendar days in
 * any zone: a window closes at its `expiresAt` to the millisecond.
 */
export type ShowcaseEntitlementEffectiveStatus = 'AVAILABLE' | 'RESERVED' | 'CONSUMED' | 'EXPIRED';

export const SHOWCASE_ENTITLEMENT_EFFECTIVE_STATUSES: readonly ShowcaseEntitlementEffectiveStatus[] = [
  'AVAILABLE',
  'RESERVED',
  'CONSUMED',
  'EXPIRED',
];

const DAY_MS = 24 * 60 * 60 * 1000;

type StatusFacts = {
  status: ShowcaseEntitlementStatus;
  expiresAt: Date;
  reviewPausedAt: Date | null;
};

export function effectiveShowcaseEntitlementStatus(
  right: StatusFacts,
  now: Date,
): ShowcaseEntitlementEffectiveStatus {
  switch (right.status) {
    case ShowcaseEntitlementStatus.CONSUMED:
      return 'CONSUMED';
    case ShowcaseEntitlementStatus.EXPIRED:
      return 'EXPIRED';
    case ShowcaseEntitlementStatus.RESERVED:
      return right.reviewPausedAt !== null || right.expiresAt.getTime() > now.getTime() ? 'RESERVED' : 'EXPIRED';
    case ShowcaseEntitlementStatus.AVAILABLE:
      return right.expiresAt.getTime() > now.getTime() ? 'AVAILABLE' : 'EXPIRED';
  }
}

/**
 * The same four answers as row filters, for counting. A unit test pins that
 * every row lands in exactly the bucket {@link effectiveShowcaseEntitlementStatus}
 * gives it.
 */
export function showcaseEntitlementEffectiveWhere(
  status: ShowcaseEntitlementEffectiveStatus,
  now: Date,
): Prisma.ShowcaseEntitlementWhereInput {
  switch (status) {
    case 'AVAILABLE':
      return usableEntitlementWhere(now);
    case 'RESERVED':
      return {
        status: ShowcaseEntitlementStatus.RESERVED,
        OR: [{ reviewPausedAt: { not: null } }, { expiresAt: { gt: now } }],
      };
    case 'CONSUMED':
      return { status: ShowcaseEntitlementStatus.CONSUMED };
    case 'EXPIRED':
      return {
        OR: [
          { status: ShowcaseEntitlementStatus.EXPIRED },
          { status: ShowcaseEntitlementStatus.AVAILABLE, expiresAt: { lte: now } },
          { status: ShowcaseEntitlementStatus.RESERVED, reviewPausedAt: null, expiresAt: { lte: now } },
        ],
      };
  }
}

/** The columns {@link toShowcaseEntitlementView} reads, and only those. */
export const showcaseEntitlementViewSelect = {
  id: true,
  status: true,
  grantedAt: true,
  expiresAt: true,
  reservedAt: true,
  consumedAt: true,
  reviewPausedAt: true,
  placementId: true,
} satisfies Prisma.ShowcaseEntitlementSelect;

type ViewRow = Prisma.ShowcaseEntitlementGetPayload<{ select: typeof showcaseEntitlementViewSelect }>;

export type ShowcaseEntitlementView = {
  id: string;
  status: ShowcaseEntitlementEffectiveStatus;
  /** The row's own status, which may lag `status` until the sweep runs. */
  storedStatus: ShowcaseEntitlementStatus;
  grantedAt: Date;
  /** When an unused right lapses; moved forward by review pauses. */
  expiresAt: Date;
  reservedAt: Date | null;
  /** When the right was used — its card first approved. */
  usedAt: Date | null;
  /** The clock is stopped: the reserved card is with an operator. */
  pausedForReview: boolean;
  /**
   * Whole days left before an unused right lapses, rounded up — 0 never
   * appears for a usable right. Null when no clock is running: used, expired,
   * or paused for review.
   */
  remainingDays: number | null;
  /** The run the right became, once used. */
  placementId: string | null;
};

export function toShowcaseEntitlementView(row: ViewRow, now: Date): ShowcaseEntitlementView {
  const status = effectiveShowcaseEntitlementStatus(row, now);
  const pausedForReview = status === 'RESERVED' && row.reviewPausedAt !== null;
  const clockRunning = (status === 'AVAILABLE' || status === 'RESERVED') && !pausedForReview;
  return {
    id: row.id,
    status,
    storedStatus: row.status,
    grantedAt: row.grantedAt,
    expiresAt: row.expiresAt,
    reservedAt: row.reservedAt,
    usedAt: row.consumedAt,
    pausedForReview,
    remainingDays: clockRunning ? Math.ceil((row.expiresAt.getTime() - now.getTime()) / DAY_MS) : null,
    placementId: row.placementId,
  };
}
