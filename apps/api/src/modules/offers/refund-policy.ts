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

/**
 * The window the platform uses when no operator has chosen one.
 *
 * Not "the" window any more — a super admin sets it from the operations
 * settings screen — but still the answer to every question the setting has not
 * been asked. It is what every offer written before the setting existed was
 * sold under, so an empty settings table and a settings table saying 48 are the
 * same platform.
 */
export const DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS = 48;

/**
 * The bounds an operator may choose between, restated as a CHECK constraint in
 * the migration.
 *
 * Below one hour the promise is not a refund policy, it is a rounding error on
 * the customer's chance to look. Above thirty days a provider cannot plan
 * around it, and the credit is effectively held indefinitely.
 */
export const MIN_UNVIEWED_OFFER_REFUND_WINDOW_HOURS = 1;
export const MAX_UNVIEWED_OFFER_REFUND_WINDOW_HOURS = 720;

/** Whether `value` is a window an operator may save. Whole hours only. */
export function isValidUnviewedOfferRefundWindowHours(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_UNVIEWED_OFFER_REFUND_WINDOW_HOURS &&
    value <= MAX_UNVIEWED_OFFER_REFUND_WINDOW_HOURS
  );
}

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
 * One builder rather than one copy per screen, because the promise is a
 * commercial commitment: a screen that paraphrases it is a screen that promises
 * something the worker does not do.
 *
 * It takes the hours rather than printing 48, and every caller has to say which
 * hours it means. A screen about an offer that exists passes that offer's own
 * snapshot; a screen about the offer a provider is *about* to send passes the
 * current setting. Nothing may pass a constant, because a sentence that says 48
 * while the worker waits 72 is a promise the platform does not keep.
 */
export function unviewedOfferRefundNotice(windowHours: number) {
  return `Teklifiniz müşteri tarafından ${windowHours} saat içinde görüntülenmezse krediniz otomatik olarak iade edilir.`;
}

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
  /** Whether the unviewed-offer refund rule governs this offer at all. */
  unviewedRefundPolicy: boolean;
  /**
   * The window this offer was sold under, in whole hours, and the exact moment
   * its credit becomes refundable — both read from the offer's own snapshot and
   * never from the live setting. `null` for an offer outside the policy, and
   * for the one case an in-policy offer can carry no schedule (see
   * `NO_REFUND_SCHEDULE`).
   *
   * Present here so a provider-facing screen can say "48 saat" or "72 saat"
   * about *this* offer without asking what the setting happens to be today.
   */
  windowHours: number | null;
  eligibleAt: Date | string | null;
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
   * Whether this offer was sold under the unviewed-offer rule. Absent on a caller that
   * has not selected the column, which is read as `false` — the safe reading,
   * since a missing opt-in must never become a payout.
   */
  unviewedRefundPolicy?: boolean | null;
  /**
   * The window and the eligibility moment this offer was created with.
   *
   * `unviewedRefundEligibleAt` is the only clock the policy reads. It is a
   * snapshot, so an administrator changing the setting cannot move an offer
   * that already exists — in either direction — and the worker never has to
   * reconstruct "48 hours after submittedAt" from a constant that is no longer
   * constant.
   */
  unviewedRefundWindowHours?: number | null;
  unviewedRefundEligibleAt?: Date | string | null;
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
 * authorised customer never opened that offer's detail before the offer's own
 * refund moment — `unviewedRefundEligibleAt`, snapshotted when the offer was
 * created from the window then in force. An offer's *status* is deliberately not consulted: an
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
  const windowHours = inPolicy ? (offer.unviewedRefundWindowHours ?? null) : null;
  const eligibleAt = inPolicy ? toDate(offer.unviewedRefundEligibleAt) : null;

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
    reasonLabel: refundReasonLabel(reasonCode, windowHours),
    details: refundDetails(reasonCode, windowHours),
    hoursSinceSubmitted,
    unviewedRefundPolicy: inPolicy,
    windowHours,
    eligibleAt,
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

  /*
   * The offer's own clock, and nothing else.
   *
   * Not "hoursSinceSubmitted >= the current setting": that would let an
   * administrator lowering the window this afternoon pay out on offers sold
   * this morning under a longer one, and raising it withdraw a refund a
   * provider had already earned. The moment was fixed when the offer was
   * created and this only asks whether it has arrived.
   *
   * A missing schedule is never eligible. It cannot occur for an offer created
   * by the current path, and the migration wrote one onto every in-policy offer
   * that predates the column — but "no answer" must read as "do not pay", not
   * as "pay now".
   */
  if (!eligibleAt) {
    return result(false, 'NO_REFUND', 'NO_REFUND_SCHEDULE');
  }

  if (now.getTime() >= eligibleAt.getTime()) {
    return result(true, 'FULL_REFUND', UNVIEWED_OFFER_REFUND_REASON);
  }

  return result(false, 'NO_REFUND', 'WAITING_VIEW_WINDOW');
}

/** A stored timestamp as a Date, or null when there is nothing usable to read. */
function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The label for a refund reason, in the words a provider or an operator reads.
 *
 * `windowHours` is only consulted by the one code that names a duration. It
 * falls back to the product default rather than to a number-free paraphrase,
 * because every offer that can carry this code has a snapshot — the backfilled
 * ones all say 48 — and a label that silently drops the hours would read as a
 * different promise.
 */
export function refundReasonLabel(reasonCode: string, windowHours?: number | null) {
  if (reasonCode === UNVIEWED_OFFER_REFUND_REASON) {
    return `${windowHours ?? DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS} saat içinde görüntülenmedi`;
  }

  return REFUND_REASON_LABELS[reasonCode] ?? reasonCode;
}

/** The sentence under the label, for the codes that have one. */
export function refundDetails(reasonCode: string, windowHours?: number | null) {
  const hours = windowHours ?? DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS;

  if (reasonCode === UNVIEWED_OFFER_REFUND_REASON) {
    return `Teklifiniz ${hours} saat içinde görüntülenmedi. Teklif kredisi otomatik olarak iade edilir.`;
  }

  if (reasonCode === 'WAITING_VIEW_WINDOW') {
    // Not the full notice: every provider screen already prints that sentence
    // once, and a detail row repeating it verbatim reads as two promises.
    return `${hours} saatlik görüntüleme penceresi henüz dolmadı.`;
  }

  return REFUND_DETAILS[reasonCode] ?? '';
}

/**
 * The provider-facing state, which answers a narrower question than
 * eligibility does: not "will this be refunded" but "where does this offer
 * stand under the policy right now".
 *
 * An unviewed offer past its own refund moment whose refund the worker has not
 * yet written
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

  // Everything below this line is a statement about what the refund rule will
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

/**
 * The codes whose wording is fixed. The two that name a duration are not here —
 * they are built from the offer's own window in {@link refundReasonLabel} and
 * {@link refundDetails}, because a hard-coded "48 saat" on a screen about an
 * offer sold at 72 is simply false.
 */
const REFUND_REASON_LABELS: Record<string, string> = {
  ALREADY_REFUNDED: 'Kredi iade edildi',
  POLICY_NOT_APPLICABLE: 'Bu teklif otomatik kredi iade politikası kapsamında değil',
  NO_CREDIT_SPEND: 'Kredi harcaması yok',
  PERIOD_PACKAGE_NOT_REFUNDABLE: 'Dönemsel pakete ait teklif',
  OFFER_VIEWED: 'Görüntülendi — iade uygun değil',
  ADMIN_CUSTOMER_DECISION: 'Müşteri kararı kaydedildi — iade uygun değil',
  // An in-policy offer with no eligibility moment. It should not exist, so the
  // label says what an operator has to know rather than paraphrasing a state.
  NO_REFUND_SCHEDULE: 'İade zamanı kayıtlı değil',
  [MANUAL_REFUND_REASON_PREFIX]: 'Yönetici kredi iadesi',
  WAITING_VIEW_WINDOW: 'Görüntülenme bekleniyor',
};

const REFUND_DETAILS: Record<string, string> = {
  ALREADY_REFUNDED: 'Bu teklif için kredi iadesi yapıldı.',
  POLICY_NOT_APPLICABLE:
    'Bu teklif, görüntülenmeyen tekliflerin otomatik kredi iadesi kuralından önce gönderildi.',
  NO_CREDIT_SPEND: 'Bu teklif için kayıtlı kredi harcaması bulunmuyor.',
  PERIOD_PACKAGE_NOT_REFUNDABLE:
    'Bu teklif aylık kota veya limitsiz paket kapsamında gönderildi. Dönemsel paketlerde teklif başına iade yapılmaz.',
  OFFER_VIEWED: 'Teklifiniz müşteri tarafından görüntülendi; kredi iadesi yapılmaz.',
  ADMIN_CUSTOMER_DECISION:
    'Bu teklif için müşteri kararı kaydedildi; kredi iadesi yapılmaz.',
  NO_REFUND_SCHEDULE:
    'Bu teklif için iade zamanı kayıtlı değil; otomatik iade yapılmaz. Lütfen destek ile iletişime geçin.',
};
