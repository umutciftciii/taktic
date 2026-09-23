import { PackageRefundRequestStatus, PackagePurchaseKind } from '@prisma/client';
import { resolvePurchaseTermsGate } from '../purchase-terms/purchase-terms.config';
import type { PackageRefundEligibility, PackageRefundReasonCode } from './package-refund-eligibility';

/**
 * CMP-006 PR-B — the rules the refund-request flow shares between its
 * services, its projections and its tests. The database repeats the
 * transition table in `PackageRefundRequest_transition_guard`; this copy is
 * what the service consults first so a refusal comes back as a readable 409
 * rather than a trigger error.
 */

/**
 * Whether the refund-request flow is open at all.
 *
 * Open only when the purchase-terms gate is on *and* its document set is whole
 * (PR-A's `resolvePurchaseTermsGate` throws on a corrupt set; that reads as
 * closed here). Read per call, like the gate itself. Fail-closed: any doubt is
 * "closed".
 */
export function isPackageRefundFlowOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return resolvePurchaseTermsGate(env).enabled;
  } catch {
    return false;
  }
}

/** A purchase may enter the normal flow only if it was bought with evidence. */
export function purchaseCarriesTermsEvidence(purchase: {
  kind: PackagePurchaseKind;
  termsAcceptanceRequired: boolean;
  purchaseTermsAcceptanceId: string | null;
}): boolean {
  return (
    purchase.kind === PackagePurchaseKind.OFFER_PACKAGE &&
    purchase.termsAcceptanceRequired &&
    purchase.purchaseTermsAcceptanceId !== null
  );
}

/**
 * The statuses that hold a purchase's one open request (partial unique index
 * `PackageRefundRequest_one_open_per_purchase`). SETTLEMENT_FAILED is among
 * them: it is an external refund that has not reconciled yet, and a later,
 * proven full refund webhook may still settle it.
 */
export const OPEN_REFUND_STATUSES: readonly PackageRefundRequestStatus[] = [
  PackageRefundRequestStatus.SUBMITTED,
  PackageRefundRequestStatus.UNDER_REVIEW,
  PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT,
  PackageRefundRequestStatus.SETTLEMENT_FAILED,
];

/** The statuses a proven full refund webhook may settle. */
export const SETTLEABLE_STATUSES: readonly PackageRefundRequestStatus[] = [
  PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT,
  PackageRefundRequestStatus.SETTLEMENT_FAILED,
];

/** The provider may withdraw only before an operator has approved anything. */
export const WITHDRAWABLE_STATUSES: readonly PackageRefundRequestStatus[] = [
  PackageRefundRequestStatus.SUBMITTED,
  PackageRefundRequestStatus.UNDER_REVIEW,
];

export const PACKAGE_REFUND_STATUS_LABELS: Record<PackageRefundRequestStatus, string> = {
  SUBMITTED: 'Gönderildi',
  UNDER_REVIEW: 'İnceleniyor',
  REJECTED: 'Reddedildi',
  APPROVED_PENDING_SETTLEMENT: 'Onaylandı, ödeme iadesi bekleniyor',
  SETTLED: 'Ödeme iadesi tamamlandı',
  SETTLEMENT_FAILED: 'Ödeme iadesi tamamlanamadı',
  WITHDRAWN: 'Geri çekildi',
};

/** Reason text lengths the CHECKs enforce, restated for the DTOs. */
export const PACKAGE_REFUND_REASON_MIN = 10;
export const PACKAGE_REFUND_REASON_MAX = 1000;

/**
 * What the provider reads next to a purchase in the picker. Written for the
 * provider, not the operator: it states the rule their purchase meets or does
 * not, never an internal code or a decision.
 */
const PROVIDER_NOTES: Partial<Record<PackageRefundReasonCode, string>> = {
  PURCHASE_ALREADY_REFUNDED: 'Bu satın alma zaten iade edilmiş.',
  PURCHASE_NOT_PAID: 'Bu satın alma ödenmiş durumda değil.',
  PAYMENT_REVERSAL_RECORDED:
    'Bu ödeme için ödeme sağlayıcısından bir iade kaydı zaten alındı.',
  PURCHASE_KIND_NOT_COVERED: 'Bu paket türü kredi paketi iade politikasının kapsamında değil.',
  PACKAGE_TYPE_NOT_COVERED: 'Dönemsel paketler normal iade kapsamında değil.',
  REFUND_WINDOW_EXPIRED: 'Ödemenin üzerinden 14 günden fazla geçti.',
  CREDIT_SPENT_SINCE_PAYMENT: 'Ödemeden sonra hesabınızda teklif kredisi kullanıldı.',
  LINKED_PROMO_CONSUMED: 'Bu paketle gelen promosyon kredisinden kullanıldı.',
};

export function providerEligibilityNotes(eligibility: PackageRefundEligibility): string[] {
  if (eligibility.recommendation === 'REFUNDABLE') {
    return ['Normal iade koşullarını sağlıyor.'];
  }
  return eligibility.blockingCodes
    .map((code) => PROVIDER_NOTES[code])
    .filter((note): note is string => Boolean(note));
}
