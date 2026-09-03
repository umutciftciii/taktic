import { OfferEntitlementSource } from '@prisma/client';

export type RefundRecommendedAction = 'FULL_REFUND' | 'NO_REFUND';

/**
 * The one refund the platform performs, and the exact string written into the
 * ledger row's `reason` when it does.
 *
 * Deliberately the bare code with nothing appended: the admin credit ledger
 * renders `reason` verbatim, and a refund's cause is a single fact, not a
 * sentence somebody composed at the call site.
 */
export const UNVIEWED_OFFER_REFUND_REASON = 'UNVIEWED_OFFER_48H';

/** The window, in hours, and the only one. Not configurable — see the module doc. */
export const UNVIEWED_OFFER_REFUND_WINDOW_HOURS = 48;

/**
 * The sentence every provider-facing surface uses for this policy, verbatim.
 *
 * One constant rather than one copy per screen, because the promise is a
 * commercial commitment: a screen that paraphrases it is a screen that promises
 * something the worker does not do.
 */
export const UNVIEWED_OFFER_REFUND_NOTICE =
  'Teklifiniz müşteri tarafından 48 saat içinde görüntülenmezse krediniz otomatik olarak iade edilir.';

/**
 * What the provider panel shows for an offer inside the policy.
 *
 * `null` is not a fourth state — it is what an offer outside the policy gets,
 * and it renders as nothing at all. An offer sold under the previous terms has
 * no standing under this one, and showing it "Görüntülenme bekleniyor" would be
 * promising a refund that will never come.
 */
export type UnviewedRefundPolicyStatus = 'AWAITING_VIEW' | 'VIEWED' | 'REFUNDED';

export const UNVIEWED_REFUND_POLICY_STATUS_LABELS: Record<UnviewedRefundPolicyStatus, string> = {
  AWAITING_VIEW: 'Görüntülenme bekleniyor',
  VIEWED: 'Görüntülendi — iade uygun değil',
  REFUNDED: 'Kredi iade edildi',
};

export type RefundEligibility = {
  eligible: boolean;
  recommendedAction: RefundRecommendedAction;
  reasonCode: string;
  reasonLabel: string;
  details: string;
  hoursSinceSubmitted: number | null;
  /** Whether the 48-hour rule governs this offer at all. */
  unviewedRefundPolicy: boolean;
  /** The provider-facing state, or `null` for an offer outside the policy. */
  policyStatus: UnviewedRefundPolicyStatus | null;
  policyStatusLabel: string | null;
};

type RefundPolicyOffer = {
  viewedAt: Date | string | null;
  submittedAt: Date | string | null;
  creditCost: number;
  creditSpentTransactionId: string | null;
  creditRefundedTransactionId: string | null;
  creditRefundedAt: Date | string | null;
  /**
   * Whether this offer was sold under the 48-hour rule. Absent on a caller that
   * has not selected the column, which is read as `false` — the safe reading,
   * since a missing opt-in must never become a payout.
   */
  unviewedRefundPolicy?: boolean | null;
  /**
   * Which right paid for the offer. NULL on every offer written before
   * entitlements existed, which the migration backfilled to ONE_TIME_CREDIT —
   * so a NULL here is read as the one-time path and nothing changes for them.
   */
  entitlementSource?: OfferEntitlementSource | null;
};

/**
 * The whole refund policy.
 *
 * One rule decides: a credit spent on an offer comes back if, and only if, the
 * authorised customer never opened that offer's detail within 48 hours of it
 * being submitted. Nothing else earns a refund — not a rejection, not an
 * expiry, not a withdrawal, not an admin's opinion — and nothing else blocks
 * one either. An offer's *status* is deliberately not consulted: an unviewed
 * offer that expired unread is exactly the case this policy exists to pay, and
 * a viewed offer is settled no matter how it ended.
 *
 * The two NO_REFUND branches that survive from the previous policy are not
 * exceptions to it: they name offers that never spent a refundable credit at
 * all, so there is nothing to give back.
 */
export function calculateRefundEligibility(offer: RefundPolicyOffer, now = new Date()): RefundEligibility {
  const hoursSinceSubmitted = calculateHoursSinceSubmitted(offer.submittedAt, now);
  const inPolicy = offer.unviewedRefundPolicy === true;
  const refunded = Boolean(offer.creditRefundedTransactionId || offer.creditRefundedAt);
  const viewed = Boolean(offer.viewedAt);

  // Read before anything else so the state a provider sees never depends on the
  // order of the branches below.
  const policyStatus = inPolicy ? resolvePolicyStatus({ refunded, viewed }) : null;

  const result = (
    eligible: boolean,
    recommendedAction: RefundRecommendedAction,
    reasonCode: string,
  ): RefundEligibility => ({
    eligible,
    recommendedAction,
    reasonCode,
    reasonLabel: refundReasonLabel(reasonCode),
    details: REFUND_DETAILS[reasonCode] ?? '',
    hoursSinceSubmitted,
    unviewedRefundPolicy: inPolicy,
    policyStatus,
    policyStatusLabel: policyStatus ? UNVIEWED_REFUND_POLICY_STATUS_LABELS[policyStatus] : null,
  });

  // Checked first, and before the policy gate, because an already-refunded
  // offer is a settled fact for every offer ever written — including the ones
  // an administrator refunded by hand under the previous policy.
  if (refunded) {
    return result(false, 'NO_REFUND', 'ALREADY_REFUNDED');
  }

  // An offer sold under the previous terms. It gets no refund and, on the
  // provider's screens, no policy state at all.
  if (!inPolicy) {
    return result(false, 'NO_REFUND', 'POLICY_NOT_APPLICABLE');
  }

  /*
   * A period package is not refunded, and that is a decision rather than an
   * omission.
   *
   * A monthly quota and an unlimited period are sold as a period, not as a
   * per-offer price: the provider paid once for thirty days, and giving a quota
   * credit back would be topping the period up beyond what was bought — which
   * the database's own `remainingQuota <= quotaCreditsSnapshot` check calls a
   * bug.
   *
   * Checked before the "no credit spend" branch because both are true of a
   * period offer and only this one says anything useful: a provider reading
   * their own panel needs "your package covered it", not "no credit was spent".
   */
  if (offer.entitlementSource && offer.entitlementSource !== OfferEntitlementSource.ONE_TIME_CREDIT) {
    return result(false, 'NO_REFUND', 'PERIOD_PACKAGE_NOT_REFUNDABLE');
  }

  if (!offer.creditSpentTransactionId || offer.creditCost <= 0) {
    return result(false, 'NO_REFUND', 'NO_CREDIT_SPEND');
  }

  if (viewed) {
    return result(false, 'NO_REFUND', 'OFFER_VIEWED');
  }

  if (hoursSinceSubmitted !== null && hoursSinceSubmitted >= UNVIEWED_OFFER_REFUND_WINDOW_HOURS) {
    return result(true, 'FULL_REFUND', UNVIEWED_OFFER_REFUND_REASON);
  }

  return result(false, 'NO_REFUND', 'WAITING_VIEW_WINDOW');
}

export function refundReasonLabel(reasonCode: string) {
  return REFUND_REASON_LABELS[reasonCode] ?? reasonCode;
}

/**
 * The provider-facing state, which answers a narrower question than
 * eligibility does: not "will this be refunded" but "where does this offer
 * stand under the policy right now".
 *
 * An unviewed offer past 48 hours whose refund the worker has not yet written
 * reads as AWAITING_VIEW rather than as a promise already kept. It is the
 * honest reading — no credit has moved, and the customer can still open it in
 * the seconds before the worker runs — and it is the safe one: the panel never
 * claims a payment the ledger cannot show.
 */
function resolvePolicyStatus(offer: { refunded: boolean; viewed: boolean }): UnviewedRefundPolicyStatus {
  if (offer.refunded) {
    return 'REFUNDED';
  }

  if (offer.viewed) {
    return 'VIEWED';
  }

  return 'AWAITING_VIEW';
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

const REFUND_REASON_LABELS: Record<string, string> = {
  ALREADY_REFUNDED: 'Kredi iade edildi',
  POLICY_NOT_APPLICABLE: 'Bu teklif 48 saat iade politikası kapsamında değil',
  NO_CREDIT_SPEND: 'Kredi harcaması yok',
  PERIOD_PACKAGE_NOT_REFUNDABLE: 'Dönemsel pakete ait teklif',
  OFFER_VIEWED: 'Görüntülendi — iade uygun değil',
  [UNVIEWED_OFFER_REFUND_REASON]: '48 saat içinde görüntülenmedi',
  WAITING_VIEW_WINDOW: 'Görüntülenme bekleniyor',
};

const REFUND_DETAILS: Record<string, string> = {
  ALREADY_REFUNDED: 'Bu teklif için kredi iadesi yapıldı.',
  POLICY_NOT_APPLICABLE:
    'Bu teklif, 48 saat içinde görüntülenmeyen tekliflerin otomatik kredi iadesi kuralından önce gönderildi.',
  NO_CREDIT_SPEND: 'Bu teklif için kayıtlı kredi harcaması bulunmuyor.',
  PERIOD_PACKAGE_NOT_REFUNDABLE:
    'Bu teklif aylık kota veya limitsiz paket kapsamında gönderildi. Dönemsel paketlerde teklif başına iade yapılmaz.',
  OFFER_VIEWED: 'Teklifiniz müşteri tarafından görüntülendi; kredi iadesi yapılmaz.',
  [UNVIEWED_OFFER_REFUND_REASON]:
    'Teklifiniz 48 saat içinde görüntülenmedi. Teklif kredisi otomatik olarak iade edilir.',
  // Not the full notice: every provider screen already prints that sentence
  // once, and a detail row repeating it verbatim reads as two promises.
  WAITING_VIEW_WINDOW: '48 saatlik görüntüleme penceresi henüz dolmadı.',
};
