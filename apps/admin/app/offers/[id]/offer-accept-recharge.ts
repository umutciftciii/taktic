/**
 * How much credit accepting this offer charges again, or `null` when it
 * charges nothing (ADMIN-DESTRUCTIVE-CONFIRMATION-001, BUG-OFFER-REFUND-ACCEPT-001).
 *
 * The same test `chargeRefundedOfferOnAcceptInTransaction` makes on the server:
 * an offer whose spend was refunded (`creditRefundedTransactionId`), that cost
 * something, and that has not been charged on acceptance yet. Offers never
 * refunded — the ordinary case — and offers a period package paid for
 * (`creditCost` 0) charge nothing, and the dialog says nothing about credit.
 */
export function offerAcceptRecharge(offer: {
  creditCost: number;
  creditRefundedTransactionId: string | null;
  creditRechargeTransactionId: string | null;
}): number | null {
  if (offer.creditRefundedTransactionId === null) return null;
  if (offer.creditCost <= 0) return null;
  if (offer.creditRechargeTransactionId !== null) return null;
  return offer.creditCost;
}
