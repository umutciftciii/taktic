import {
  CampaignRedemptionStatus,
  CampaignRevokeReason,
  CreditTransactionType,
  Prisma,
  PromoCreditLotConsumptionStatus,
  PromoCreditLotStatus,
} from '@prisma/client';
import { PRISMA_WRITE_CONFLICT_ERROR_CODE } from '../../common/serializable-transaction';

/**
 * Promotional credit accounting (CMP-002 S2B1).
 *
 * Every function here runs inside the caller's Serializable transaction and
 * moves promo credit between exactly three places: the wallet (the running
 * `balanceAfter` of `ProviderCreditTransaction`, which stays the one
 * canonical balance), a `PromoCreditLot`'s `remainingCredits`, and a
 * `PromoCreditLotConsumption` row that says which lot paid what share of one
 * OFFER_SPEND. The invariant every writer keeps:
 *
 *     balance = paid + Σ remainingCredits over lots with status ACTIVE or EXHAUSTED
 *
 * Nothing in this file decides *whether* a provider has promo credit; the
 * campaign engine does that (S2B2) by calling {@link grantPromoCreditLot}.
 * Until it does, no production path creates a lot, every function below
 * finds nothing to do, and the offer spend / refund paths behave exactly as
 * they did before this file existed.
 *
 * Writes are conditional UPDATEs (`updateMany … WHERE <the state we read>`)
 * rather than read-then-write, and a conditional that matches nothing is
 * reported with Prisma's write-conflict code so that `runSerializable`
 * replays the whole transaction instead of committing half an accounting
 * entry.
 */

type Tx = Prisma.TransactionClient;

/** Lots that may pay: valid, still holding credit, earliest-expiring first. */
export const PROMO_SPENDABLE_LOT_ORDER = [{ expiresAt: 'asc' }, { id: 'asc' }] as const satisfies Prisma.PromoCreditLotOrderByWithRelationInput[];

/** The lot statuses whose `remainingCredits` still sit inside `balanceAfter`. */
const WALLET_LOT_STATUSES = [PromoCreditLotStatus.ACTIVE, PromoCreditLotStatus.EXHAUSTED] as const;

export const PROMO_LEDGER_REASON = {
  grant: 'CAMPAIGN_GRANT',
  lotExpired: 'PROMO_LOT_EXPIRED',
  lotRevoked: (reason: CampaignRevokeReason) => `PROMO_LOT_REVOKED:${reason}`,
  forfeitOnRefund: (why: 'EXPIRED' | 'REVOKED') => `PROMO_FORFEIT_ON_REFUND:${why}`,
} as const;

/**
 * Raised when a conditional write finds the row no longer in the state this
 * transaction read. Carries P2034 so `runSerializable` replays the caller.
 */
export class PromoCreditWriteConflict extends Error {
  readonly code = PRISMA_WRITE_CONFLICT_ERROR_CODE;

  constructor(what: string) {
    super(`Promo credit ledger: concurrent write on ${what}; the transaction must be replayed`);
    this.name = 'PromoCreditWriteConflict';
  }
}

// ───────────────────────────── ledger rows ─────────────────────────────

/**
 * Appends one campaign movement to the ledger with the same arithmetic as
 * every other writer: the newest row's `balanceAfter` plus the amount, and a
 * refusal to go below zero. Kept local rather than routed through
 * `CreditsService` because the refund path is a module function with no
 * injector, and because a campaign row must never re-check provider
 * existence the caller's transaction has already established.
 */
async function appendCampaignLedgerRow(
  tx: Tx,
  entry: {
    providerId: string;
    type: typeof CreditTransactionType.CAMPAIGN_GRANT | typeof CreditTransactionType.CAMPAIGN_EXPIRE | typeof CreditTransactionType.CAMPAIGN_REVOKE;
    amount: number;
    reason: string;
    referenceType: 'CampaignRedemption' | 'PromoCreditLot' | 'PromoCreditLotConsumption';
    referenceId: string;
    createdById?: string | null;
  },
) {
  const balanceAfter = (await readWalletBalance(tx, entry.providerId)) + entry.amount;
  if (balanceAfter < 0) {
    // Cannot happen for a movement bounded by a lot's own remainder, but the
    // ledger's rule is the ledger's rule and this writer states it too.
    throw new PromoCreditWriteConflict(`ledger of provider ${entry.providerId} (balance would go negative)`);
  }

  return tx.providerCreditTransaction.create({
    data: {
      providerId: entry.providerId,
      type: entry.type,
      amount: entry.amount,
      balanceAfter,
      reason: entry.reason,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      createdById: entry.createdById ?? null,
    },
    select: { id: true, balanceAfter: true },
  });
}

/** The provider's balance, read the way every other credit path reads it. */
export async function readWalletBalance(tx: Tx, providerId: string) {
  const latest = await tx.providerCreditTransaction.findFirst({
    where: { providerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { balanceAfter: true },
  });

  return latest?.balanceAfter ?? 0;
}

// ───────────────────────────── reads ─────────────────────────────

/**
 * Promo credit that is still counted in `balanceAfter` but can no longer
 * pay: lots whose `expiresAt` has passed and which the sweep has not yet
 * expired. The resolver subtracts this from the wallet before deciding
 * whether an offer is affordable, so a late sweeper never lets a dead lot
 * buy anything.
 */
export async function readUnsweptExpiredPromoCredits(tx: Tx, providerId: string, now: Date) {
  const sum = await tx.promoCreditLot.aggregate({
    where: { providerId, status: PromoCreditLotStatus.ACTIVE, remainingCredits: { gt: 0 }, expiresAt: { lte: now } },
    _sum: { remainingCredits: true },
  });

  return sum._sum.remainingCredits ?? 0;
}

/** Remaining promo credit inside the wallet, split into spendable and not. */
export async function readPromoCreditSummary(tx: Tx, providerId: string, now: Date) {
  const lots = await tx.promoCreditLot.findMany({
    where: { providerId, status: { in: [...WALLET_LOT_STATUSES] } },
    select: { remainingCredits: true, expiresAt: true, status: true },
  });
  const inWallet = lots.reduce((total, lot) => total + lot.remainingCredits, 0);
  const spendable = lots
    .filter((lot) => lot.status === PromoCreditLotStatus.ACTIVE && lot.expiresAt > now)
    .reduce((total, lot) => total + lot.remainingCredits, 0);

  return { inWallet, spendable, unsweptExpired: inWallet - spendable };
}

// ───────────────────────────── spend ─────────────────────────────

/**
 * Takes an offer's cost out of the provider's promo lots, earliest-expiring
 * first, and records each lot's share against the OFFER_SPEND row.
 *
 * Called *after* that row exists: the debit is what the offer transaction
 * has always written, its `balanceAfter` already reflects the whole cost,
 * and a debit that failed never reaches this function — so a consumption row
 * without its debit cannot exist. Whatever the lots cannot cover is the paid
 * share, which needs no row: it is the difference the wallet already shows.
 *
 * Returns the split, in lot order; empty when no lot could pay.
 */
export async function consumePromoCreditsForSpend(
  tx: Tx,
  input: { providerId: string; spendTransactionId: string; creditCost: number; now: Date },
): Promise<Array<{ lotId: string; consumedCredits: number }>> {
  if (input.creditCost <= 0) {
    return [];
  }

  const lots = await tx.promoCreditLot.findMany({
    where: {
      providerId: input.providerId,
      status: PromoCreditLotStatus.ACTIVE,
      remainingCredits: { gt: 0 },
      expiresAt: { gt: input.now },
    },
    orderBy: [...PROMO_SPENDABLE_LOT_ORDER],
    select: { id: true, remainingCredits: true },
  });

  const split: Array<{ lotId: string; consumedCredits: number }> = [];
  let outstanding = input.creditCost;
  for (const lot of lots) {
    if (outstanding <= 0) break;
    const take = Math.min(lot.remainingCredits, outstanding);
    const exhausts = take === lot.remainingCredits;

    const updated = await tx.promoCreditLot.updateMany({
      where: {
        id: lot.id,
        status: PromoCreditLotStatus.ACTIVE,
        remainingCredits: { gte: take },
        expiresAt: { gt: input.now },
      },
      data: {
        remainingCredits: { decrement: take },
        ...(exhausts ? { status: PromoCreditLotStatus.EXHAUSTED } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new PromoCreditWriteConflict(`promo lot ${lot.id}`);
    }

    await tx.promoCreditLotConsumption.create({
      data: {
        lotId: lot.id,
        creditTransactionId: input.spendTransactionId,
        consumedCredits: take,
        consumedAt: input.now,
      },
      select: { id: true },
    });

    split.push({ lotId: lot.id, consumedCredits: take });
    outstanding -= take;
  }

  return split;
}

// ───────────────────────────── refund ─────────────────────────────

export type PromoRefundOutcome = {
  /** Shares that went back into a lot that is still valid. */
  refunded: Array<{ consumptionId: string; lotId: string; credits: number }>;
  /** Shares that left the wallet again because their lot had expired or been revoked. */
  forfeited: Array<{ consumptionId: string; lotId: string; credits: number; transactionId: string }>;
  /** The wallet after the last row this call wrote; null when it wrote none. */
  balanceAfter: number | null;
};

/**
 * Settles every unsettled share of one OFFER_SPEND after its OFFER_REFUND
 * row has been written.
 *
 * The refund row itself is unchanged: `+creditCost`, exactly as before this
 * slice, so `ManualOfferRefundAudit`, the refund e-mail and the
 * one-refund-per-offer index keep their contract. What this function decides
 * is where that credit *lands*:
 *
 *  - a share whose lot is still valid (ACTIVE or EXHAUSTED, `expiresAt` in
 *    the future) goes back into the lot — the wallet already rose by the
 *    refund, so only the lot's remainder and status move;
 *  - a share whose lot has expired (by status, or by `expiresAt` the sweep
 *    has not reached yet) or been revoked is forfeited: one negative
 *    CAMPAIGN_EXPIRE / CAMPAIGN_REVOKE row takes it back out of the wallet,
 *    and the consumption row names that row. A promo credit that has died
 *    therefore cannot be resurrected as a paid one by refunding the offer
 *    it bought (CMP-001 §2.6).
 *
 * Each share settles once: the conditional `WHERE status = CONSUMED` is the
 * guard, the offer's own refund guards (which run before this) the first
 * line of defence.
 */
export async function restorePromoConsumptionsForRefund(
  tx: Tx,
  input: { providerId: string; spendTransactionId: string; refundTransactionId: string; now: Date; createdById?: string | null },
): Promise<PromoRefundOutcome> {
  const shares = await tx.promoCreditLotConsumption.findMany({
    where: { creditTransactionId: input.spendTransactionId, status: PromoCreditLotConsumptionStatus.CONSUMED },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      consumedCredits: true,
      lot: { select: { id: true, providerId: true, status: true, expiresAt: true } },
    },
  });

  const outcome: PromoRefundOutcome = { refunded: [], forfeited: [], balanceAfter: null };
  for (const share of shares) {
    if (share.lot.providerId !== input.providerId) {
      throw new PromoCreditWriteConflict(`promo consumption ${share.id} (provider mismatch)`);
    }

    const revivable =
      (share.lot.status === PromoCreditLotStatus.ACTIVE || share.lot.status === PromoCreditLotStatus.EXHAUSTED) &&
      share.lot.expiresAt > input.now;

    if (revivable) {
      const lot = await tx.promoCreditLot.updateMany({
        where: {
          id: share.lot.id,
          status: { in: [...WALLET_LOT_STATUSES] },
          expiresAt: { gt: input.now },
        },
        data: { remainingCredits: { increment: share.consumedCredits }, status: PromoCreditLotStatus.ACTIVE },
      });
      if (lot.count !== 1) {
        throw new PromoCreditWriteConflict(`promo lot ${share.lot.id}`);
      }

      await settleShare(tx, share.id, {
        status: PromoCreditLotConsumptionStatus.REFUNDED,
        refundedCredits: share.consumedCredits,
        refundTransactionId: input.refundTransactionId,
        settledAt: input.now,
      });
      outcome.refunded.push({ consumptionId: share.id, lotId: share.lot.id, credits: share.consumedCredits });
      continue;
    }

    const revoked = share.lot.status === PromoCreditLotStatus.REVOKED;
    const row = await appendCampaignLedgerRow(tx, {
      providerId: input.providerId,
      type: revoked ? CreditTransactionType.CAMPAIGN_REVOKE : CreditTransactionType.CAMPAIGN_EXPIRE,
      amount: -share.consumedCredits,
      reason: PROMO_LEDGER_REASON.forfeitOnRefund(revoked ? 'REVOKED' : 'EXPIRED'),
      referenceType: 'PromoCreditLotConsumption',
      referenceId: share.id,
      createdById: input.createdById,
    });
    await settleShare(tx, share.id, {
      status: PromoCreditLotConsumptionStatus.FORFEITED,
      forfeitedCredits: share.consumedCredits,
      refundTransactionId: input.refundTransactionId,
      forfeitTransactionId: row.id,
      settledAt: input.now,
    });
    outcome.forfeited.push({ consumptionId: share.id, lotId: share.lot.id, credits: share.consumedCredits, transactionId: row.id });
    outcome.balanceAfter = row.balanceAfter;
  }

  return outcome;
}

async function settleShare(tx: Tx, consumptionId: string, data: Prisma.PromoCreditLotConsumptionUncheckedUpdateManyInput) {
  const settled = await tx.promoCreditLotConsumption.updateMany({
    where: { id: consumptionId, status: PromoCreditLotConsumptionStatus.CONSUMED },
    data,
  });
  if (settled.count !== 1) {
    throw new PromoCreditWriteConflict(`promo consumption ${consumptionId}`);
  }
}

// ───────────────────────────── grant / expire / revoke ─────────────────────────────

/**
 * Opens a lot for a redemption: one CAMPAIGN_GRANT row, one lot with
 * `remaining = granted`, and the redemption's `grantTransactionId` filled —
 * all or nothing, and once. S2B1 prepares this for the engine (S2B2) and
 * calls it from nowhere but the test suite.
 */
export async function grantPromoCreditLot(
  tx: Tx,
  input: { providerId: string; redemptionId: string; credits: number; expiresAt: Date; now: Date },
): Promise<{ lotId: string; transactionId: string; balanceAfter: number }> {
  if (!Number.isInteger(input.credits) || input.credits < 1) {
    throw new Error(`Promo credit ledger: a grant must be a positive integer, got ${input.credits}`);
  }

  const redemption = await tx.campaignRedemption.findUnique({
    where: { id: input.redemptionId },
    select: { providerId: true, grantTransactionId: true, status: true },
  });
  if (!redemption || redemption.providerId !== input.providerId) {
    throw new Error(`Promo credit ledger: redemption ${input.redemptionId} does not belong to provider ${input.providerId}`);
  }
  if (redemption.grantTransactionId !== null) {
    throw new PromoCreditWriteConflict(`redemption ${input.redemptionId} (already granted)`);
  }

  const row = await appendCampaignLedgerRow(tx, {
    providerId: input.providerId,
    type: CreditTransactionType.CAMPAIGN_GRANT,
    amount: input.credits,
    reason: PROMO_LEDGER_REASON.grant,
    referenceType: 'CampaignRedemption',
    referenceId: input.redemptionId,
  });
  const lot = await tx.promoCreditLot.create({
    data: {
      providerId: input.providerId,
      redemptionId: input.redemptionId,
      grantedCredits: input.credits,
      remainingCredits: input.credits,
      expiresAt: input.expiresAt,
      createdAt: input.now,
    },
    select: { id: true },
  });
  const linked = await tx.campaignRedemption.updateMany({
    where: { id: input.redemptionId, grantTransactionId: null },
    data: { grantTransactionId: row.id },
  });
  if (linked.count !== 1) {
    throw new PromoCreditWriteConflict(`redemption ${input.redemptionId}`);
  }

  return { lotId: lot.id, transactionId: row.id, balanceAfter: row.balanceAfter };
}

/**
 * Expires one due lot: whatever it still holds leaves the wallet through a
 * single CAMPAIGN_EXPIRE row, the lot becomes EXPIRED with zero remainder,
 * and its redemption GRANTED → EXPIRED. A lot that is not due, or already
 * expired or revoked, is left alone and reported as such — so a second run
 * writes nothing. An EXHAUSTED lot (nothing left) expires with no ledger row,
 * because a zero-amount row would state no movement.
 */
export async function expirePromoCreditLot(
  tx: Tx,
  input: { lotId: string; now: Date },
): Promise<{ expired: boolean; transactionId: string | null; credits: number }> {
  const lot = await tx.promoCreditLot.findUnique({
    where: { id: input.lotId },
    select: { id: true, providerId: true, redemptionId: true, status: true, remainingCredits: true, expiresAt: true },
  });
  if (
    !lot ||
    !(WALLET_LOT_STATUSES as readonly PromoCreditLotStatus[]).includes(lot.status) ||
    lot.expiresAt > input.now
  ) {
    return { expired: false, transactionId: null, credits: 0 };
  }

  const row =
    lot.remainingCredits > 0
      ? await appendCampaignLedgerRow(tx, {
          providerId: lot.providerId,
          type: CreditTransactionType.CAMPAIGN_EXPIRE,
          amount: -lot.remainingCredits,
          reason: PROMO_LEDGER_REASON.lotExpired,
          referenceType: 'PromoCreditLot',
          referenceId: lot.id,
        })
      : null;

  const updated = await tx.promoCreditLot.updateMany({
    where: {
      id: lot.id,
      status: lot.status,
      remainingCredits: lot.remainingCredits,
      expiresAt: { lte: input.now },
      expiryTransactionId: null,
    },
    data: { status: PromoCreditLotStatus.EXPIRED, remainingCredits: 0, expiryTransactionId: row?.id ?? null },
  });
  if (updated.count !== 1) {
    // Another runner expired it between the read and the write; the ledger
    // row above rolls back with this transaction.
    throw new PromoCreditWriteConflict(`promo lot ${lot.id}`);
  }

  await tx.campaignRedemption.updateMany({
    where: { id: lot.redemptionId, status: CampaignRedemptionStatus.GRANTED },
    data: { status: CampaignRedemptionStatus.EXPIRED },
  });

  return { expired: true, transactionId: row?.id ?? null, credits: lot.remainingCredits };
}

/**
 * Revokes one lot: its remainder leaves the wallet through a single
 * CAMPAIGN_REVOKE row (none when there is nothing left), the lot becomes
 * REVOKED with zero remainder, and its redemption GRANTED → REVOKED with the
 * reason, the actor and how much had already been spent. What was spent is
 * not clawed back (CMP-001 §2.6: no debt, no negative balance). Prepared for
 * S3; no production path calls it in this slice.
 */
export async function revokePromoCreditLot(
  tx: Tx,
  input: { lotId: string; reason: CampaignRevokeReason; revokedById: string | null; now: Date },
): Promise<{ revoked: boolean; transactionId: string | null; credits: number }> {
  const lot = await tx.promoCreditLot.findUnique({
    where: { id: input.lotId },
    select: { id: true, providerId: true, redemptionId: true, status: true, remainingCredits: true, grantedCredits: true },
  });
  if (!lot || !(WALLET_LOT_STATUSES as readonly PromoCreditLotStatus[]).includes(lot.status)) {
    return { revoked: false, transactionId: null, credits: 0 };
  }

  const row =
    lot.remainingCredits > 0
      ? await appendCampaignLedgerRow(tx, {
          providerId: lot.providerId,
          type: CreditTransactionType.CAMPAIGN_REVOKE,
          amount: -lot.remainingCredits,
          reason: PROMO_LEDGER_REASON.lotRevoked(input.reason),
          referenceType: 'PromoCreditLot',
          referenceId: lot.id,
          createdById: input.revokedById,
        })
      : null;

  const updated = await tx.promoCreditLot.updateMany({
    where: { id: lot.id, status: lot.status, remainingCredits: lot.remainingCredits, revokeTransactionId: null },
    data: { status: PromoCreditLotStatus.REVOKED, remainingCredits: 0, revokeTransactionId: row?.id ?? null },
  });
  if (updated.count !== 1) {
    throw new PromoCreditWriteConflict(`promo lot ${lot.id}`);
  }

  const redemption = await tx.campaignRedemption.updateMany({
    where: { id: lot.redemptionId, status: CampaignRedemptionStatus.GRANTED },
    data: {
      status: CampaignRedemptionStatus.REVOKED,
      revokedAt: input.now,
      revokeReason: input.reason,
      spentAtRevoke: lot.grantedCredits - lot.remainingCredits,
      revokedById: input.revokedById,
    },
  });
  if (redemption.count !== 1) {
    throw new PromoCreditWriteConflict(`redemption ${lot.redemptionId}`);
  }

  return { revoked: true, transactionId: row?.id ?? null, credits: lot.remainingCredits };
}
