import {
  CampaignAdminDeductPolicy,
  type CampaignCreditSpendPriority,
  CampaignRedemptionStatus,
  CampaignRevokeReason,
  CreditTransactionType,
  Prisma,
  PromoConsumptionSource,
  PromoCreditLotConsumptionStatus,
  PromoCreditLotStatus,
} from '@prisma/client';
import { fitsCreditLedger } from '../../common/credit-limits';
import { PRISMA_WRITE_CONFLICT_ERROR_CODE } from '../../common/serializable-transaction';

/**
 * Promotional credit accounting (CMP-002 S2B1).
 *
 * Every function here runs inside the caller's Serializable transaction and
 * moves promo credit between exactly three places: the wallet (the running
 * `balanceAfter` of `ProviderCreditTransaction`, which stays the one
 * canonical balance), a `PromoCreditLot`'s `remainingCredits`, and a
 * `PromoCreditLotConsumption` row that says which lot paid what share of one
 * debit (OFFER_SPEND or, since CAMPAIGN-CREDIT-POLICY-001, ADMIN_DEDUCT). The
 * invariant every writer keeps, with a paid pool that is never negative:
 *
 *     balance = paid + Σ remainingCredits over lots with status ACTIVE or EXHAUSTED
 *
 * Every debit goes through {@link debitWallet}, the one canonical waterfall:
 * PROMO_FIRST lots, then paid credit, then PAID_FIRST lots — each lot by the
 * policy of the campaign version it was granted under. Refund, revoke and
 * expiry never re-plan a debit; they read the consumption rows and lot
 * remainders that were actually written.
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

/**
 * A promo grant that would take the wallet past the ledger's integer column
 * (API-HARDENING-001). Thrown before anything is written, so the savepoint the
 * engine grants under rolls back clean.
 */
export class PromoCreditBalanceLimitExceeded extends Error {
  constructor(
    readonly providerId: string,
    readonly currentBalance: number,
  ) {
    super(`Promo credit ledger: a grant would take provider ${providerId} past the ledger's balance limit`);
    this.name = 'PromoCreditBalanceLimitExceeded';
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
  const balanceBefore = await readWalletBalance(tx, entry.providerId);
  const balanceAfter = balanceBefore + entry.amount;
  // API-HARDENING-001: a grant is the only positive movement this writer
  // makes, and it must not pass the ledger's integer column. Refused before
  // the row exists; the engine turns it into a CREDIT_BALANCE_LIMIT outcome.
  if (entry.amount > 0 && !fitsCreditLedger(balanceBefore, entry.amount)) {
    throw new PromoCreditBalanceLimitExceeded(entry.providerId, balanceBefore);
  }
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

/**
 * What a provider may be shown of their own promotion (CMP-004 S4): the
 * lots that can still pay — the spend predicate, in the canonical waterfall
 * order (CAMPAIGN-CREDIT-POLICY-001) — each with its remainder, its expiry,
 * the campaign's name and where it stands against paid credit, and nothing
 * else about the campaign. Read-only; the total is the sum of the rows.
 */
export async function readSpendablePromoLots(
  db: Tx | { promoCreditLot: Tx['promoCreditLot'] },
  providerId: string,
  now: Date,
): Promise<{
  spendableCredits: number;
  lots: Array<{ id: string; remainingCredits: number; expiresAt: Date; campaignName: string; spendPriority: CampaignCreditSpendPriority }>;
}> {
  const rows = await db.promoCreditLot.findMany({
    where: { providerId, status: PromoCreditLotStatus.ACTIVE, remainingCredits: { gt: 0 }, expiresAt: { gt: now } },
    select: {
      id: true,
      remainingCredits: true,
      expiresAt: true,
      spendPriority: true,
      redemption: { select: { campaign: { select: { name: true } } } },
    },
  });
  const lots = rows
    .map((row) => ({
      id: row.id,
      remainingCredits: row.remainingCredits,
      expiresAt: row.expiresAt,
      campaignName: row.redemption.campaign.name,
      spendPriority: row.spendPriority,
    }))
    .sort(compareWaterfall);
  return { spendableCredits: lots.reduce((total, lot) => total + lot.remainingCredits, 0), lots };
}

// ───────────────────────────── wallet debit ─────────────────────────────

/**
 * Why a debit is being made (CAMPAIGN-CREDIT-POLICY-001). The purpose decides
 * which promo lots are eligible; the order is the same canonical waterfall
 * for every purpose.
 */
export type WalletDebitPurpose = typeof PromoConsumptionSource.OFFER_SPEND | typeof PromoConsumptionSource.ADMIN_DEDUCT;

/** One wallet lot as the planner sees it. */
export type WalletLot = {
  id: string;
  remainingCredits: number;
  expiresAt: Date;
  status: PromoCreditLotStatus;
  spendPriority: CampaignCreditSpendPriority;
  adminDeductPolicy: CampaignAdminDeductPolicy;
};

/** The wallet split the way a debit and an operator have to see it. */
export type WalletBreakdown = {
  /** The canonical balance: the newest ledger row's `balanceAfter`. */
  balance: number;
  /** `balance − Σ remainingCredits` over ACTIVE/EXHAUSTED lots. Never negative (or the wallet is refused). */
  paidCredits: number;
  /** Promo credit still inside `balance`, valid or not. */
  promoInWalletCredits: number;
  /** Promo credit that can still pay (ACTIVE, remaining, not past expiry). */
  promoSpendableCredits: number;
  /** Of the spendable promo credit, what an ADMIN_DEDUCT may take (ALLOW_PROMO). */
  promoDeductibleCredits: number;
  /** Of the spendable promo credit, what an ADMIN_DEDUCT may never take (PAID_ONLY). */
  promoProtectedCredits: number;
  /** Past expiry but not yet swept: inside `balance`, able to pay for nothing. */
  promoUnsweptExpiredCredits: number;
  /** What an offer spend can draw: paid + spendable promo. */
  spendableCredits: number;
  /** What an ADMIN_DEDUCT can draw: paid + deductible promo. */
  deductibleCredits: number;
};

export type WalletDebitShare = { lotId: string; credits: number; exhausts: boolean };

export type WalletDebitPlan = {
  purpose: WalletDebitPurpose;
  amount: number;
  breakdown: WalletBreakdown;
  /** Promo shares, in waterfall order (tier, expiresAt, id). */
  promoShares: WalletDebitShare[];
  /** The paid pool's share. Has no row of its own: it is what the ledger already shows. */
  paidShare: number;
};

export type WalletDebitRefusal =
  /** More than the whole balance. */
  | 'INSUFFICIENT_BALANCE'
  /** An offer spend that the spendable credit (paid + valid promo) cannot cover. */
  | 'INSUFFICIENT_SPENDABLE'
  /** An ADMIN_DEDUCT that the deductible credit (paid + ALLOW_PROMO promo) cannot cover. */
  | 'EXCEEDS_DEDUCTIBLE';

/**
 * The wallet does not satisfy `balance = paid + Σ promo remaining` with a
 * non-negative paid pool. Nothing is written; this is a fault to investigate,
 * never a state to "repair" by guessing which pool a past movement came from.
 */
export class WalletInvariantViolation extends Error {
  constructor(
    readonly providerId: string | null,
    readonly balance: number,
    readonly promoInWalletCredits: number,
  ) {
    super(
      `Wallet invariant violated${providerId ? ` for provider ${providerId}` : ''}: balance ${balance} < promo in wallet ${promoInWalletCredits}`,
    );
    this.name = 'WalletInvariantViolation';
  }
}

/** A debit the wallet cannot cover. Thrown before anything is written. */
export class WalletDebitRefused extends Error {
  constructor(
    readonly reason: WalletDebitRefusal,
    readonly requestedCredits: number,
    readonly breakdown: WalletBreakdown,
  ) {
    super(`Wallet debit refused (${reason}): ${requestedCredits} requested`);
    this.name = 'WalletDebitRefused';
  }
}

/** Where a spend priority sits relative to the paid pool (tier 1). */
const SPEND_TIER: Readonly<Record<CampaignCreditSpendPriority, 0 | 2>> = {
  PROMO_FIRST: 0,
  PAID_FIRST: 2,
};

function isSpendable(lot: WalletLot, now: Date) {
  return lot.status === PromoCreditLotStatus.ACTIVE && lot.remainingCredits > 0 && lot.expiresAt > now;
}

/**
 * The canonical waterfall order of promo lots: PROMO_FIRST lots (tier 0)
 * before PAID_FIRST lots (tier 2), each tier earliest-expiring first, equal
 * expiry by id. Ids compare by code unit — the same answer on every database
 * collation. The paid pool (tier 1) sits between the two tiers.
 */
export function compareWaterfall(a: Pick<WalletLot, 'id' | 'expiresAt' | 'spendPriority'>, b: Pick<WalletLot, 'id' | 'expiresAt' | 'spendPriority'>) {
  const tier = SPEND_TIER[a.spendPriority] - SPEND_TIER[b.spendPriority];
  if (tier !== 0) return tier;
  const expiry = a.expiresAt.getTime() - b.expiresAt.getTime();
  if (expiry !== 0) return expiry;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The wallet as a debit sees it: pure. Throws {@link WalletInvariantViolation}
 * when the promo inside the wallet exceeds the balance — a paid pool below
 * zero means some earlier movement was booked against the wrong pool, and no
 * debit may build on that.
 */
export function walletBreakdown(input: { balance: number; lots: readonly WalletLot[]; now: Date; providerId?: string }): WalletBreakdown {
  const walletLots = input.lots.filter((lot) => (WALLET_LOT_STATUSES as readonly PromoCreditLotStatus[]).includes(lot.status));
  const promoInWalletCredits = walletLots.reduce((total, lot) => total + lot.remainingCredits, 0);
  const paidCredits = input.balance - promoInWalletCredits;
  if (paidCredits < 0) {
    throw new WalletInvariantViolation(input.providerId ?? null, input.balance, promoInWalletCredits);
  }
  const spendable = walletLots.filter((lot) => isSpendable(lot, input.now));
  const promoSpendableCredits = spendable.reduce((total, lot) => total + lot.remainingCredits, 0);
  const promoDeductibleCredits = spendable
    .filter((lot) => lot.adminDeductPolicy === CampaignAdminDeductPolicy.ALLOW_PROMO)
    .reduce((total, lot) => total + lot.remainingCredits, 0);
  return {
    balance: input.balance,
    paidCredits,
    promoInWalletCredits,
    promoSpendableCredits,
    promoDeductibleCredits,
    promoProtectedCredits: promoSpendableCredits - promoDeductibleCredits,
    promoUnsweptExpiredCredits: promoInWalletCredits - promoSpendableCredits,
    spendableCredits: paidCredits + promoSpendableCredits,
    deductibleCredits: paidCredits + promoDeductibleCredits,
  };
}

/**
 * Plans one debit through the canonical waterfall, without writing anything:
 *
 *   1. PROMO_FIRST eligible lots (expiresAt ↑, id ↑)
 *   2. the paid pool
 *   3. PAID_FIRST eligible lots (expiresAt ↑, id ↑)
 *
 * Eligible: ACTIVE, something left, not past `expiresAt`; for ADMIN_DEDUCT
 * also `adminDeductPolicy = ALLOW_PROMO`. All or nothing: a debit the
 * eligible sources cannot cover is refused whole.
 */
export function planWalletDebit(input: {
  balance: number;
  lots: readonly WalletLot[];
  amount: number;
  purpose: WalletDebitPurpose;
  now: Date;
  providerId?: string;
}): { ok: true; plan: WalletDebitPlan } | { ok: false; reason: WalletDebitRefusal; breakdown: WalletBreakdown } {
  if (!Number.isInteger(input.amount) || input.amount < 1) {
    throw new Error(`Wallet debit: amount must be a positive integer, got ${input.amount}`);
  }
  const breakdown = walletBreakdown(input);
  if (input.amount > breakdown.balance) {
    return { ok: false, reason: 'INSUFFICIENT_BALANCE', breakdown };
  }
  const isDeduct = input.purpose === PromoConsumptionSource.ADMIN_DEDUCT;
  const available = isDeduct ? breakdown.deductibleCredits : breakdown.spendableCredits;
  if (input.amount > available) {
    return { ok: false, reason: isDeduct ? 'EXCEEDS_DEDUCTIBLE' : 'INSUFFICIENT_SPENDABLE', breakdown };
  }

  const eligible = input.lots
    .filter((lot) => isSpendable(lot, input.now))
    .filter((lot) => !isDeduct || lot.adminDeductPolicy === CampaignAdminDeductPolicy.ALLOW_PROMO)
    .sort(compareWaterfall);

  let outstanding = input.amount;
  const promoShares: WalletDebitShare[] = [];
  const take = (lot: WalletLot) => {
    if (outstanding <= 0) return;
    const credits = Math.min(lot.remainingCredits, outstanding);
    promoShares.push({ lotId: lot.id, credits, exhausts: credits === lot.remainingCredits });
    outstanding -= credits;
  };
  for (const lot of eligible) if (SPEND_TIER[lot.spendPriority] === 0) take(lot);
  const paidShare = Math.min(breakdown.paidCredits, outstanding);
  outstanding -= paidShare;
  for (const lot of eligible) if (SPEND_TIER[lot.spendPriority] === 2) take(lot);

  if (outstanding !== 0) {
    // Unreachable: `available` is exactly the sum of what the loops can take.
    throw new Error('Wallet debit: plan does not cover the amount');
  }
  return { ok: true, plan: { purpose: input.purpose, amount: input.amount, breakdown, promoShares, paidShare } };
}

const walletLotSelect = {
  id: true,
  remainingCredits: true,
  expiresAt: true,
  status: true,
  spendPriority: true,
  adminDeductPolicy: true,
} satisfies Prisma.PromoCreditLotSelect;

/** The provider's wallet lots (ACTIVE/EXHAUSTED), read inside the caller's transaction. */
export async function readWalletLots(db: Tx | { promoCreditLot: Tx['promoCreditLot'] }, providerId: string): Promise<WalletLot[]> {
  return db.promoCreditLot.findMany({
    where: { providerId, status: { in: [...WALLET_LOT_STATUSES] } },
    select: walletLotSelect,
  });
}

/** The provider's wallet split, read the way a debit reads it. */
export async function readWalletBreakdown(tx: Tx, providerId: string, now: Date): Promise<WalletBreakdown> {
  const [balance, lots] = await Promise.all([readWalletBalance(tx, providerId), readWalletLots(tx, providerId)]);
  return walletBreakdown({ balance, lots, now, providerId });
}

/**
 * The one way credit leaves a wallet by debit (CAMPAIGN-CREDIT-POLICY-001):
 * OFFER_SPEND (offer submit and the acceptance recharge) and ADMIN_DEDUCT.
 *
 * Inside the caller's Serializable transaction, in this order: read the
 * balance and every wallet lot; plan through {@link planWalletDebit} (paid
 * below zero → {@link WalletInvariantViolation}; not enough eligible credit →
 * {@link WalletDebitRefused}; either way nothing written); append the one
 * ledger row (`−amount`); then, per promo share, a conditional lot UPDATE and
 * a consumption row naming the ledger row and the purpose. A lot that moved
 * between the read and the write fails its condition and the whole
 * transaction is replayed (P2034) — never half a debit.
 */
export async function debitWallet(
  tx: Tx,
  input: {
    providerId: string;
    amount: number;
    purpose: WalletDebitPurpose;
    now: Date;
    ledger: { reason: string | null; referenceType: string | null; referenceId: string | null; createdById: string | null };
  },
) {
  const [balance, lots] = await Promise.all([readWalletBalance(tx, input.providerId), readWalletLots(tx, input.providerId)]);
  const planned = planWalletDebit({ balance, lots, amount: input.amount, purpose: input.purpose, now: input.now, providerId: input.providerId });
  if (!planned.ok) {
    throw new WalletDebitRefused(planned.reason, input.amount, planned.breakdown);
  }
  const { plan } = planned;

  const transaction = await tx.providerCreditTransaction.create({
    data: {
      providerId: input.providerId,
      // The two purposes are also the two ledger types.
      type: input.purpose === PromoConsumptionSource.ADMIN_DEDUCT ? CreditTransactionType.ADMIN_DEDUCT : CreditTransactionType.OFFER_SPEND,
      amount: -input.amount,
      balanceAfter: balance - input.amount,
      reason: input.ledger.reason,
      referenceType: input.ledger.referenceType,
      referenceId: input.ledger.referenceId,
      createdById: input.ledger.createdById,
    },
  });

  for (const share of plan.promoShares) {
    const updated = await tx.promoCreditLot.updateMany({
      where: {
        id: share.lotId,
        providerId: input.providerId,
        status: PromoCreditLotStatus.ACTIVE,
        remainingCredits: { gte: share.credits },
        expiresAt: { gt: input.now },
      },
      data: {
        remainingCredits: { decrement: share.credits },
        ...(share.exhausts ? { status: PromoCreditLotStatus.EXHAUSTED } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new PromoCreditWriteConflict(`promo lot ${share.lotId}`);
    }
    await tx.promoCreditLotConsumption.create({
      data: {
        lotId: share.lotId,
        creditTransactionId: transaction.id,
        consumedCredits: share.credits,
        consumedAt: input.now,
        source: input.purpose,
      },
      select: { id: true },
    });
  }

  return { transaction, plan };
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
    // An ADMIN_DEDUCT share is final (CHECK) and never belongs to a refund;
    // naming the source keeps it out even if a caller passed the wrong id.
    where: {
      creditTransactionId: input.spendTransactionId,
      status: PromoCreditLotConsumptionStatus.CONSUMED,
      source: PromoConsumptionSource.OFFER_SPEND,
    },
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
    select: {
      providerId: true,
      grantTransactionId: true,
      status: true,
      campaignVersion: { select: { spendPriority: true, adminDeductPolicy: true } },
    },
  });
  if (!redemption || redemption.providerId !== input.providerId) {
    throw new Error(`Promo credit ledger: redemption ${input.redemptionId} does not belong to provider ${input.providerId}`);
  }
  // CAMPAIGN-CREDIT-POLICY-001: the lot carries the policy of the version it
  // is granted under, read here from that version and nowhere else (the
  // database checks the same equality on insert). A version without one
  // grants no credit, so it cannot reach this function legitimately.
  const { spendPriority, adminDeductPolicy } = redemption.campaignVersion;
  if (spendPriority === null || adminDeductPolicy === null) {
    throw new Error(`Promo credit ledger: redemption ${input.redemptionId} was granted under a version without a credit policy`);
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
      spendPriority,
      adminDeductPolicy,
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
