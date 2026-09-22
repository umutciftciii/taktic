import { CreditTransactionType, Prisma, PromoCreditLotConsumptionStatus, type PrismaClient } from '@prisma/client';

/**
 * The one figure a refund is reported as (CMP-004 S4).
 *
 * An offer refund writes its OFFER_REFUND row for the whole credit cost —
 * unchanged since before promotions existed — and then, for whatever share
 * of that cost a promo lot had paid, either puts the share back into the lot
 * (the wallet keeps the refund) or forfeits it again through a
 * CAMPAIGN_EXPIRE / CAMPAIGN_REVOKE row (the wallet gives that part back
 * because the promotion is dead). The provider must be told the net of all
 * of that, and every surface that tells them — the API response, the e-mail,
 * the offer history on the web — must say the same number.
 *
 * So the number is produced by one function from the rows the refund wrote,
 * and re-read later by *exact reference*: the consumption rows that name
 * this refund (`PromoCreditLotConsumption.refundTransactionId`) and the
 * forfeit rows those consumptions name (`forfeitTransactionId`). Nothing
 * here searches the ledger by provider, type or time.
 */
export type OfferRefundSettlement = {
  refundTransactionId: string;
  /** The OFFER_REFUND row's amount: the whole credit cost, as always. */
  grossCredits: number;
  /** Promo credit that went back into a lot that is still valid. */
  promoRestoredCredits: number;
  /** Promo credit taken out of the wallet again because its lot had died. */
  promoForfeitedCredits: { expired: number; revoked: number; total: number };
  /** What the wallet actually gained: gross minus forfeits. */
  netCredits: number;
  balanceBefore: number;
  /** The wallet after the last row this refund wrote. */
  balanceAfter: number;
};

export type RefundRowForSettlement = { id: string; amount: number; balanceAfter: number };

export type SettledShareForSettlement = {
  status: PromoCreditLotConsumptionStatus | `${PromoCreditLotConsumptionStatus}`;
  refundedCredits: number;
  forfeitedCredits: number;
  forfeitTransaction: {
    id: string;
    type: CreditTransactionType | `${CreditTransactionType}`;
    balanceAfter: number;
    createdAt: Date;
  } | null;
};

/** Pure: the settlement of one refund from its row and its settled shares. */
export function summarizeOfferRefundSettlement(
  refund: RefundRowForSettlement,
  shares: readonly SettledShareForSettlement[],
): OfferRefundSettlement {
  let restored = 0;
  let expired = 0;
  let revoked = 0;
  let last: { balanceAfter: number; createdAt: Date; id: string } | null = null;

  for (const share of shares) {
    if (share.status === PromoCreditLotConsumptionStatus.REFUNDED) {
      restored += share.refundedCredits;
      continue;
    }
    if (share.status !== PromoCreditLotConsumptionStatus.FORFEITED || !share.forfeitTransaction) {
      // A share still CONSUMED belongs to no refund; a FORFEITED share always
      // names its row (CHECK), so this branch only skips foreign rows.
      continue;
    }
    if (share.forfeitTransaction.type === CreditTransactionType.CAMPAIGN_REVOKE) {
      revoked += share.forfeitedCredits;
    } else {
      expired += share.forfeitedCredits;
    }
    // The forfeit rows were appended after the refund row, in the ledger's
    // own order; the last of them holds the wallet as this refund left it.
    const row = share.forfeitTransaction;
    if (
      !last ||
      row.createdAt > last.createdAt ||
      (row.createdAt.getTime() === last.createdAt.getTime() && row.id > last.id)
    ) {
      last = row;
    }
  }

  const total = expired + revoked;
  return {
    refundTransactionId: refund.id,
    grossCredits: refund.amount,
    promoRestoredCredits: restored,
    promoForfeitedCredits: { expired, revoked, total },
    netCredits: refund.amount - total,
    balanceBefore: refund.balanceAfter - refund.amount,
    balanceAfter: last ? last.balanceAfter : refund.balanceAfter,
  };
}

const settlementSelect = {
  id: true,
  amount: true,
  balanceAfter: true,
  promoConsumptionsAsRefund: {
    select: {
      status: true,
      refundedCredits: true,
      forfeitedCredits: true,
      forfeitTransaction: { select: { id: true, type: true, balanceAfter: true, createdAt: true } },
    },
  },
} satisfies Prisma.ProviderCreditTransactionSelect;

/**
 * The settlements of the given OFFER_REFUND rows, by refund id. Ids that
 * name no refund row are simply absent — a caller that asks about a spend
 * row, or an id that never existed, gets no invented figure.
 */
export async function readOfferRefundSettlements(
  db: PrismaClient | Prisma.TransactionClient,
  refundTransactionIds: readonly string[],
): Promise<Map<string, OfferRefundSettlement>> {
  const ids = Array.from(new Set(refundTransactionIds)).filter((id) => id.length > 0);
  const result = new Map<string, OfferRefundSettlement>();
  if (ids.length === 0) {
    return result;
  }

  const rows = await db.providerCreditTransaction.findMany({
    where: { id: { in: ids }, type: CreditTransactionType.OFFER_REFUND },
    select: settlementSelect,
  });
  for (const row of rows) {
    result.set(row.id, summarizeOfferRefundSettlement(row, row.promoConsumptionsAsRefund));
  }
  return result;
}
