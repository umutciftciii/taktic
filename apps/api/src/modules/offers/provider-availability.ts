import { ConflictException, HttpStatus } from '@nestjs/common';
import { OfferStatus, Prisma, ProviderStatus } from '@prisma/client';
import { CUSTOMER_ACTIONABLE_OFFER_STATUSES } from './offer-transitions';

/**
 * PROVIDER-STATUS-001: an offer whose provider may not take new work.
 *
 * A provider that is not APPROVED — suspended, above all — keeps every offer
 * it ever made: nothing about the offer row, its credit or its `viewedAt` is
 * written when the provider's status changes. What changes is what the
 * customer is shown. An offer that is still a live choice (SUBMITTED, VIEWED,
 * SHORTLISTED) of such a provider is left out of the customer's list,
 * comparison, detail and counters, and cannot be accepted, shortlisted or
 * rejected. Once the provider is approved again the same offers are simply
 * visible again, as far as their round is still open.
 *
 * Decided offers are not hidden: an accepted offer is a job that continues
 * (messaging and the shared contact stay), and a rejected, withdrawn, expired
 * or cancelled one is history the customer already saw closed.
 *
 * The refund policy is untouched. A hidden offer is never stamped viewed —
 * `viewStampableWhere` requires an approved provider — so one the customer had
 * not opened is paid back by the existing unviewed-offer rule when its window
 * ends, and one they had opened keeps its credit spent as before.
 */

/** Machine-readable code for an offer whose provider cannot take work now. */
export const PROVIDER_UNAVAILABLE_CODE = 'PROVIDER_UNAVAILABLE';

/** The statuses that are hidden while their provider is not approved. */
const HIDEABLE_OFFER_STATUSES: readonly OfferStatus[] = CUSTOMER_ACTIONABLE_OFFER_STATUSES;

/**
 * The offers a customer surface may show or count: every decided offer, and
 * the live ones whose provider is approved.
 *
 * Returned as one `OR` to be placed inside an `AND` by the caller — never
 * spread into a `where` that has an `OR` of its own, which would replace it.
 */
export function customerVisibleOfferWhere(): Prisma.OfferWhereInput {
  return {
    OR: [
      { status: { notIn: [...HIDEABLE_OFFER_STATUSES] } },
      { provider: { status: ProviderStatus.APPROVED } },
    ],
  };
}

/** Whether an offer in this status is hidden while its provider is not approved. */
export function isHideableOfferStatus(offerStatus: OfferStatus): boolean {
  return HIDEABLE_OFFER_STATUSES.includes(offerStatus);
}

/** The same rule on rows already read. */
export function isOfferHiddenFromCustomer(offerStatus: OfferStatus, providerStatus: ProviderStatus): boolean {
  return isHideableOfferStatus(offerStatus) && providerStatus !== ProviderStatus.APPROVED;
}

/**
 * The refusal for any per-offer customer route on a hidden offer: the detail,
 * the view and the actions.
 *
 * A 409 rather than a 404 because the customer may hold a link to an offer
 * they saw a moment ago; the web turns the code into one neutral sentence.
 * The message says nothing about why: the provider's status and any reason
 * behind it are not the customer's to read.
 */
export function providerUnavailableException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: PROVIDER_UNAVAILABLE_CODE,
    message: 'Bu teklif şu anda kullanılamıyor.',
  });
}
