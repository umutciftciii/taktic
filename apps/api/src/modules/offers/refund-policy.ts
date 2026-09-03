import { OfferEntitlementSource, OfferRefundBlockReason } from '@prisma/client';

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
 * The ledger reason an administrator's hand-made refund carries.
 *
 * Deliberately not {@link UNVIEWED_OFFER_REFUND_REASON}. The two refunds answer
 * different questions — one is the promise the product makes, the other is an
 * operations remedy — and a finance report that cannot separate them cannot say
 * what the policy actually cost. The stored string is
 * `MANUAL_ADMIN_REFUND:<CODE>`; only the prefix is ever rendered to a provider,
 * so the operational code stays inside the admin surfaces.
 */
export const MANUAL_REFUND_REASON_PREFIX = 'MANUAL_ADMIN_REFUND';

/**
 * The operations reasons an administrator may file a manual refund under.
 *
 * A closed list, because a free-text-only reason is a reason nobody can report
 * on. The operator's own words go in the separate note field.
 */
export const MANUAL_REFUND_REASON_CODES = [
  'INVALID_REQUEST',
  'CUSTOMER_UNREACHABLE',
  'DUPLICATE_REQUEST',
  'PLATFORM_ERROR',
  'GOODWILL',
  'OTHER',
] as const;

export type ManualRefundReasonCode = (typeof MANUAL_REFUND_REASON_CODES)[number];

export function isManualRefundReasonCode(value: string): value is ManualRefundReasonCode {
  return MANUAL_REFUND_REASON_CODES.includes(value as ManualRefundReasonCode);
}

/** The ledger string for a manual refund filed under `reasonCode`. */
export function manualRefundStoredReason(reasonCode: ManualRefundReasonCode) {
  return `${MANUAL_REFUND_REASON_PREFIX}:${reasonCode}`;
}

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
export type UnviewedRefundPolicyStatus =
  | 'AWAITING_VIEW'
  | 'VIEWED'
  | 'ADMIN_DECISION'
  | 'REFUNDED';

export const UNVIEWED_REFUND_POLICY_STATUS_LABELS: Record<UnviewedRefundPolicyStatus, string> = {
  AWAITING_VIEW: 'Görüntülenme bekleniyor',
  VIEWED: 'Görüntülendi — iade uygun değil',
  // Not "Görüntülendi": the customer did not open it, an administrator recorded
  // their decision. Saying otherwise would tell a provider something untrue
  // about their own customer.
  ADMIN_DECISION: 'Müşteri kararı kaydedildi — iade uygun değil',
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
   * Set when something other than a customer view closed this offer's
   * eligibility — today only an administrator's accept or reject on the
   * customer's behalf. Read alongside `viewedAt`, never instead of it.
   */
  refundBlockedAt?: Date | string | null;
  refundBlockedReason?: OfferRefundBlockReason | null;
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
 * being submitted. An offer's *status* is deliberately not consulted: an
 * unviewed offer that expired unread is exactly the case this policy exists to
 * pay, and a viewed offer is settled no matter how it ended.
 *
 * One event other than a view also settles it, and carries its own column
 * rather than borrowing `viewedAt`: an administrator accepting or rejecting on
 * the customer's behalf. That is the outcome the provider's credit bought,
 * delivered through a different door — so the credit is spent, while the
 * database still says truthfully that no customer ever opened the offer. Merely
 * *reading* an offer as an admin changes nothing; only a recorded decision
 * does.
 *
 * The two NO_REFUND branches that survive from the previous policy are not
 * exceptions to any of this: they name offers that never spent a refundable
 * credit at all, so there is nothing to give back.
 *
 * This function describes the automatic policy only. An administrator's manual
 * refund is an operations tool that deliberately does not consult it — see
 * OffersService.refundOfferCredit.
 */
export function calculateRefundEligibility(offer: RefundPolicyOffer, now = new Date()): RefundEligibility {
  const hoursSinceSubmitted = calculateHoursSinceSubmitted(offer.submittedAt, now);
  const inPolicy = offer.unviewedRefundPolicy === true;
  const refunded = Boolean(offer.creditRefundedTransactionId || offer.creditRefundedAt);
  const viewed = Boolean(offer.viewedAt);
  const adminDecision = Boolean(offer.refundBlockedAt);

  // Read before anything else so the state a provider sees never depends on the
  // order of the branches below.
  const policyStatus = resolvePolicyStatus({ inPolicy, refunded, viewed, adminDecision });

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

  // After the view branch, so an offer the customer had already opened keeps
  // reading as viewed. A later admin decision on such an offer changes nothing
  // about the outcome and must not change what the provider is told either.
  if (adminDecision) {
    return result(false, 'NO_REFUND', 'ADMIN_CUSTOMER_DECISION');
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
function resolvePolicyStatus(offer: {
  inPolicy: boolean;
  refunded: boolean;
  viewed: boolean;
  adminDecision: boolean;
}): UnviewedRefundPolicyStatus | null {
  // Checked before the policy gate: a refund that happened is a fact about the
  // money, not a promise about the future, so it is reported even for an offer
  // outside the policy — an administrator's manual refund of a legacy offer
  // still shows the provider "Kredi iade edildi".
  if (offer.refunded) {
    return 'REFUNDED';
  }

  // Everything below this line is a statement about what the 48-hour rule will
  // do, and an offer outside the rule has none to make.
  if (!offer.inPolicy) {
    return null;
  }

  if (offer.viewed) {
    return 'VIEWED';
  }

  if (offer.adminDecision) {
    return 'ADMIN_DECISION';
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
  ADMIN_CUSTOMER_DECISION: 'Müşteri kararı kaydedildi — iade uygun değil',
  [MANUAL_REFUND_REASON_PREFIX]: 'Yönetici kredi iadesi',
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
  ADMIN_CUSTOMER_DECISION:
    'Bu teklif için müşteri kararı kaydedildi; kredi iadesi yapılmaz.',
  [UNVIEWED_OFFER_REFUND_REASON]:
    'Teklifiniz 48 saat içinde görüntülenmedi. Teklif kredisi otomatik olarak iade edilir.',
  // Not the full notice: every provider screen already prints that sentence
  // once, and a detail row repeating it verbatim reads as two promises.
  WAITING_VIEW_WINDOW: '48 saatlik görüntüleme penceresi henüz dolmadı.',
};
