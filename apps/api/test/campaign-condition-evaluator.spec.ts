import { describe, expect, it } from 'vitest';
import {
  evaluateConditions,
  type EvaluationFacts,
} from '../src/modules/campaigns/engine/condition-evaluator';
import type { CampaignDefinition } from '../src/modules/campaigns/rules/types';

/**
 * The pure half of rule evaluation: a validated definition and a bag of
 * facts read inside the trigger transaction, and nothing else. Every one of
 * the ten v1 conditions is exercised on both sides, then the group table.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');

function facts(overrides: Partial<EvaluationFacts> = {}): EvaluationFacts {
  return {
    now: NOW,
    approvalTransition: false,
    provider: {
      providerId: 'prov_1',
      userId: 'user_1',
      status: 'APPROVED',
      approvedAt: new Date('2026-09-10T00:00:00.000Z'),
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      hasPriorApprovalRedemption: false,
      hasRevokedRedemption: false,
    },
    ...overrides,
  };
}

function paidPurchase(overrides: Partial<NonNullable<EvaluationFacts['purchase']>> = {}) {
  return {
    purchaseId: 'pur_1',
    kind: 'OFFER_PACKAGE' as const,
    packageSlug: 'baslangic-10',
    packageType: 'ONE_TIME_CREDITS' as const,
    priceAmountSnapshot: 100_000,
    currencySnapshot: 'TRY',
    hasOtherPaidOfferPurchase: false,
    ...overrides,
  };
}

function definition(all: CampaignDefinition['conditions']['all'], trigger = 'PACKAGE_PAYMENT_SUCCEEDED'): CampaignDefinition {
  return {
    schemaVersion: 1,
    trigger,
    conditions: { all },
    benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 30 },
    limits: { maxRedemptionsPerProvider: 1, maxRedemptionsGlobal: null, maxRedemptionsPerDay: null, budgetCredits: null },
    window: { startAt: null, endAt: null },
    stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
    priority: 100,
  };
}

describe('evaluateConditions — each v1 condition', () => {
  it('an empty root passes: the trigger alone is enough', () => {
    expect(evaluateConditions(definition([]), facts())).toEqual({ passed: true });
  });

  it('FIRST_PROVIDER_APPROVAL needs a genuine transition and no earlier approval redemption', () => {
    const rules = definition([{ type: 'FIRST_PROVIDER_APPROVAL' }], 'PROVIDER_APPROVED');
    expect(evaluateConditions(rules, facts({ approvalTransition: true }))).toEqual({ passed: true });
    expect(evaluateConditions(rules, facts({ approvalTransition: false }))).toEqual({
      passed: false,
      failedCondition: 'FIRST_PROVIDER_APPROVAL',
    });
    const withPrior = facts({ approvalTransition: true });
    withPrior.provider.hasPriorApprovalRedemption = true;
    expect(evaluateConditions(rules, withPrior).passed).toBe(false);
  });

  it('EMAIL_VERIFIED and PHONE_VERIFIED read the account proof columns', () => {
    const rules = definition([{ type: 'EMAIL_VERIFIED' }, { type: 'PHONE_VERIFIED' }]);
    expect(evaluateConditions(rules, facts())).toEqual({ passed: false, failedCondition: 'EMAIL_VERIFIED' });
    const emailOnly = facts();
    emailOnly.provider.emailVerifiedAt = NOW;
    expect(evaluateConditions(rules, emailOnly)).toEqual({ passed: false, failedCondition: 'PHONE_VERIFIED' });
    emailOnly.provider.phoneVerifiedAt = NOW;
    expect(evaluateConditions(rules, emailOnly)).toEqual({ passed: true });
  });

  it('FIRST_SUCCESSFUL_PAID_PURCHASE fails when another PAID offer purchase exists or there is no purchase', () => {
    const rules = definition([{ type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' }]);
    expect(evaluateConditions(rules, facts({ purchase: paidPurchase() }))).toEqual({ passed: true });
    expect(evaluateConditions(rules, facts({ purchase: paidPurchase({ hasOtherPaidOfferPurchase: true }) })).passed).toBe(false);
    expect(evaluateConditions(rules, facts()).passed).toBe(false);
  });

  it('PACKAGE_SLUG_IN, PACKAGE_TYPE_IN and PURCHASE_KIND_IN match the purchase snapshot', () => {
    const rules = definition([
      { type: 'PACKAGE_SLUG_IN', slugs: ['baslangic-10', 'pro-50'] },
      { type: 'PACKAGE_TYPE_IN', types: ['ONE_TIME_CREDITS'] },
      { type: 'PURCHASE_KIND_IN', kinds: ['OFFER_PACKAGE'] },
    ]);
    expect(evaluateConditions(rules, facts({ purchase: paidPurchase() }))).toEqual({ passed: true });
    expect(evaluateConditions(rules, facts({ purchase: paidPurchase({ packageSlug: 'baska' }) }))).toEqual({
      passed: false,
      failedCondition: 'PACKAGE_SLUG_IN',
    });
    expect(evaluateConditions(rules, facts({ purchase: paidPurchase({ packageType: 'MONTHLY_QUOTA' }) }))).toEqual({
      passed: false,
      failedCondition: 'PACKAGE_TYPE_IN',
    });
    expect(evaluateConditions(rules, facts({ purchase: paidPurchase({ kind: 'SHOWCASE_PACKAGE', packageSlug: null, packageType: null }) }))).toEqual({
      passed: false,
      failedCondition: 'PACKAGE_SLUG_IN',
    });
  });

  it('MIN_PAID_AMOUNT compares minor units in the stated currency only', () => {
    const rules = definition([{ type: 'MIN_PAID_AMOUNT', minor: 50_000, currency: 'TRY' }]);
    expect(evaluateConditions(rules, facts({ purchase: paidPurchase({ priceAmountSnapshot: 50_000 }) }))).toEqual({ passed: true });
    expect(evaluateConditions(rules, facts({ purchase: paidPurchase({ priceAmountSnapshot: 49_999 }) })).passed).toBe(false);
    expect(evaluateConditions(rules, facts({ purchase: paidPurchase({ currencySnapshot: 'USD' }) })).passed).toBe(false);
  });

  it('NO_PRIOR_REVOCATION fails once the provider has any REVOKED redemption', () => {
    const rules = definition([{ type: 'NO_PRIOR_REVOCATION' }]);
    expect(evaluateConditions(rules, facts())).toEqual({ passed: true });
    const revoked = facts();
    revoked.provider.hasRevokedRedemption = true;
    expect(evaluateConditions(rules, revoked)).toEqual({ passed: false, failedCondition: 'NO_PRIOR_REVOCATION' });
  });

  it('PROVIDER_APPROVED_WITHIN_DAYS measures from approvedAt to now', () => {
    const rules = definition([{ type: 'PROVIDER_APPROVED_WITHIN_DAYS', days: 10 }]);
    expect(evaluateConditions(rules, facts())).toEqual({ passed: true }); // 9 days ago
    const old = facts();
    old.provider.approvedAt = new Date('2026-09-01T00:00:00.000Z');
    expect(evaluateConditions(rules, old).passed).toBe(false);
    const never = facts();
    never.provider.approvedAt = null;
    expect(evaluateConditions(rules, never).passed).toBe(false);
  });

  it('refuses a condition type the catalogue does not know — the definition did not come from the validator', () => {
    expect(() => evaluateConditions(definition([{ type: 'SOMETHING_ELSE' }]), facts())).toThrow(/SOMETHING_ELSE/);
  });
});

describe('evaluateConditions — groups', () => {
  it('an any-group passes when at least one member passes', () => {
    const rules = definition([{ any: [{ type: 'EMAIL_VERIFIED' }, { type: 'PHONE_VERIFIED' }] }]);
    const phoneOnly = facts();
    phoneOnly.provider.phoneVerifiedAt = NOW;
    expect(evaluateConditions(rules, phoneOnly)).toEqual({ passed: true });
    expect(evaluateConditions(rules, facts())).toEqual({ passed: false, failedCondition: 'any' });
  });

  it('the root is an AND: the first failing entry names the outcome', () => {
    const rules = definition([
      { type: 'NO_PRIOR_REVOCATION' },
      { any: [{ type: 'EMAIL_VERIFIED' }, { type: 'PHONE_VERIFIED' }] },
      { type: 'MIN_PAID_AMOUNT', minor: 100, currency: 'TRY' },
    ]);
    const proven = facts({ purchase: paidPurchase() });
    proven.provider.emailVerifiedAt = NOW;
    expect(evaluateConditions(rules, proven)).toEqual({ passed: true });
    expect(evaluateConditions(rules, facts({ purchase: paidPurchase() }))).toEqual({ passed: false, failedCondition: 'any' });
  });
});
