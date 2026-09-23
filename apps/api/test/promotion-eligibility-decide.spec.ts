import { describe, expect, it } from 'vitest';
import { decidePromotionEligibility, type PromotionSignals } from '../src/modules/campaigns/engine/promotion-eligibility';

/**
 * PROVIDER_PROMOTION_ELIGIBLE, pure (CMP-006 PR-C design §2.2): every
 * precondition, every REVIEW signal, and the two rules the design binds —
 * no risk signal is ever INELIGIBLE, and a shared address alone changes
 * nothing.
 */

function clean(overrides: Partial<PromotionSignals> = {}): PromotionSignals {
  return {
    hasAccount: true,
    approved: true,
    emailVerified: true,
    phoneVerified: true,
    registration: {
      status: 'DECLARED',
      type: 'TAX_NUMBER',
      fingerprintVersion: 1,
      promotedProviderIds: [],
      sharingProviderIds: [],
    },
    priorRefund: { settledRequests: 0, refundedPurchases: 0, paymentReversals: 0 },
    sharedIp: { otherProviderIds: [], ipFingerprints: [] },
    ...overrides,
  };
}

const codes = (signals: PromotionSignals) => decidePromotionEligibility(signals).signals.map((entry) => entry.code);
const sharedIp = { otherProviderIds: ['other'], ipFingerprints: ['v1:abc'] };

describe('preconditions → INELIGIBLE', () => {
  it('a clean provider is ELIGIBLE with no signal', () => {
    expect(decidePromotionEligibility(clean())).toEqual({ outcome: 'ELIGIBLE', signals: [] });
  });

  it.each([
    [{ hasAccount: false }, ['NO_ACCOUNT']],
    [{ approved: false }, ['PROVIDER_NOT_APPROVED']],
    [{ emailVerified: false }, ['EMAIL_UNVERIFIED']],
    [{ phoneVerified: false }, ['PHONE_UNVERIFIED']],
    [{ emailVerified: false, phoneVerified: false, approved: false }, ['PROVIDER_NOT_APPROVED', 'EMAIL_UNVERIFIED', 'PHONE_UNVERIFIED']],
  ] as const)('%o → INELIGIBLE %o', (overrides, expected) => {
    const decision = decidePromotionEligibility(clean(overrides));
    expect(decision.outcome).toBe('INELIGIBLE');
    expect(decision.signals.map((entry) => entry.code)).toEqual(expected);
  });

  it('a missing precondition wins over every risk signal', () => {
    const decision = decidePromotionEligibility(
      clean({ phoneVerified: false, registration: { status: 'NONE_DECLARED' }, sharedIp }),
    );
    expect(decision).toEqual({ outcome: 'INELIGIBLE', signals: [{ code: 'PHONE_UNVERIFIED' }] });
  });
});

describe('risk signals → REVIEW, never INELIGIBLE', () => {
  it.each([
    [{ registration: { status: 'UNSPECIFIED' } }, 'REGISTRATION_UNSPECIFIED'],
    [{ registration: { status: 'NONE_DECLARED' } }, 'REGISTRATION_NONE_DECLARED'],
    [
      { registration: { status: 'DECLARED', type: 'TAX_NUMBER', fingerprintVersion: 1, promotedProviderIds: ['p2'], sharingProviderIds: [] } },
      'REGISTRATION_PROMOTION_CONSUMED',
    ],
    [
      { registration: { status: 'DECLARED', type: 'MERSIS', fingerprintVersion: 1, promotedProviderIds: [], sharingProviderIds: ['p3'] } },
      'REGISTRATION_SHARED',
    ],
    [{ priorRefund: { settledRequests: 1, refundedPurchases: 0, paymentReversals: 0 } }, 'PRIOR_PACKAGE_REFUND'],
    [{ priorRefund: { settledRequests: 0, refundedPurchases: 1, paymentReversals: 0 } }, 'PRIOR_PACKAGE_REFUND'],
    [{ priorRefund: { settledRequests: 0, refundedPurchases: 0, paymentReversals: 1 } }, 'PRIOR_PACKAGE_REFUND'],
  ] as const)('%o alone → REVIEW with %s', (overrides, code) => {
    const decision = decidePromotionEligibility(clean(overrides as Partial<PromotionSignals>));
    expect(decision.outcome).toBe('REVIEW');
    expect(decision.signals.map((entry) => entry.code)).toEqual([code]);
  });

  it('the consumed-registration reason names the other provider and the type, never a number', () => {
    const decision = decidePromotionEligibility(
      clean({
        registration: { status: 'DECLARED', type: 'SOLE_PROPRIETOR_TR_ID', fingerprintVersion: 1, promotedProviderIds: ['p2'], sharingProviderIds: ['p2'] },
      }),
    );
    expect(decision.signals).toEqual([
      { code: 'REGISTRATION_PROMOTION_CONSUMED', registrationType: 'SOLE_PROPRIETOR_TR_ID', fingerprintVersion: 1, otherProviderIds: ['p2'] },
      { code: 'REGISTRATION_SHARED', registrationType: 'SOLE_PROPRIETOR_TR_ID', fingerprintVersion: 1, otherProviderIds: ['p2'] },
    ]);
  });

  it('every combination of risk signals is REVIEW, however many', () => {
    const decision = decidePromotionEligibility(
      clean({
        registration: { status: 'DECLARED', type: 'TAX_NUMBER', fingerprintVersion: 1, promotedProviderIds: ['a'], sharingProviderIds: ['b'] },
        priorRefund: { settledRequests: 2, refundedPurchases: 1, paymentReversals: 1 },
        sharedIp,
      }),
    );
    expect(decision.outcome).toBe('REVIEW');
  });
});

describe('SHARED_IP (S0 D18)', () => {
  it('alone changes nothing: ELIGIBLE, and not even recorded', () => {
    expect(decidePromotionEligibility(clean({ sharedIp }))).toEqual({ outcome: 'ELIGIBLE', signals: [] });
  });

  it('beside another REVIEW signal it is a recorded reason, fingerprints only', () => {
    expect(codes(clean({ registration: { status: 'NONE_DECLARED' }, sharedIp }))).toEqual(['REGISTRATION_NONE_DECLARED', 'SHARED_IP']);
    const entry = decidePromotionEligibility(clean({ registration: { status: 'NONE_DECLARED' }, sharedIp })).signals[1];
    expect(entry).toEqual({ code: 'SHARED_IP', otherProviderIds: ['other'], ipFingerprints: ['v1:abc'] });
  });
});
