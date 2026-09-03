import { BadRequestException, ConflictException, HttpStatus } from '@nestjs/common';
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

/**
 * The offer states an admin may ask for, and the canonical action each one is.
 *
 * The admin screen used to write `Offer.status` directly, which made it a
 * second way to reach states the product otherwise only reaches through a
 * cascade: an acceptance that never matched the request, closed no competing
 * offer, wrote no ContactRevealEvent and mailed nobody; a rejection that
 * skipped the "your offer was not selected" message; a WITHDRAWN that recorded
 * a provider decision the provider never made.
 *
 * So the endpoint no longer writes a status at all. It names one of the three
 * actions the customer path already performs — and which SUPER_ADMIN is already
 * allowed to perform there — and the same service method runs, with the same
 * guards, the same cascade and the same messages.
 *
 * The three that are absent are absent on purpose:
 *
 * - `VIEWED` stamps `viewedAt`, and under the unviewed-offer policy `viewedAt` is the
 *   whole rule: an offer carrying one is never refunded. An admin marking an
 *   offer "seen" would be recording something the customer did not do, and
 *   charging a provider for it.
 * - `WITHDRAWN` is the provider's own decision, taken through the provider
 *   endpoint. Forcing it here would both skip that endpoint's guards and file a
 *   withdrawal against a provider who never withdrew.
 * - `SUBMITTED`, `EXPIRED` and `CANCELLED` have no writer anywhere in the
 *   product. Moving an offer back to SUBMITTED would also strand a MATCHED
 *   request pointing at an offer that is no longer accepted.
 */
export const ADMIN_OFFER_ACTIONS = {
  [OfferStatus.ACCEPTED]: 'ACCEPT',
  [OfferStatus.REJECTED]: 'REJECT',
  [OfferStatus.SHORTLISTED]: 'SHORTLIST',
} as const satisfies Partial<Record<OfferStatus, 'ACCEPT' | 'REJECT' | 'SHORTLIST'>>;

export type AdminSettableOfferStatus = keyof typeof ADMIN_OFFER_ACTIONS;

export function isAdminSettableOfferStatus(
  status: OfferStatus,
): status is AdminSettableOfferStatus {
  return status in ADMIN_OFFER_ACTIONS;
}

/** Machine-readable code the admin app maps onto a readable refusal. */
export const OFFER_STATUS_NOT_SETTABLE_CODE = 'OFFER_STATUS_NOT_SETTABLE';

/**
 * A refusal, never a silent no-op.
 *
 * The caller asked for a state change that has no rule behind it; answering 200
 * with an unchanged offer would let an operator believe they had done something.
 */
export function offerStatusNotSettableException(status: OfferStatus) {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: OFFER_STATUS_NOT_SETTABLE_CODE,
    message: `${status} durumu buradan ayarlanamaz; bu durum kendi akışına aittir.`,
  });
}
