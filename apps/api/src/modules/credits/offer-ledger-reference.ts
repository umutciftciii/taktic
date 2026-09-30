/**
 * How a ledger row points at an offer.
 *
 * 'Offer' is the submit-time spend and its refund. 'OfferRecharge'
 * (BUG-OFFER-REFUND-ACCEPT-001) is the charge an acceptance takes for an offer
 * whose credit had been refunded, and the refund of that charge. Both carry
 * the offer's id as `referenceId`; they are separate types only so each charge
 * has its own one-refund partial unique index. Anything that links a row to
 * its offer — a source number, an admin link, an e-mail — treats them alike.
 */
export const OFFER_REFERENCE_TYPE = 'Offer';
export const OFFER_RECHARGE_REFERENCE_TYPE = 'OfferRecharge';

export function isOfferLedgerReference(referenceType: string | null | undefined): boolean {
  return referenceType === OFFER_REFERENCE_TYPE || referenceType === OFFER_RECHARGE_REFERENCE_TYPE;
}
