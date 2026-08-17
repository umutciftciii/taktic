import { ConflictException, HttpStatus } from '@nestjs/common';
import { OfferStatus } from '@prisma/client';

/**
 * The states an offer is still in play from.
 *
 * These are exactly the states a provider may withdraw from: the offer is live,
 * nothing terminal has happened to it yet, and no money or match depends on it.
 */
export const WITHDRAWABLE_OFFER_STATUSES = [
  OfferStatus.SUBMITTED,
  OfferStatus.VIEWED,
  OfferStatus.SHORTLISTED,
] as const;

/**
 * States that took the offer out of the customer's hands for good.
 *
 * A customer action (accept, shortlist, reject) must never move an offer out of
 * one of these — which is what makes a provider withdrawal safe against a
 * simultaneous acceptance: whichever transaction commits first, the other finds
 * the row outside its own `where` clause and reaches a business rule instead of
 * writing a second terminal state.
 */
export const CUSTOMER_UNACTIONABLE_OFFER_STATUSES = [
  OfferStatus.WITHDRAWN,
  OfferStatus.CANCELLED,
  OfferStatus.EXPIRED,
] as const;

/** Machine-readable code the web app maps onto a readable refusal. */
export const OFFER_NOT_WITHDRAWABLE_CODE = 'OFFER_NOT_WITHDRAWABLE';

/**
 * One refusal for every reason an offer cannot be withdrawn — already closed,
 * already accepted, or on a request that no longer takes offers.
 *
 * Deliberately undifferentiated: the provider learns that its own offer is no
 * longer live, and nothing about what the customer did or whether a competing
 * offer won.
 */
export function offerNotWithdrawableException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: OFFER_NOT_WITHDRAWABLE_CODE,
    message: 'Bu teklif artık geri çekilemez.',
  });
}
