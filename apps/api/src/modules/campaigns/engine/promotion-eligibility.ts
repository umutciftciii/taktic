import type { BusinessRegistrationType, CampaignTrigger } from '@prisma/client';

/**
 * PROVIDER_PROMOTION_ELIGIBLE (CMP-006 PR-C, S0 §7): the one answer the
 * campaign engine asks before an introductory promotion is granted.
 *
 * Deliberately outside the campaign DSL (S0 D17): a risk rule is not a
 * campaign's to write, so no condition, no catalogue entry, nothing an
 * operator can edit per campaign. The engine calls it between the condition
 * filter and the grant, only for the introductory triggers, and only when at
 * least one candidate survived the filter.
 *
 * This file is the pure half — signals in, decision out — so the whole matrix
 * is testable without a database. `PromotionEligibilityReader` gathers the
 * signals.
 *
 * ## The two kinds of "no"
 *
 * INELIGIBLE comes only from a missing *precondition*: no account, not
 * approved, e-mail or phone not proven. That is not a risk judgement but "not
 * yet": the event ends EVALUATED and the next raise of its key reopens it, as
 * every event without a grant always has. A *risk signal* never produces
 * INELIGIBLE on its own — it produces REVIEW, and a person decides.
 *
 * SHARED_IP is weaker still (S0 D18): it never changes the outcome by
 * itself. It is recorded as a reason only when something else already asks
 * for a person.
 */

/** The introductory triggers the gate stands in front of (design note §0). */
export const PROMOTION_GATED_TRIGGERS: ReadonlySet<CampaignTrigger> = new Set<CampaignTrigger>([
  'PROVIDER_APPROVED',
  'PROVIDER_ELIGIBILITY_REACHED',
]);

export const PROMOTION_SNAPSHOT_VERSION = 1;

export type PromotionEligibility = 'ELIGIBLE' | 'REVIEW' | 'INELIGIBLE';

export const PRECONDITION_CODES = ['NO_ACCOUNT', 'PROVIDER_NOT_APPROVED', 'EMAIL_UNVERIFIED', 'PHONE_UNVERIFIED'] as const;
export const REVIEW_CODES = [
  'REGISTRATION_UNSPECIFIED',
  'REGISTRATION_NONE_DECLARED',
  'REGISTRATION_PROMOTION_CONSUMED',
  'REGISTRATION_SHARED',
  'PRIOR_PACKAGE_REFUND',
] as const;
export const CONTRIBUTING_CODES = ['SHARED_IP'] as const;

export type PreconditionCode = (typeof PRECONDITION_CODES)[number];
export type ReviewCode = (typeof REVIEW_CODES)[number];
export type ContributingCode = (typeof CONTRIBUTING_CODES)[number];
export type EligibilitySignalCode = PreconditionCode | ReviewCode | ContributingCode;

/**
 * What the reader found. Counts and ids only; the one network-derived value,
 * `sharedIp.ipFingerprints`, is a versioned HMAC — never an address.
 */
export type PromotionSignals = {
  hasAccount: boolean;
  approved: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
  registration:
    | { status: 'UNSPECIFIED' }
    | { status: 'NONE_DECLARED' }
    | {
        status: 'DECLARED';
        type: BusinessRegistrationType;
        fingerprintVersion: number;
        /** Other providers with a counted grant under the same type + fingerprint + version. */
        promotedProviderIds: string[];
        /** Other providers whose current registration is the same type + fingerprint + version. */
        sharingProviderIds: string[];
      };
  priorRefund: { settledRequests: number; refundedPurchases: number; paymentReversals: number };
  sharedIp: { otherProviderIds: string[]; ipFingerprints: string[] };
};

export type SignalEntry = { code: EligibilitySignalCode } & Record<string, unknown>;

export type PromotionDecision = {
  outcome: PromotionEligibility;
  /** Every code that contributed, in a fixed order — the first is the log's reasonCode. */
  signals: SignalEntry[];
};

export function decidePromotionEligibility(input: PromotionSignals): PromotionDecision {
  const preconditions: SignalEntry[] = [];
  if (!input.hasAccount) preconditions.push({ code: 'NO_ACCOUNT' });
  if (!input.approved) preconditions.push({ code: 'PROVIDER_NOT_APPROVED' });
  if (input.hasAccount && !input.emailVerified) preconditions.push({ code: 'EMAIL_UNVERIFIED' });
  if (input.hasAccount && !input.phoneVerified) preconditions.push({ code: 'PHONE_UNVERIFIED' });
  if (preconditions.length > 0) {
    return { outcome: 'INELIGIBLE', signals: preconditions };
  }

  const review: SignalEntry[] = [];
  const registration = input.registration;
  if (registration.status === 'UNSPECIFIED') {
    review.push({ code: 'REGISTRATION_UNSPECIFIED' });
  } else if (registration.status === 'NONE_DECLARED') {
    review.push({ code: 'REGISTRATION_NONE_DECLARED' });
  } else {
    if (registration.promotedProviderIds.length > 0) {
      review.push({
        code: 'REGISTRATION_PROMOTION_CONSUMED',
        registrationType: registration.type,
        fingerprintVersion: registration.fingerprintVersion,
        otherProviderIds: registration.promotedProviderIds,
      });
    }
    if (registration.sharingProviderIds.length > 0) {
      review.push({
        code: 'REGISTRATION_SHARED',
        registrationType: registration.type,
        fingerprintVersion: registration.fingerprintVersion,
        otherProviderIds: registration.sharingProviderIds,
      });
    }
  }
  const refund = input.priorRefund;
  if (refund.settledRequests + refund.refundedPurchases + refund.paymentReversals > 0) {
    review.push({ code: 'PRIOR_PACKAGE_REFUND', ...refund });
  }

  if (review.length === 0) {
    // SHARED_IP alone never asks for a person (S0 D18).
    return { outcome: 'ELIGIBLE', signals: [] };
  }
  if (input.sharedIp.otherProviderIds.length > 0) {
    review.push({
      code: 'SHARED_IP',
      otherProviderIds: input.sharedIp.otherProviderIds,
      ipFingerprints: input.sharedIp.ipFingerprints,
    });
  }
  return { outcome: 'REVIEW', signals: review };
}
