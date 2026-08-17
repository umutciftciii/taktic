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

export function providerRefundBadgeClass(action: string): string {
  switch (action) {
    case 'FULL_REFUND':
      return 'pdash-badge pdash-badge-success';
    case 'MANUAL_REVIEW':
      return 'pdash-badge pdash-badge-warn';
    case 'NO_REFUND':
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
