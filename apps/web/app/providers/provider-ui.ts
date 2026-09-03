import { statusLabel } from '../../lib/request-formatters';

/**
 * How an offer's status reads in the provider's own panel.
 *
 * A rejection is always phrased the same way, whether the customer rejected it
 * by hand or the platform closed it because another offer was accepted. The
 * provider is never told that a competitor won, nor how many rivals there were.
 */
export function providerOfferStatusLabel(status: string): string {
  if (status === 'REJECTED') {
    return 'Teklifiniz kabul edilmedi';
  }

  return statusLabel(status);
}

/**
 * The offer states a provider may withdraw from, mirroring
 * WITHDRAWABLE_OFFER_STATUSES on the API side. The API is the authority — it
 * re-checks this inside the transaction — so this exists only to decide whether
 * to render the action at all.
 */
const WITHDRAWABLE_OFFER_STATUSES = ['SUBMITTED', 'VIEWED', 'SHORTLISTED'];

export function isWithdrawableOfferStatus(status: string): boolean {
  return WITHDRAWABLE_OFFER_STATUSES.includes(status);
}

/**
 * Withdrawal also needs the request to still be open. A request that matched,
 * completed, was cancelled or expired has settled its offers, and the provider
 * may not reopen that.
 */
export function canWithdrawOffer(offerStatus: string, requestStatus: string): boolean {
  return isWithdrawableOfferStatus(offerStatus) && requestStatus === 'APPROVED';
}

/**
 * Whether the provider panel's request screen will actually open this request.
 *
 * That screen is served by the discovery route, and discovery only answers for
 * a request that is still taking offers: `getMatchingRequest` refuses anything
 * that is not APPROVED with the same 404 it gives a request outside the
 * provider's categories, deliberately, so a provider cannot probe for requests
 * it may not see. The refusal is right; linking to it regardless was not.
 *
 * Same predicate `canWithdrawOffer` already uses for the request half of its
 * rule, named separately because this is a different question about the same
 * fact — "can this screen be opened", not "may this offer be withdrawn".
 */
export function canOpenRequestDetail(requestStatus: string): boolean {
  return requestStatus === 'APPROVED';
}

export function providerStatusBadgeClass(status: string): string {
  switch (status) {
    case 'APPROVED':
    case 'ACCEPTED':
    case 'PAID':
      return 'pdash-badge pdash-badge-success';
    case 'PENDING_REVIEW':
    case 'PENDING':
    case 'SUBMITTED':
    case 'VIEWED':
    case 'SHORTLISTED':
      return 'pdash-badge pdash-badge-info';
    case 'SUSPENDED':
    case 'WITHDRAWN':
    case 'EXPIRED':
    case 'CANCELLED':
    case 'FAILED':
      return 'pdash-badge pdash-badge-warn';
    case 'REJECTED':
      return 'pdash-badge pdash-badge-danger';
    case 'REFUNDED':
      return 'pdash-badge pdash-badge-muted';
    default:
      return 'pdash-badge pdash-badge-muted';
  }
}

export function providerQualityBadgeClass(label: string): string {
  switch (label) {
    case 'HIGH':
      return 'pdash-badge pdash-badge-success';
    case 'MEDIUM':
      return 'pdash-badge pdash-badge-info';
    case 'LOW':
      return 'pdash-badge pdash-badge-warn';
    default:
      return 'pdash-badge pdash-badge-muted';
  }
}

/**
 * The badge for an offer's standing under the 48-hour refund policy.
 *
 * Keyed on the policy status rather than on a recommended action: a provider
 * reading their own panel wants to know where their credit stands, not what an
 * internal policy engine would recommend. An offer from before the policy
 * carries a `null` status, and its callers render no badge at all rather than
 * asking this function for one.
 */
export function providerRefundBadgeClass(status: string | null): string {
  switch (status) {
    case 'REFUNDED':
      return 'pdash-badge pdash-badge-success';
    case 'AWAITING_VIEW':
      return 'pdash-badge pdash-badge-warn';
    case 'VIEWED':
      return 'pdash-badge pdash-badge-muted';
    default:
      return 'pdash-badge pdash-badge-muted';
  }
}

export function formatBudgetRange(
  min: number | null,
  max: number | null,
  formatPrice: (amount: number) => string,
): string {
  if (min !== null && max !== null) {
    return `${formatPrice(min)} - ${formatPrice(max)}`;
  }
  if (min !== null) return `${formatPrice(min)}+`;
  if (max !== null) return `≤ ${formatPrice(max)}`;
  return '-';
}
