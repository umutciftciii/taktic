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
  'Listede yalnızca şu anda iade talebi oluşturabileceğiniz kredi paketleriniz yer alır. Talebiniz destek ekibimiz tarafından ' +
  'incelenir; TakTic hesabınızda otomatik bir para veya kredi hareketi yapılmaz. Ödeme iadesi onaylanırsa ' +
  'ödeme sağlayıcısı üzerinden işlenir.';

export const PACKAGE_REFUND_FALLBACK_HINT =
  'Listede olmayan bir paket için durumunuzu "Genel destek" türüyle bize yazabilirsiniz.';

export const PACKAGE_REFUND_TEST_ENVIRONMENT_NOTICE = 'Test ortamı — üretim sözleşmesi değildir.';

/** The query value that opens the support form on the refund type (CMP-006 PR-B.1). */
export const PACKAGE_REFUND_REQUEST_TYPE = 'PACKAGE_REFUND';

/** Where "İade talebi oluştur" goes: the support form, on the refund type, with this purchase. */
export function packageRefundRequestHref(purchaseId: string): string {
  const query = new URLSearchParams({ type: PACKAGE_REFUND_REQUEST_TYPE, purchaseId });
  return `/destek/yeni?${query.toString()}`;
}

/**
 * The form's starting point from the URL, checked against the API's own list:
 * the refund type only when the API offers it, and a purchase only when it is
 * one of the listed — the caller's own, requestable — purchases. Anything
 * else in the query (another provider's id, an invented one, a closed flow)
 * is dropped without a word, so the URL can neither reveal nor pre-fill
 * anything that is not already on the caller's list.
 */
export function initialPackageRefundSelection(
  query: { type?: string | string[]; purchaseId?: string | string[] },
  options: { available: boolean; purchases: { id: string }[] } | null,
): { refund: boolean; purchaseId: string } {
  const type = typeof query.type === 'string' ? query.type : '';
  const purchaseId = typeof query.purchaseId === 'string' ? query.purchaseId : '';
  if (!options?.available || type !== PACKAGE_REFUND_REQUEST_TYPE) {
    return { refund: false, purchaseId: '' };
  }
  const listed = options.purchases.some((purchase) => purchase.id === purchaseId);
  return { refund: true, purchaseId: listed ? purchaseId : '' };
}

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
