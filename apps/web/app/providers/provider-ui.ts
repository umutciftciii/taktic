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
