import { OfferEntitlementSource, OfferRejectionReason, OfferStatus } from '@prisma/client';

export type RefundRecommendedAction = 'FULL_REFUND' | 'MANUAL_REVIEW' | 'NO_REFUND';

export type RefundEligibility = {
  eligible: boolean;
  recommendedAction: RefundRecommendedAction;
  reasonCode: string;
  reasonLabel: string;
  details: string;
  hoursSinceSubmitted: number | null;
};

export const MANUAL_REFUND_REASON_CODES = [
  'NOT_VIEWED_48H',
  'VIEWED_MANUAL_REVIEW',
  'INVALID_REQUEST',
  'CUSTOMER_UNREACHABLE',
  'DUPLICATE_REQUEST',
  'ADMIN_OVERRIDE',
  'OTHER',
] as const;

export type ManualRefundReasonCode = (typeof MANUAL_REFUND_REASON_CODES)[number];

type RefundPolicyOffer = {
  status: OfferStatus;
  submittedAt: Date | string | null;
  viewedAt: Date | string | null;
  acceptedAt: Date | string | null;
  creditCost: number;
  creditSpentTransactionId: string | null;
  creditRefundedTransactionId: string | null;
  creditRefundedAt: Date | string | null;
  /**
   * Only set when the platform closed the offer automatically. A hand-rejected
   * offer keeps NULL here, which is also what every offer rejected before this
   * field existed carries — so their eligibility is unchanged.
   */
  rejectionReason?: OfferRejectionReason | null;
  /**
   * Which right paid for the offer. NULL on every offer written before
   * entitlements existed, which the migration backfilled to ONE_TIME_CREDIT —
   * so a NULL here is read as the one-time path and nothing changes for them.
   */
  entitlementSource?: OfferEntitlementSource | null;
};

export function calculateRefundEligibility(offer: RefundPolicyOffer, now = new Date()): RefundEligibility {
  const hoursSinceSubmitted = calculateHoursSinceSubmitted(offer.submittedAt, now);

  if (offer.creditRefundedTransactionId || offer.creditRefundedAt) {
    return policyResult(false, 'NO_REFUND', 'ALREADY_REFUNDED', hoursSinceSubmitted);
  }

  /*
   * A period package is not refunded, and that is a decision rather than an
   * omission.
   *
   * A monthly quota and an unlimited period are sold as a period, not as a
   * per-offer price: the provider paid once for thirty days, and giving a quota
   * credit back would be topping the period up beyond what was bought — which
   * the database's own `remainingQuota <= quotaCreditsSnapshot` check calls a
   * bug. Refunds stay what they have always been: a one-time-credit remedy.
   *
   * Checked before the "no credit spend" branch because both are true of a
   * period offer and only this one says anything useful: a provider reading
   * their own panel needs "your package covered it", not "no credit was
   * spent".
   */
  if (
    offer.entitlementSource &&
    offer.entitlementSource !== OfferEntitlementSource.ONE_TIME_CREDIT
  ) {
    return policyResult(false, 'NO_REFUND', 'PERIOD_PACKAGE_NOT_REFUNDABLE', hoursSinceSubmitted);
  }

  if (!offer.creditSpentTransactionId || offer.creditCost <= 0) {
    return policyResult(false, 'NO_REFUND', 'NO_CREDIT_SPEND', hoursSinceSubmitted);
  }

  if (offer.status === OfferStatus.WITHDRAWN || offer.status === OfferStatus.CANCELLED) {
    return policyResult(false, 'NO_REFUND', 'PROVIDER_WITHDRAWN_OR_CANCELLED', hoursSinceSubmitted);
  }

  if (offer.status === OfferStatus.ACCEPTED || offer.acceptedAt) {
    return policyResult(false, 'NO_REFUND', 'OFFER_ACCEPTED', hoursSinceSubmitted);
  }

  // Must come before the viewed / 48-hour branches: the provider delivered a
  // real offer that simply was not selected, so the spend stands no matter how
  // the offer scored on the visibility rules.
  //
  // The reason code deliberately does not echo the COMPETITOR_ACCEPTED enum:
  // this result is rendered in the provider's own panel, which may not disclose
  // that a rival was chosen. The enum stays internal, for admins.
  if (offer.rejectionReason === OfferRejectionReason.COMPETITOR_ACCEPTED) {
    return policyResult(false, 'NO_REFUND', 'OFFER_NOT_SELECTED', hoursSinceSubmitted);
  }

  if (offer.status === OfferStatus.VIEWED || offer.viewedAt) {
    return policyResult(true, 'MANUAL_REVIEW', 'VIEWED_MANUAL_REVIEW', hoursSinceSubmitted);
  }

  if (hoursSinceSubmitted !== null && hoursSinceSubmitted >= 48) {
    return policyResult(true, 'FULL_REFUND', 'NOT_VIEWED_48H', hoursSinceSubmitted);
  }

  return policyResult(false, 'NO_REFUND', 'WAITING_VIEW_WINDOW', hoursSinceSubmitted);
}

export function isManualRefundReasonCode(value: string): value is ManualRefundReasonCode {
  return MANUAL_REFUND_REASON_CODES.includes(value as ManualRefundReasonCode);
}

export function refundReasonLabel(reasonCode: string) {
  return REFUND_REASON_LABELS[reasonCode] ?? reasonCode;
}

function calculateHoursSinceSubmitted(submittedAt: Date | string | null, now: Date) {
  if (!submittedAt) {
    return null;
  }

  const submittedDate = submittedAt instanceof Date ? submittedAt : new Date(submittedAt);
  if (Number.isNaN(submittedDate.getTime())) {
    return null;
  }

  return Math.max(0, Math.floor((now.getTime() - submittedDate.getTime()) / 36_000) / 100);
}

function policyResult(
  eligible: boolean,
  recommendedAction: RefundRecommendedAction,
  reasonCode: string,
  hoursSinceSubmitted: number | null,
): RefundEligibility {
  return {
    eligible,
    recommendedAction,
    reasonCode,
    reasonLabel: refundReasonLabel(reasonCode),
    details: REFUND_DETAILS[reasonCode] ?? '',
    hoursSinceSubmitted,
  };
}

const REFUND_REASON_LABELS: Record<string, string> = {
  ALREADY_REFUNDED: 'Kredi daha önce iade edildi',
  NO_CREDIT_SPEND: 'Kredi harcaması yok',
  PERIOD_PACKAGE_NOT_REFUNDABLE: 'Dönemsel pakete ait teklif',
  PROVIDER_WITHDRAWN_OR_CANCELLED: 'Teklif sağlayıcı tarafından geri çekildi veya iptal edildi',
  OFFER_ACCEPTED: 'Teklif kabul edildi',
  // Deliberately neutral: this label is rendered in the provider's own panel,
  // where nothing about competing offers may be disclosed.
  OFFER_NOT_SELECTED: 'Teklif kabul edilmedi',
  VIEWED_MANUAL_REVIEW: 'Görüntülenen teklif manuel incelenmeli',
  NOT_VIEWED_48H: '48 saat içinde görüntülenmedi',
  WAITING_VIEW_WINDOW: '48 saatlik pencere bekleniyor',
  INVALID_REQUEST: 'Geçersiz talep',
  CUSTOMER_UNREACHABLE: 'Müşteriye ulaşılamıyor',
  DUPLICATE_REQUEST: 'Mükerrer talep',
  ADMIN_OVERRIDE: 'Admin istisnası',
  OTHER: 'Diğer',
};

const REFUND_DETAILS: Record<string, string> = {
  ALREADY_REFUNDED: 'Bu teklif için kredi iadesi zaten yapılmış.',
  NO_CREDIT_SPEND: 'Bu teklif için kayıtlı kredi harcaması bulunmuyor.',
  PERIOD_PACKAGE_NOT_REFUNDABLE:
    'Bu teklif aylık kota veya limitsiz paket kapsamında gönderildi. Dönemsel paketlerde teklif başına iade yapılmaz.',
  PROVIDER_WITHDRAWN_OR_CANCELLED: 'Sağlayıcı tarafından geri çekilen veya iptal edilen tekliflerde otomatik iade önerilmez.',
  OFFER_ACCEPTED: 'Kabul edilmiş tekliflerde kredi iadesi önerilmez.',
  OFFER_NOT_SELECTED: 'Bu talep için teklifiniz kabul edilmedi. Gönderilen teklifin kredisi iade edilmez.',
  VIEWED_MANUAL_REVIEW: 'Müşteri teklifi görüntüledi. İade kararı manuel incelenmeli.',
  NOT_VIEWED_48H: 'Teklif 48 saat içinde görüntülenmedi. Tam iade önerilir.',
  WAITING_VIEW_WINDOW: '48 saatlik görüntüleme penceresi henüz dolmadı.',
};
