import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_RULE_ERROR_CODES,
  type CampaignRuleErrorCode,
} from '../src/modules/campaigns/rules/errors';
import {
  collectPackageSlugs,
  validateCampaignDefinition,
} from '../src/modules/campaigns/rules/validator';

/**
 * CMP-002 S0 — the safe rule DSL, as a pure function.
 *
 * Every error code in the closed catalogue has at least one case here, and
 * every accepted shape is one CMP-001 §7 named. Nothing in this file touches a
 * database: the one lookup the validator cannot do on its own — whether a
 * package slug exists — is handed in as a set.
 */

const K2_PACKAGE_BONUS = {
  schemaVersion: 1,
  trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
  conditions: {
    all: [
      { type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' },
      { type: 'PURCHASE_KIND_IN', kinds: ['OFFER_PACKAGE'] },
      { type: 'MIN_PAID_AMOUNT', minor: 10000, currency: 'TRY' },
      { type: 'NO_PRIOR_REVOCATION' },
    ],
  },
  benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 30 },
  limits: {
    maxRedemptionsPerProvider: 1,
    maxRedemptionsGlobal: 1000,
    maxRedemptionsPerDay: null,
    budgetCredits: 10000,
  },
  window: { startAt: '2026-10-01T00:00:00Z', endAt: null },
  stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
  priority: 100,
};

const K1_ELIGIBILITY = {
  schemaVersion: 1,
  trigger: 'PROVIDER_ELIGIBILITY_REACHED',
  eligibility: { facts: ['PHONE_VERIFIED', 'PROVIDER_APPROVED', 'EMAIL_VERIFIED'] },
  conditions: { all: [{ type: 'NO_PRIOR_REVOCATION' }] },
  benefit: { type: 'PROMO_CREDITS', credits: 5, expiresInDays: 14 },
  limits: {
    maxRedemptionsPerProvider: 1,
    maxRedemptionsGlobal: null,
    maxRedemptionsPerDay: null,
    budgetCredits: null,
  },
  window: { startAt: null, endAt: null },
  stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
  priority: 100,
};

const FIRST_APPROVAL = {
  schemaVersion: 1,
  trigger: 'PROVIDER_APPROVED',
  conditions: { all: [{ type: 'FIRST_PROVIDER_APPROVAL' }] },
  benefit: { type: 'PROMO_CREDITS', credits: 3, expiresInDays: 7 },
  limits: { maxRedemptionsPerProvider: 1 },
  window: {},
  stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
  priority: 1,
};

function withConditions(base: typeof K2_PACKAGE_BONUS, all: unknown[]) {
  return { ...base, conditions: { all } };
}

function codesOf(input: unknown, knownPackageSlugs?: ReadonlySet<string>) {
  const result = validateCampaignDefinition(input, { knownPackageSlugs });
  if (result.ok) {
    return [];
  }
  return result.errors.map((error) => `${error.code}@${error.path}`);
}

function expectCode(input: unknown, code: CampaignRuleErrorCode, path?: string) {
  const result = validateCampaignDefinition(input);
  expect(result.ok, `expected ${code}, got an accepted definition`).toBe(false);
  if (result.ok) return;
  const hit = result.errors.find((error) => error.code === code);
  expect(hit, `expected ${code} in ${JSON.stringify(result.errors)}`).toBeDefined();
  if (path !== undefined) {
    expect(hit!.path).toBe(path);
  }
  // Every error carries a human sentence, and no error leaks anything but the
  // path, the code and that sentence.
  for (const error of result.errors) {
    expect(Object.keys(error).sort()).toEqual(['code', 'message', 'path']);
    expect(error.message.length).toBeGreaterThan(0);
    expect(CAMPAIGN_RULE_ERROR_CODES).toContain(error.code);
  }
}

describe('accepted definitions', () => {
  it('accepts the K2 package bonus and normalises it', () => {
    const result = validateCampaignDefinition(K2_PACKAGE_BONUS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition).toEqual(K2_PACKAGE_BONUS);
    expect(result.summary).toEqual({
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      factSetKey: null,
      eligibilityFacts: [],
      conditionCount: 4,
      benefitCredits: 10,
      benefitExpiresInDays: 30,
    });
  });

  it('accepts the K1 eligibility campaign with facts in canonical order and a fact set key', () => {
    const result = validateCampaignDefinition(K1_ELIGIBILITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.eligibility).toEqual({
      facts: ['EMAIL_VERIFIED', 'PHONE_VERIFIED', 'PROVIDER_APPROVED'],
    });
    expect(result.summary.factSetKey).toBe('EMAIL_VERIFIED+PHONE_VERIFIED+PROVIDER_APPROVED');
    expect(result.summary.eligibilityFacts).toEqual([
      'EMAIL_VERIFIED',
      'PHONE_VERIFIED',
      'PROVIDER_APPROVED',
    ]);
  });

  it('fills optional limits and window with explicit nulls', () => {
    const result = validateCampaignDefinition(FIRST_APPROVAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.limits).toEqual({
      maxRedemptionsPerProvider: 1,
      maxRedemptionsGlobal: null,
      maxRedemptionsPerDay: null,
      budgetCredits: null,
    });
    expect(result.definition.window).toEqual({ startAt: null, endAt: null });
    expect(result.definition.eligibility).toBeUndefined();
  });

  it('accepts an empty root group: the trigger alone is the rule', () => {
    expect(codesOf(withConditions(K2_PACKAGE_BONUS, []))).toEqual([]);
  });

  it('accepts one level of any inside all', () => {
    const input = withConditions(K2_PACKAGE_BONUS, [
      { type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' },
      {
        any: [
          { type: 'PACKAGE_TYPE_IN', types: ['MONTHLY_QUOTA'] },
          { type: 'MIN_PAID_AMOUNT', minor: 50000, currency: 'TRY' },
        ],
      },
    ]);
    expect(codesOf(input)).toEqual([]);
  });

  it('accepts package slugs that exist in the catalogue', () => {
    const input = withConditions(K2_PACKAGE_BONUS, [
      { type: 'PACKAGE_SLUG_IN', slugs: ['baslangic-10', 'pro-50'] },
    ]);
    expect(codesOf(input, new Set(['baslangic-10', 'pro-50', 'other']))).toEqual([]);
    expect(collectPackageSlugs(input)).toEqual(['baslangic-10', 'pro-50']);
  });

  it('is deterministic: the same input normalises to the same output', () => {
    const a = validateCampaignDefinition(K1_ELIGIBILITY);
    const b = validateCampaignDefinition(JSON.parse(JSON.stringify(K1_ELIGIBILITY)));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('shape and version', () => {
  it('rejects a non-object', () => {
    expectCode(null, 'SCHEMA_INVALID', '');
    expectCode('{}', 'SCHEMA_INVALID', '');
    expectCode([], 'SCHEMA_INVALID', '');
  });

  it('rejects a missing or foreign schema version', () => {
    expectCode({ ...K2_PACKAGE_BONUS, schemaVersion: 2 }, 'UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion');
    expectCode({ ...K2_PACKAGE_BONUS, schemaVersion: '1' }, 'UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion');
    const { schemaVersion: _omit, ...withoutVersion } = K2_PACKAGE_BONUS;
    expectCode(withoutVersion, 'UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion');
  });

  it('rejects unknown top-level fields — there is no escape hatch', () => {
    expectCode({ ...K2_PACKAGE_BONUS, script: 'return true' }, 'UNKNOWN_FIELD', 'script');
    expectCode({ ...K2_PACKAGE_BONUS, webhookUrl: 'https://x' }, 'UNKNOWN_FIELD', 'webhookUrl');
    expectCode({ ...K2_PACKAGE_BONUS, filter: { sql: '1=1' } }, 'UNKNOWN_FIELD', 'filter');
  });

  it('rejects a missing conditions root or a root that is not an all-array', () => {
    const { conditions: _omit, ...withoutConditions } = K2_PACKAGE_BONUS;
    expectCode(withoutConditions, 'SCHEMA_INVALID', 'conditions');
    expectCode({ ...K2_PACKAGE_BONUS, conditions: { any: [] } }, 'SCHEMA_INVALID', 'conditions.all');
    expectCode({ ...K2_PACKAGE_BONUS, conditions: { all: {} } }, 'SCHEMA_INVALID', 'conditions.all');
    expectCode(
      { ...K2_PACKAGE_BONUS, conditions: { all: [], any: [] } },
      'UNKNOWN_FIELD',
      'conditions.any',
    );
  });
});

describe('triggers and eligibility', () => {
  it('rejects a trigger outside the catalogue', () => {
    expectCode({ ...K2_PACKAGE_BONUS, trigger: 'INACTIVITY_30_DAYS' }, 'UNKNOWN_TRIGGER', 'trigger');
    expectCode({ ...K2_PACKAGE_BONUS, trigger: 'COUPON_ENTERED' }, 'UNKNOWN_TRIGGER', 'trigger');
    expectCode({ ...K2_PACKAGE_BONUS, trigger: null }, 'UNKNOWN_TRIGGER', 'trigger');
  });

  it('requires eligibility on the eligibility trigger and forbids it elsewhere', () => {
    const { eligibility: _omit, ...withoutFacts } = K1_ELIGIBILITY;
    expectCode(withoutFacts, 'ELIGIBILITY_REQUIRED', 'eligibility');
    expectCode(
      { ...K2_PACKAGE_BONUS, eligibility: { facts: ['EMAIL_VERIFIED', 'PHONE_VERIFIED'] } },
      'ELIGIBILITY_NOT_ALLOWED',
      'eligibility',
    );
  });

  it('rejects unknown, duplicate and too few facts', () => {
    expectCode(
      { ...K1_ELIGIBILITY, eligibility: { facts: ['PROVIDER_APPROVED', 'TAX_NUMBER_SET'] } },
      'UNKNOWN_FACT',
      'eligibility.facts[1]',
    );
    expectCode(
      { ...K1_ELIGIBILITY, eligibility: { facts: ['EMAIL_VERIFIED', 'EMAIL_VERIFIED'] } },
      'DUPLICATE_FACT',
      'eligibility.facts[1]',
    );
    expectCode(
      { ...K1_ELIGIBILITY, eligibility: { facts: ['EMAIL_VERIFIED'] } },
      'FACT_SET_SIZE',
      'eligibility.facts',
    );
    expectCode({ ...K1_ELIGIBILITY, eligibility: { facts: [] } }, 'FACT_SET_SIZE', 'eligibility.facts');
    expectCode({ ...K1_ELIGIBILITY, eligibility: {} }, 'SCHEMA_INVALID', 'eligibility.facts');
    expectCode(
      { ...K1_ELIGIBILITY, eligibility: { facts: ['EMAIL_VERIFIED', 'PHONE_VERIFIED'], extra: 1 } },
      'UNKNOWN_FIELD',
      'eligibility.extra',
    );
  });
});

describe('conditions', () => {
  it('rejects a condition type outside the catalogue', () => {
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'PROVIDER_CITY_IN', cities: ['İstanbul'] }]),
      'UNKNOWN_CONDITION',
      'conditions.all[0]',
    );
    expectCode(withConditions(K2_PACKAGE_BONUS, [{ expr: 'a > b' }]), 'UNKNOWN_CONDITION', 'conditions.all[0]');
    expectCode(withConditions(K2_PACKAGE_BONUS, ['FIRST_SUCCESSFUL_PAID_PURCHASE']), 'SCHEMA_INVALID', 'conditions.all[0]');
  });

  it('rejects a condition that does not belong to the trigger', () => {
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'FIRST_PROVIDER_APPROVAL' }]),
      'CONDITION_TRIGGER_MISMATCH',
      'conditions.all[0]',
    );
    expectCode(
      { ...FIRST_APPROVAL, conditions: { all: [{ type: 'MIN_PAID_AMOUNT', minor: 100, currency: 'TRY' }] } },
      'CONDITION_TRIGGER_MISMATCH',
      'conditions.all[0]',
    );
    expectCode(
      { ...K1_ELIGIBILITY, conditions: { all: [{ type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' }] } },
      'CONDITION_TRIGGER_MISMATCH',
      'conditions.all[0]',
    );
  });

  it('refuses the K1 timing mistake: proof conditions on the approval event', () => {
    expectCode(
      { ...FIRST_APPROVAL, conditions: { all: [{ type: 'EMAIL_VERIFIED' }] } },
      'USE_ELIGIBILITY_TRIGGER',
      'conditions.all[0]',
    );
    expectCode(
      { ...FIRST_APPROVAL, conditions: { all: [{ any: [{ type: 'PHONE_VERIFIED' }, { type: 'NO_PRIOR_REVOCATION' }] }] } },
      'USE_ELIGIBILITY_TRIGGER',
      'conditions.all[0].any[0]',
    );
  });

  it('rejects a proof condition that repeats a fact already in the eligibility set', () => {
    expectCode(
      { ...K1_ELIGIBILITY, conditions: { all: [{ type: 'EMAIL_VERIFIED' }] } },
      'DUPLICATE_CONDITION',
      'conditions.all[0]',
    );
  });

  it('rejects nesting deeper than one any inside all', () => {
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ any: [{ any: [{ type: 'NO_PRIOR_REVOCATION' }] }] }]),
      'GROUP_DEPTH_EXCEEDED',
      'conditions.all[0].any[0]',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ any: [{ all: [{ type: 'NO_PRIOR_REVOCATION' }] }] }]),
      'GROUP_DEPTH_EXCEEDED',
      'conditions.all[0].any[0]',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ all: [{ type: 'NO_PRIOR_REVOCATION' }] }]),
      'GROUP_DEPTH_EXCEEDED',
      'conditions.all[0]',
    );
  });

  it('rejects an empty any group and a malformed group', () => {
    expectCode(withConditions(K2_PACKAGE_BONUS, [{ any: [] }]), 'GROUP_EMPTY', 'conditions.all[0].any');
    expectCode(withConditions(K2_PACKAGE_BONUS, [{ any: 'x' }]), 'SCHEMA_INVALID', 'conditions.all[0].any');
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ any: [{ type: 'NO_PRIOR_REVOCATION' }], not: true }]),
      'UNKNOWN_FIELD',
      'conditions.all[0].not',
    );
  });

  it('rejects groups over the size cap', () => {
    const tooManyAll = Array.from({ length: 17 }, (_, i) => ({
      type: 'MIN_PAID_AMOUNT',
      minor: 100 + i,
      currency: 'TRY',
    }));
    expectCode(withConditions(K2_PACKAGE_BONUS, tooManyAll), 'GROUP_SIZE_EXCEEDED', 'conditions.all');
    const tooManyAny = Array.from({ length: 9 }, (_, i) => ({
      type: 'MIN_PAID_AMOUNT',
      minor: 100 + i,
      currency: 'TRY',
    }));
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ any: tooManyAny }]),
      'GROUP_SIZE_EXCEEDED',
      'conditions.all[0].any',
    );
  });

  it('rejects the same condition twice in a group, in all and any, or contradicting itself', () => {
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'NO_PRIOR_REVOCATION' }, { type: 'NO_PRIOR_REVOCATION' }]),
      'DUPLICATE_CONDITION',
      'conditions.all[1]',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [
        { type: 'MIN_PAID_AMOUNT', minor: 1000, currency: 'TRY' },
        { type: 'MIN_PAID_AMOUNT', minor: 5000, currency: 'TRY' },
      ]),
      'DUPLICATE_CONDITION',
      'conditions.all[1]',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [
        { type: 'PACKAGE_TYPE_IN', types: ['MONTHLY_QUOTA'] },
        { any: [{ type: 'PACKAGE_TYPE_IN', types: ['ONE_TIME_CREDITS'] }, { type: 'NO_PRIOR_REVOCATION' }] },
      ]),
      'DUPLICATE_CONDITION',
      'conditions.all[1].any[0]',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [
        { any: [{ type: 'PACKAGE_TYPE_IN', types: ['ONE_TIME_CREDITS'] }, { type: 'PACKAGE_TYPE_IN', types: ['MONTHLY_QUOTA'] }] },
      ]),
      'DUPLICATE_CONDITION',
      'conditions.all[0].any[1]',
    );
  });

  it('rejects unknown, missing and mistyped arguments', () => {
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'NO_PRIOR_REVOCATION', days: 3 }]),
      'UNKNOWN_ARGUMENT',
      'conditions.all[0].days',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'MIN_PAID_AMOUNT', minor: 1000 }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].currency',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'MIN_PAID_AMOUNT', minor: '1000', currency: 'TRY' }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].minor',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'MIN_PAID_AMOUNT', minor: 10.5, currency: 'TRY' }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].minor',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'MIN_PAID_AMOUNT', minor: 99, currency: 'TRY' }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].minor',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'MIN_PAID_AMOUNT', minor: 1000, currency: 'USD' }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].currency',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'PROVIDER_APPROVED_WITHIN_DAYS', days: 0 }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].days',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'PROVIDER_APPROVED_WITHIN_DAYS', days: 366 }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].days',
    );
  });

  it('rejects list arguments that are empty, oversized, unknown, duplicated or of the wrong kind', () => {
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'PACKAGE_TYPE_IN', types: [] }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].types',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'PACKAGE_TYPE_IN', types: ['SHOWCASE'] }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].types[0]',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'PACKAGE_TYPE_IN', types: ['MONTHLY_QUOTA', 'MONTHLY_QUOTA'] }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].types[1]',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'PURCHASE_KIND_IN', kinds: ['SHOWCASE_PACKAGE'] }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].kinds[0]',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'PACKAGE_SLUG_IN', slugs: 'pro-50' }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].slugs',
    );
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'PACKAGE_SLUG_IN', slugs: ['Pro 50'] }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].slugs[0]',
    );
    const tooMany = Array.from({ length: 21 }, (_, i) => `paket-${i}`);
    expectCode(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'PACKAGE_SLUG_IN', slugs: tooMany }]),
      'ARGUMENT_INVALID',
      'conditions.all[0].slugs',
    );
  });

  it('rejects a package slug the catalogue does not know, only when a catalogue is supplied', () => {
    const input = withConditions(K2_PACKAGE_BONUS, [{ type: 'PACKAGE_SLUG_IN', slugs: ['pro-50', 'yok-boyle'] }]);
    expect(codesOf(input)).toEqual([]);
    expect(codesOf(input, new Set(['pro-50']))).toEqual(['UNKNOWN_PACKAGE_SLUG@conditions.all[0].slugs[1]']);
  });
});

describe('benefit', () => {
  it('accepts only bounded positive promo credits', () => {
    expectCode({ ...K2_PACKAGE_BONUS, benefit: { type: 'CHECKOUT_DISCOUNT', percent: 10 } }, 'BENEFIT_INVALID', 'benefit.type');
    expectCode({ ...K2_PACKAGE_BONUS, benefit: { type: 'SHOWCASE_SLOT', days: 7 } }, 'BENEFIT_INVALID', 'benefit.type');
    expectCode({ ...K2_PACKAGE_BONUS, benefit: { type: 'PROMO_CREDITS', credits: 0, expiresInDays: 30 } }, 'BENEFIT_INVALID', 'benefit.credits');
    expectCode({ ...K2_PACKAGE_BONUS, benefit: { type: 'PROMO_CREDITS', credits: -5, expiresInDays: 30 } }, 'BENEFIT_INVALID', 'benefit.credits');
    expectCode({ ...K2_PACKAGE_BONUS, benefit: { type: 'PROMO_CREDITS', credits: 1001, expiresInDays: 30 } }, 'BENEFIT_INVALID', 'benefit.credits');
    expectCode({ ...K2_PACKAGE_BONUS, benefit: { type: 'PROMO_CREDITS', credits: 2.5, expiresInDays: 30 } }, 'BENEFIT_INVALID', 'benefit.credits');
    expectCode({ ...K2_PACKAGE_BONUS, benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 0 } }, 'BENEFIT_INVALID', 'benefit.expiresInDays');
    expectCode({ ...K2_PACKAGE_BONUS, benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 366 } }, 'BENEFIT_INVALID', 'benefit.expiresInDays');
    expectCode({ ...K2_PACKAGE_BONUS, benefit: { type: 'PROMO_CREDITS', credits: 10 } }, 'BENEFIT_INVALID', 'benefit.expiresInDays');
    expectCode({ ...K2_PACKAGE_BONUS, benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 30, amountMinor: 500 } }, 'UNKNOWN_FIELD', 'benefit.amountMinor');
    expectCode({ ...K2_PACKAGE_BONUS, benefit: null }, 'BENEFIT_INVALID', 'benefit');
  });
});

describe('limits, window, stack policy and priority', () => {
  it('requires the per-provider limit and bounds every limit', () => {
    expectCode({ ...K2_PACKAGE_BONUS, limits: {} }, 'LIMIT_INVALID', 'limits.maxRedemptionsPerProvider');
    expectCode({ ...K2_PACKAGE_BONUS, limits: { maxRedemptionsPerProvider: 0 } }, 'LIMIT_INVALID', 'limits.maxRedemptionsPerProvider');
    expectCode({ ...K2_PACKAGE_BONUS, limits: { maxRedemptionsPerProvider: 101 } }, 'LIMIT_INVALID', 'limits.maxRedemptionsPerProvider');
    expectCode({ ...K2_PACKAGE_BONUS, limits: { maxRedemptionsPerProvider: 1, maxRedemptionsGlobal: 0 } }, 'LIMIT_INVALID', 'limits.maxRedemptionsGlobal');
    expectCode({ ...K2_PACKAGE_BONUS, limits: { maxRedemptionsPerProvider: 1, maxRedemptionsGlobal: 1000001 } }, 'LIMIT_INVALID', 'limits.maxRedemptionsGlobal');
    expectCode({ ...K2_PACKAGE_BONUS, limits: { maxRedemptionsPerProvider: 1, maxRedemptionsPerDay: 100001 } }, 'LIMIT_INVALID', 'limits.maxRedemptionsPerDay');
    expectCode({ ...K2_PACKAGE_BONUS, limits: { maxRedemptionsPerProvider: 1, budgetCredits: 10000001 } }, 'LIMIT_INVALID', 'limits.budgetCredits');
    expectCode({ ...K2_PACKAGE_BONUS, limits: { maxRedemptionsPerProvider: 1, budgetCredits: '100' } }, 'LIMIT_INVALID', 'limits.budgetCredits');
    expectCode({ ...K2_PACKAGE_BONUS, limits: { maxRedemptionsPerProvider: 1, maxRedemptionsPerBusiness: 1 } }, 'UNKNOWN_FIELD', 'limits.maxRedemptionsPerBusiness');
    expectCode({ ...K2_PACKAGE_BONUS, limits: null }, 'LIMIT_INVALID', 'limits');
  });

  it('rejects a budget that cannot pay for a single lot', () => {
    expectCode(
      { ...K2_PACKAGE_BONUS, limits: { maxRedemptionsPerProvider: 1, budgetCredits: 9 } },
      'LIMIT_INVALID',
      'limits.budgetCredits',
    );
  });

  it('accepts only UTC ISO instants in the window, start before end', () => {
    expectCode({ ...K2_PACKAGE_BONUS, window: { startAt: '2026-10-01' } }, 'WINDOW_INVALID', 'window.startAt');
    expectCode({ ...K2_PACKAGE_BONUS, window: { startAt: '2026-10-01T00:00:00+03:00' } }, 'WINDOW_INVALID', 'window.startAt');
    expectCode({ ...K2_PACKAGE_BONUS, window: { endAt: 'yarın' } }, 'WINDOW_INVALID', 'window.endAt');
    expectCode({ ...K2_PACKAGE_BONUS, window: { endAt: 20261001 } }, 'WINDOW_INVALID', 'window.endAt');
    expectCode(
      { ...K2_PACKAGE_BONUS, window: { startAt: '2026-10-02T00:00:00Z', endAt: '2026-10-01T00:00:00Z' } },
      'WINDOW_INVALID',
      'window.endAt',
    );
    expectCode(
      { ...K2_PACKAGE_BONUS, window: { startAt: '2026-10-01T00:00:00Z', endAt: '2026-10-01T00:00:00Z' } },
      'WINDOW_INVALID',
      'window.endAt',
    );
    expectCode({ ...K2_PACKAGE_BONUS, window: { startAt: null, tz: 'Europe/Istanbul' } }, 'UNKNOWN_FIELD', 'window.tz');
    expectCode({ ...K2_PACKAGE_BONUS, window: null }, 'WINDOW_INVALID', 'window');
  });

  it('accepts only the exclusive stack policy and a bounded integer priority', () => {
    expectCode({ ...K2_PACKAGE_BONUS, stackPolicy: 'ADDITIVE' }, 'STACK_POLICY_INVALID', 'stackPolicy');
    const { stackPolicy: _omit, ...withoutPolicy } = K2_PACKAGE_BONUS;
    expectCode(withoutPolicy, 'STACK_POLICY_INVALID', 'stackPolicy');
    expectCode({ ...K2_PACKAGE_BONUS, priority: 0 }, 'PRIORITY_INVALID', 'priority');
    expectCode({ ...K2_PACKAGE_BONUS, priority: 1001 }, 'PRIORITY_INVALID', 'priority');
    expectCode({ ...K2_PACKAGE_BONUS, priority: '100' }, 'PRIORITY_INVALID', 'priority');
    expectCode({ ...K2_PACKAGE_BONUS, priority: 1.5 }, 'PRIORITY_INVALID', 'priority');
    const { priority: _omitPriority, ...withoutPriority } = K2_PACKAGE_BONUS;
    expectCode(withoutPriority, 'PRIORITY_INVALID', 'priority');
  });
});

describe('the error catalogue', () => {
  it('is closed, and every code in it is produced by this suite at least once', () => {
    const produced = new Set<string>();
    const cases: unknown[] = [
      null,
      { ...K2_PACKAGE_BONUS, schemaVersion: 9 },
      { ...K2_PACKAGE_BONUS, script: 1 },
      { ...K2_PACKAGE_BONUS, trigger: 'X' },
      withConditions(K2_PACKAGE_BONUS, [{ type: 'X' }]),
      withConditions(K2_PACKAGE_BONUS, [{ type: 'FIRST_PROVIDER_APPROVAL' }]),
      { ...FIRST_APPROVAL, conditions: { all: [{ type: 'EMAIL_VERIFIED' }] } },
      (() => {
        const { eligibility: _e, ...rest } = K1_ELIGIBILITY;
        return rest;
      })(),
      { ...K2_PACKAGE_BONUS, eligibility: { facts: ['EMAIL_VERIFIED', 'PHONE_VERIFIED'] } },
      { ...K1_ELIGIBILITY, eligibility: { facts: ['EMAIL_VERIFIED', 'X'] } },
      { ...K1_ELIGIBILITY, eligibility: { facts: ['EMAIL_VERIFIED', 'EMAIL_VERIFIED'] } },
      { ...K1_ELIGIBILITY, eligibility: { facts: ['EMAIL_VERIFIED'] } },
      withConditions(K2_PACKAGE_BONUS, [{ any: [{ any: [] }] }]),
      withConditions(K2_PACKAGE_BONUS, [{ any: [] }]),
      withConditions(K2_PACKAGE_BONUS, Array.from({ length: 17 }, () => ({ type: 'NO_PRIOR_REVOCATION' }))),
      withConditions(K2_PACKAGE_BONUS, [{ type: 'MIN_PAID_AMOUNT', minor: 1, currency: 'TRY' }]),
      withConditions(K2_PACKAGE_BONUS, [{ type: 'NO_PRIOR_REVOCATION', x: 1 }]),
      withConditions(K2_PACKAGE_BONUS, [{ type: 'NO_PRIOR_REVOCATION' }, { type: 'NO_PRIOR_REVOCATION' }]),
      { ...K2_PACKAGE_BONUS, benefit: { type: 'X' } },
      { ...K2_PACKAGE_BONUS, limits: {} },
      { ...K2_PACKAGE_BONUS, window: { startAt: 'x' } },
      { ...K2_PACKAGE_BONUS, stackPolicy: 'X' },
      { ...K2_PACKAGE_BONUS, priority: 0 },
    ];
    for (const input of cases) {
      const result = validateCampaignDefinition(input);
      if (!result.ok) {
        for (const error of result.errors) produced.add(error.code);
      }
    }
    const slugCase = validateCampaignDefinition(
      withConditions(K2_PACKAGE_BONUS, [{ type: 'PACKAGE_SLUG_IN', slugs: ['yok'] }]),
      { knownPackageSlugs: new Set() },
    );
    if (!slugCase.ok) for (const error of slugCase.errors) produced.add(error.code);

    const missing = CAMPAIGN_RULE_ERROR_CODES.filter((code) => !produced.has(code));
    expect(missing).toEqual([]);
    expect(CAMPAIGN_RULE_ERROR_CODES).toHaveLength(24);
  });
});
