import {
  OfferPackageType,
  PackagePurchaseKind,
  PackagePurchaseStatus,
} from '@prisma/client';

/**
 * CMP-006 PR-A — the one canonical evaluation of whether a package purchase is
 * refundable under the normal package refund policy (design D1a–c, §3.2).
 *
 * **Not to be confused with** `offers/refund-policy.ts`, which is the offer
 * *credit* refund (an unopened offer's credit coming back). This file is about
 * *money* paid for a credit package, and every name in it is `PackageRefund*`.
 *
 * **Advice, never action.** The result is an input to a human decision and to
 * the future refund-request flow (PR-B). Nothing calls a payment provider,
 * writes a row, moves a credit or reacts to `order_refunded` because of it.
 *
 * **Pure and deterministic.** The function reads only its arguments — the
 * facts, read in one statement by package-refund-eligibility.reader.ts, and an
 * explicit `now` — so the same facts and the same instant always give the same
 * answer, and the reasons always come out in the same order.
 *
 * The rules, in the order they are reported:
 *
 *   applicability  a PAID credit-package purchase whose payment has not already
 *                  been reversed; anything else is NOT_APPLICABLE (nothing to
 *                  refund) or outside this policy (EXCEPTION_ONLY)
 *   window         at most 14 days from `paidAt`, inclusive to the
 *                  millisecond: 14 days and 1 second is expired
 *   credit spend   no OFFER_SPEND on the provider's account at or after
 *                  `paidAt` — paid, promotional or older balance alike (D1b)
 *   linked promo   no credit consumed from a promo lot granted for this
 *                  purchase (D1c); an unused promo lot does not matter
 */

export const PACKAGE_REFUND_WINDOW_DAYS = 14;
export const PACKAGE_REFUND_WINDOW_MS = PACKAGE_REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type PackageRefundReasonCode =
  | 'PURCHASE_NOT_PAID'
  | 'PURCHASE_ALREADY_REFUNDED'
  | 'PAYMENT_REVERSAL_RECORDED'
  | 'PURCHASE_KIND_NOT_COVERED'
  | 'PACKAGE_TYPE_NOT_COVERED'
  | 'WITHIN_REFUND_WINDOW'
  | 'REFUND_WINDOW_EXPIRED'
  | 'NO_CREDIT_SPENT_SINCE_PAYMENT'
  | 'CREDIT_SPENT_SINCE_PAYMENT'
  | 'NO_LINKED_PROMO_CONSUMED'
  | 'LINKED_PROMO_CONSUMED';

/**
 * REFUNDABLE     every rule passes; a normal refund may be approved.
 * EXCEPTION_ONLY the purchase was paid, but at least one rule blocks a normal
 *                refund; only a reviewed exception ground could justify one.
 * NOT_APPLICABLE there is no paid money to refund under this policy (not paid,
 *                already refunded, or a reversal already recorded).
 */
export type PackageRefundRecommendation = 'REFUNDABLE' | 'EXCEPTION_ONLY' | 'NOT_APPLICABLE';

export type PackageRefundReason = {
  code: PackageRefundReasonCode;
  /** True when this reason stands in the way of a normal refund. */
  blocking: boolean;
  /** For the operator, in Turkish. Never shown to the provider as a decision. */
  explanation: string;
};

/** Everything the rules read, and nothing else. */
export type PackageRefundEligibilityFacts = {
  purchaseId: string;
  kind: PackagePurchaseKind;
  status: PackagePurchaseStatus;
  /** Null on a vitrin purchase, which has no offer package. */
  packageType: OfferPackageType | null;
  paidAt: Date | null;
  /** Set by a refund/chargeback webhook (`flagForManualReview`). */
  reversalRecordedAt: Date | null;
  /** OFFER_SPEND rows on the provider's account with createdAt ≥ paidAt. */
  offerSpendCountSincePaid: number;
  firstOfferSpendAtSincePaid: Date | null;
  /** Consumption rows against promo lots granted for this purchase. */
  linkedPromoConsumptionCount: number;
  linkedPromoConsumedCredits: number;
};

export type PackageRefundEligibility = {
  purchaseId: string;
  recommendation: PackageRefundRecommendation;
  /** One sentence for the operator, in Turkish. */
  summary: string;
  /** Every rule that was evaluated, in canonical order. */
  reasons: PackageRefundReason[];
  /** Machine-readable blocking codes, in the same order. */
  blockingCodes: PackageRefundReasonCode[];
  evaluatedAt: string;
  paidAt: string | null;
  /** The last instant a normal refund may be requested; null when unpaid. */
  windowEndsAt: string | null;
  facts: {
    offerSpendCountSincePaid: number;
    firstOfferSpendAtSincePaid: string | null;
    linkedPromoConsumptionCount: number;
    linkedPromoConsumedCredits: number;
  };
};

const EXPLANATIONS: Record<PackageRefundReasonCode, string> = {
  PURCHASE_NOT_PAID:
    'Satın alma ödenmiş durumda değil; iade edilecek bir ödeme yok.',
  PURCHASE_ALREADY_REFUNDED: 'Satın alma zaten iade edilmiş durumda.',
  PAYMENT_REVERSAL_RECORDED:
    'Ödeme sağlayıcısından bu ödeme için bir iade veya ters ibraz bildirimi kaydedilmiş; yeni bir iade çift ödeme olur.',
  PURCHASE_KIND_NOT_COVERED:
    'Bu bir vitrin paketi satın alımı; kredi paketi iade politikası vitrin paketlerini kapsamaz. Yalnız istisna incelemesiyle değerlendirilebilir.',
  PACKAGE_TYPE_NOT_COVERED:
    'Dönemsel (kota/sınırsız) paketler için normal iade kuralı tanımlı değil; kullanım kredi harcamasıyla ölçülemez. Yalnız istisna incelemesiyle değerlendirilebilir.',
  WITHIN_REFUND_WINDOW: `Ödemenin doğrulanmasından bu yana ${PACKAGE_REFUND_WINDOW_DAYS} gün geçmedi.`,
  REFUND_WINDOW_EXPIRED: `Ödemenin doğrulanmasından bu yana ${PACKAGE_REFUND_WINDOW_DAYS} günden fazla geçti.`,
  NO_CREDIT_SPENT_SINCE_PAYMENT:
    'Ödemeden sonra hesapta hiç teklif kredisi harcanmadı.',
  CREDIT_SPENT_SINCE_PAYMENT:
    'Ödemeden sonra hesapta teklif kredisi harcandı; kredinin paketten, promosyondan veya önceki bakiyeden gelmesi fark etmez.',
  NO_LINKED_PROMO_CONSUMED:
    'Bu satın almaya bağlı promosyon kredilerinden hiçbiri kullanılmadı (kullanılmamış promosyon uygunluğu etkilemez).',
  LINKED_PROMO_CONSUMED:
    'Bu satın almaya bağlı promosyon kredilerinden en az biri kullanıldı.',
};

function reason(code: PackageRefundReasonCode, blocking: boolean): PackageRefundReason {
  return { code, blocking, explanation: EXPLANATIONS[code] };
}

export function evaluatePackageRefundEligibility(
  facts: PackageRefundEligibilityFacts,
  now: Date,
): PackageRefundEligibility {
  const reasons: PackageRefundReason[] = [];
  const paidAt = facts.paidAt;

  // Applicability first: without a standing payment there is nothing the
  // other rules could be measured against.
  let applicable = true;
  if (facts.status === PackagePurchaseStatus.REFUNDED) {
    reasons.push(reason('PURCHASE_ALREADY_REFUNDED', true));
    applicable = false;
  } else if (facts.status !== PackagePurchaseStatus.PAID || paidAt === null) {
    reasons.push(reason('PURCHASE_NOT_PAID', true));
    applicable = false;
  } else if (facts.reversalRecordedAt !== null) {
    reasons.push(reason('PAYMENT_REVERSAL_RECORDED', true));
    applicable = false;
  }

  if (!applicable || paidAt === null) {
    return finish(facts, now, 'NOT_APPLICABLE', reasons, null);
  }

  if (facts.kind !== PackagePurchaseKind.OFFER_PACKAGE) {
    reasons.push(reason('PURCHASE_KIND_NOT_COVERED', true));
  } else if (facts.packageType !== OfferPackageType.ONE_TIME_CREDITS) {
    reasons.push(reason('PACKAGE_TYPE_NOT_COVERED', true));
  }

  // Inclusive to the millisecond. A clock that reads earlier than paidAt is
  // inside the window, not before it: the payment has happened.
  const elapsed = now.getTime() - paidAt.getTime();
  reasons.push(
    elapsed <= PACKAGE_REFUND_WINDOW_MS
      ? reason('WITHIN_REFUND_WINDOW', false)
      : reason('REFUND_WINDOW_EXPIRED', true),
  );

  reasons.push(
    facts.offerSpendCountSincePaid > 0
      ? reason('CREDIT_SPENT_SINCE_PAYMENT', true)
      : reason('NO_CREDIT_SPENT_SINCE_PAYMENT', false),
  );

  reasons.push(
    facts.linkedPromoConsumptionCount > 0
      ? reason('LINKED_PROMO_CONSUMED', true)
      : reason('NO_LINKED_PROMO_CONSUMED', false),
  );

  const recommendation = reasons.some((entry) => entry.blocking) ? 'EXCEPTION_ONLY' : 'REFUNDABLE';
  return finish(facts, now, recommendation, reasons, paidAt);
}

function finish(
  facts: PackageRefundEligibilityFacts,
  now: Date,
  recommendation: PackageRefundRecommendation,
  reasons: PackageRefundReason[],
  paidAt: Date | null,
): PackageRefundEligibility {
  const blockingCodes = reasons.filter((entry) => entry.blocking).map((entry) => entry.code);

  return {
    purchaseId: facts.purchaseId,
    recommendation,
    summary: summarise(recommendation, blockingCodes.length),
    reasons,
    blockingCodes,
    evaluatedAt: now.toISOString(),
    paidAt: paidAt ? paidAt.toISOString() : null,
    windowEndsAt: paidAt ? new Date(paidAt.getTime() + PACKAGE_REFUND_WINDOW_MS).toISOString() : null,
    facts: {
      offerSpendCountSincePaid: facts.offerSpendCountSincePaid,
      firstOfferSpendAtSincePaid: facts.firstOfferSpendAtSincePaid
        ? facts.firstOfferSpendAtSincePaid.toISOString()
        : null,
      linkedPromoConsumptionCount: facts.linkedPromoConsumptionCount,
      linkedPromoConsumedCredits: facts.linkedPromoConsumedCredits,
    },
  };
}

function summarise(recommendation: PackageRefundRecommendation, blockingCount: number): string {
  switch (recommendation) {
    case 'REFUNDABLE':
      return 'Normal iade koşullarının tamamı sağlanıyor. Bu yalnız bir tavsiyedir; iade otomatik yapılmaz.';
    case 'EXCEPTION_ONLY':
      return `Normal iade koşullarından ${blockingCount} tanesi sağlanmıyor. İade ancak gerekçeli bir istisna incelemesiyle değerlendirilebilir.`;
    case 'NOT_APPLICABLE':
      return 'Bu satın alma için iade edilebilecek, hâlâ geçerli bir ödeme yok.';
  }
}
