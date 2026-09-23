import type { PackageRefundRequestStatus } from './api';

/**
 * CMP-006 PR-B — the provider-facing wording of a package refund request.
 *
 * Pure, so the rule "nothing here promises money" is testable: the sentence a
 * provider reads after submitting says the request was *sent* and that a
 * refund, *if approved*, goes through the payment provider — never that
 * TakTic has refunded anything, and never a date.
 */

export const PACKAGE_REFUND_SUBMITTED_NOTICE =
  'Talep gönderildi; ödeme iadesi onaylanırsa ödeme sağlayıcısı üzerinden işlenir.';

export const PACKAGE_REFUND_FORM_EXPLANATION =
  'Bu konu yalnızca ödemesi tamamlanmış kredi paketleriniz içindir. Talebiniz destek ekibimiz tarafından ' +
  'incelenir; TakTic hesabınızda otomatik bir para veya kredi hareketi yapılmaz. Ödeme iadesi onaylanırsa ' +
  'ödeme sağlayıcısı üzerinden işlenir.';

export const PACKAGE_REFUND_FALLBACK_HINT =
  'Listede seçilemeyen bir paket için durumunuzu "Genel" konusuyla bize yazabilirsiniz.';

const BADGE: Record<PackageRefundRequestStatus, string> = {
  SUBMITTED: 'badge badge-warn',
  UNDER_REVIEW: 'badge badge-warn',
  APPROVED_PENDING_SETTLEMENT: 'badge badge-warn',
  SETTLED: 'badge badge-good',
  REJECTED: 'badge badge-bad',
  SETTLEMENT_FAILED: 'badge badge-bad',
  WITHDRAWN: 'badge badge-muted',
};

export function packageRefundStatusBadgeClass(status: PackageRefundRequestStatus): string {
  return BADGE[status] ?? 'badge badge-muted';
}

/** The timeline line for a refund transition. The provider never sees who moved it. */
export function packageRefundTimelineText(statusLabel: string): string {
  return `İade talebi: ${statusLabel}`;
}
