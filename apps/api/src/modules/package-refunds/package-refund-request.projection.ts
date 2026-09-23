import { Prisma } from '@prisma/client';
import { PACKAGE_REFUND_STATUS_LABELS, WITHDRAWABLE_STATUSES } from './package-refund-request.rules';

/**
 * CMP-006 PR-B — what a refund request looks like on the wire, per audience.
 *
 * Every select below is an explicit allowlist (the repository's rule for
 * response projections): a column added to PackagePurchase, PaymentWebhookEvent
 * or PurchaseTermsAcceptance later cannot start travelling by itself. What no
 * projection here carries, by construction: the client address, user agent,
 * sentence snapshot or digest of the purchase-terms acceptance; the payment
 * reference, provider order id or checkout id; any webhook event key, payload
 * or signature.
 */

const purchaseSummarySelect = {
  id: true,
  purchaseNumber: true,
  packageNameSnapshot: true,
  creditAmountSnapshot: true,
  priceAmountSnapshot: true,
  currencySnapshot: true,
  paidAt: true,
} satisfies Prisma.PackagePurchaseSelect;

type PurchaseSummaryRow = Prisma.PackagePurchaseGetPayload<{ select: typeof purchaseSummarySelect }>;

function toPurchaseSummary(purchase: PurchaseSummaryRow) {
  return {
    id: purchase.id,
    purchaseNumber: purchase.purchaseNumber,
    packageName: purchase.packageNameSnapshot,
    creditAmount: purchase.creditAmountSnapshot,
    priceAmount: purchase.priceAmountSnapshot,
    currency: purchase.currencySnapshot,
    paidAt: purchase.paidAt ? purchase.paidAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const providerRefundSelect = {
  id: true,
  status: true,
  createdAt: true,
  purchase: { select: purchaseSummarySelect },
} satisfies Prisma.PackageRefundRequestSelect;

type ProviderRefundRow = Prisma.PackageRefundRequestGetPayload<{ select: typeof providerRefundSelect }>;

/**
 * The provider sees the status of their own request and what it is about —
 * never an operator's name, reason, eligibility snapshot or approval kind.
 */
export function toProviderRefundRequest(request: ProviderRefundRow) {
  return {
    id: request.id,
    status: request.status,
    statusLabel: PACKAGE_REFUND_STATUS_LABELS[request.status],
    canWithdraw: WITHDRAWABLE_STATUSES.includes(request.status),
    createdAt: request.createdAt.toISOString(),
    purchase: toPurchaseSummary(request.purchase),
  };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export type RefundTimelineAudience = 'PROVIDER' | 'ADMIN';

export const refundEventSelect = {
  id: true,
  action: true,
  fromStatus: true,
  toStatus: true,
  actorKind: true,
  note: true,
  createdAt: true,
  actor: { select: { id: true, name: true, role: true } },
} satisfies Prisma.PackageRefundRequestEventSelect;

type RefundEventRow = Prisma.PackageRefundRequestEventGetPayload<{ select: typeof refundEventSelect }>;

export function toRefundTimelineEvent(event: RefundEventRow, audience: RefundTimelineAudience) {
  const base = {
    kind: 'PACKAGE_REFUND_EVENT' as const,
    id: event.id,
    action: event.action,
    toStatus: event.toStatus,
    statusLabel: PACKAGE_REFUND_STATUS_LABELS[event.toStatus],
    createdAt: event.createdAt.toISOString(),
  };

  if (audience === 'PROVIDER') {
    return base;
  }

  return {
    ...base,
    fromStatus: event.fromStatus,
    actorKind: event.actorKind,
    actor: event.actor ? { id: event.actor.id, name: event.actor.name } : null,
    note: event.note,
  };
}

// ---------------------------------------------------------------------------
// Operator
// ---------------------------------------------------------------------------

const providerSummarySelect = { id: true, businessName: true } satisfies Prisma.ProviderProfileSelect;
const staffSelect = { id: true, name: true } satisfies Prisma.UserSelect;

export const adminRefundListSelect = {
  id: true,
  status: true,
  origin: true,
  submittedRecommendation: true,
  approvalKind: true,
  exceptionGround: true,
  supportTicketId: true,
  createdAt: true,
  updatedAt: true,
  provider: { select: providerSummarySelect },
  purchase: { select: purchaseSummarySelect },
} satisfies Prisma.PackageRefundRequestSelect;

type AdminRefundListRow = Prisma.PackageRefundRequestGetPayload<{ select: typeof adminRefundListSelect }>;

export function toAdminRefundListItem(request: AdminRefundListRow) {
  return {
    id: request.id,
    status: request.status,
    statusLabel: PACKAGE_REFUND_STATUS_LABELS[request.status],
    origin: request.origin,
    submittedRecommendation: request.submittedRecommendation,
    approvalKind: request.approvalKind,
    exceptionGround: request.exceptionGround,
    supportTicketId: request.supportTicketId,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    provider: { id: request.provider.id, businessName: request.provider.businessName },
    purchase: toPurchaseSummary(request.purchase),
  };
}

export const adminRefundDetailSelect = {
  ...adminRefundListSelect,
  purchaseId: true,
  createdById: true,
  reviewStartedById: true,
  submittedEligibility: true,
  approvalEligibility: true,
  exceptionReason: true,
  rejectionReason: true,
  settlementFailureReason: true,
  reviewStartedAt: true,
  approvedAt: true,
  rejectedAt: true,
  withdrawnAt: true,
  settledAt: true,
  settlementFailedAt: true,
  creditClawbackCredits: true,
  createdBy: { select: { id: true, name: true, role: true } },
  reviewStartedBy: { select: staffSelect },
  approvedBy: { select: staffSelect },
  rejectedBy: { select: staffSelect },
  settlementFailedBy: { select: staffSelect },
  supportTicket: { select: { id: true, subject: true, status: true, topic: true } },
  purchase: {
    select: {
      ...purchaseSummarySelect,
      kind: true,
      status: true,
      refundedAt: true,
      termsAcceptanceRequired: true,
      purchaseTermsAcceptanceId: true,
    },
  },
} satisfies Prisma.PackageRefundRequestSelect;

type AdminRefundDetailRow = Prisma.PackageRefundRequestGetPayload<{ select: typeof adminRefundDetailSelect }>;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function toAdminRefundDetail(
  request: AdminRefundDetailRow,
  events: RefundEventRow[],
  evidence: { documentVersion: string; acceptedAt: Date } | null,
) {
  return {
    ...toAdminRefundListItem(request),
    purchase: {
      ...toPurchaseSummary(request.purchase),
      kind: request.purchase.kind,
      status: request.purchase.status,
      refundedAt: iso(request.purchase.refundedAt),
    },
    supportTicket: request.supportTicket,
    createdBy: request.createdBy,
    reviewStartedBy: request.reviewStartedBy,
    approvedBy: request.approvedBy,
    rejectedBy: request.rejectedBy,
    settlementFailedBy: request.settlementFailedBy,
    submittedEligibility: request.submittedEligibility,
    approvalEligibility: request.approvalEligibility,
    exceptionReason: request.exceptionReason,
    rejectionReason: request.rejectionReason,
    settlementFailureReason: request.settlementFailureReason,
    reviewStartedAt: iso(request.reviewStartedAt),
    approvedAt: iso(request.approvedAt),
    rejectedAt: iso(request.rejectedAt),
    withdrawnAt: iso(request.withdrawnAt),
    settledAt: iso(request.settledAt),
    settledByWebhook: request.settledAt !== null,
    settlementFailedAt: iso(request.settlementFailedAt),
    creditClawbackCredits: request.creditClawbackCredits,
    termsEvidence: evidence
      ? { documentVersion: evidence.documentVersion, acceptedAt: evidence.acceptedAt.toISOString() }
      : null,
    events: events.map((event) => toRefundTimelineEvent(event, 'ADMIN')),
  };
}
