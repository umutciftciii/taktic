import { PackageRefundRequestStatus, PackagePurchaseKind } from '@prisma/client';
import { resolvePurchaseTermsGate } from '../purchase-terms/purchase-terms.config';

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

/**
 * PR-B.1: whether the open flow runs on the TEST document set
 * (`PURCHASE_TERMS_GATE=test`), so the provider's screens can say so. False
 * whenever the flow is closed.
 */
export function isPurchaseTermsTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const gate = resolvePurchaseTermsGate(env);
    return gate.enabled && gate.terms.mode === 'test';
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
