import { describe, expect, it } from 'vitest';
import catalog from '../../../packages/shared/campaign-rules.json';
import {
  CAMPAIGN_CHANNEL_OPTIONS,
  CAMPAIGN_TRIGGER_OPTIONS,
  CONDITION_LABELS,
  FACT_LABELS,
  buildDefinition,
  channelLabel,
  conditionOptionsFor,
  emptyForm,
  errorFieldOf,
  formFromDefinition,
  ruleErrorMessage,
  type CampaignForm,
} from '../lib/campaign-rules';
import { navGroups } from '../lib/nav';

/**
 * The builder form is a projection of the shared catalogue: every option it
 * offers is in `campaign-rules.json`, and what it produces is the definition
 * the API validates. Nothing here re-implements a rule — an invalid form
 * still becomes a definition, and the API says what is wrong with it.
 */

function packageBonusForm(): CampaignForm {
  return {
    ...emptyForm(),
    trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
    conditions: [
      { id: 'a', type: 'FIRST_SUCCESSFUL_PAID_PURCHASE', group: 'all', args: {} },
      { id: 'b', type: 'MIN_PAID_AMOUNT', group: 'all', args: { minor: '10000', currency: 'TRY' } },
      { id: 'c', type: 'PACKAGE_TYPE_IN', group: 'any', args: { types: ['MONTHLY_QUOTA', 'CATEGORY_UNLIMITED'] } },
      { id: 'd', type: 'PACKAGE_SLUG_IN', group: 'any', args: { slugs: 'pro-50, baslangic-10' } },
    ],
    credits: '10',
    expiresInDays: '30',
    maxRedemptionsPerProvider: '1',
    maxRedemptionsGlobal: '1000',
    maxRedemptionsPerDay: '',
    budgetCredits: '10000',
    windowStartAt: '2026-10-01T00:00',
    windowEndAt: '',
    priority: '100',
  };
}

describe('the catalogue projection', () => {
  it('offers exactly the catalogue triggers, conditions and facts, each with a label', () => {
    expect(CAMPAIGN_TRIGGER_OPTIONS.map((option) => option.value)).toEqual(catalog.triggers);
    expect(Object.keys(CONDITION_LABELS).sort()).toEqual(Object.keys(catalog.conditions).sort());
    expect(Object.keys(FACT_LABELS).sort()).toEqual([...catalog.facts].sort());
    for (const option of CAMPAIGN_TRIGGER_OPTIONS) expect(option.label.length).toBeGreaterThan(0);
  });

  it('narrows the condition options to the trigger, and hides proof conditions on the approval event', () => {
    expect(conditionOptionsFor('PROVIDER_APPROVED').map((o) => o.value)).toEqual(['FIRST_PROVIDER_APPROVAL', 'NO_PRIOR_REVOCATION']);
    expect(conditionOptionsFor('PACKAGE_PAYMENT_SUCCEEDED').map((o) => o.value)).toEqual([
      'EMAIL_VERIFIED',
      'PHONE_VERIFIED',
      'FIRST_SUCCESSFUL_PAID_PURCHASE',
      'PACKAGE_SLUG_IN',
      'PACKAGE_TYPE_IN',
      'PURCHASE_KIND_IN',
      'MIN_PAID_AMOUNT',
      'NO_PRIOR_REVOCATION',
      'PROVIDER_APPROVED_WITHIN_DAYS',
    ]);
    expect(conditionOptionsFor('PROVIDER_ELIGIBILITY_REACHED').map((o) => o.value)).toEqual([
      'EMAIL_VERIFIED',
      'PHONE_VERIFIED',
      'NO_PRIOR_REVOCATION',
      'PROVIDER_APPROVED_WITHIN_DAYS',
    ]);
  });

  it('has a sentence for every catalogue error code', () => {
    for (const code of [...catalog.errorCodes, ...catalog.activationErrorCodes]) {
      expect(ruleErrorMessage(code, undefined).length).toBeGreaterThan(0);
      expect(ruleErrorMessage(code, undefined)).not.toBe(code);
    }
    expect(ruleErrorMessage('BENEFIT_INVALID', 'API cümlesi')).toBe('API cümlesi');
  });
});

describe('form → definition', () => {
  it('builds the K2-shaped definition with the any group, typed arguments and explicit nulls', () => {
    expect(buildDefinition(packageBonusForm())).toEqual({
      schemaVersion: 1,
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      conditions: {
        all: [
          { type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' },
          { type: 'MIN_PAID_AMOUNT', minor: 10000, currency: 'TRY' },
          {
            any: [
              { type: 'PACKAGE_TYPE_IN', types: ['MONTHLY_QUOTA', 'CATEGORY_UNLIMITED'] },
              { type: 'PACKAGE_SLUG_IN', slugs: ['pro-50', 'baslangic-10'] },
            ],
          },
        ],
      },
      benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 30 },
      limits: { maxRedemptionsPerProvider: 1, maxRedemptionsGlobal: 1000, maxRedemptionsPerDay: null, budgetCredits: 10000, maxRevokesPerDay: null },
      window: { startAt: '2026-10-01T00:00:00Z', endAt: null },
      stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
      priority: 100,
      channel: 'ALL',
    });
  });

  it('carries the eligibility facts only on the eligibility trigger', () => {
    const form: CampaignForm = { ...emptyForm(), trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: ['PHONE_VERIFIED', 'PROVIDER_APPROVED'] };
    expect(buildDefinition(form).eligibility).toEqual({ facts: ['PHONE_VERIFIED', 'PROVIDER_APPROVED'] });
    expect(buildDefinition({ ...form, trigger: 'PROVIDER_APPROVED' }).eligibility).toBeUndefined();
  });

  it('does not repair input: a non-numeric field travels as-is for the API to refuse', () => {
    const definition = buildDefinition({ ...emptyForm(), credits: 'on', priority: '' });
    expect(definition.benefit.credits).toBe('on');
    expect(definition.priority).toBeNull();
  });

  it('carries the daily revoke threshold (CMP-003 S3) as a limit, round-tripped and addressable by error path', () => {
    const form: CampaignForm = { ...packageBonusForm(), maxRevokesPerDay: '3' };
    expect(buildDefinition(form).limits.maxRevokesPerDay).toBe(3);
    expect(formFromDefinition(buildDefinition(form)).maxRevokesPerDay).toBe('3');
    expect(formFromDefinition({ ...buildDefinition(form), limits: { maxRedemptionsPerProvider: 1 } }).maxRevokesPerDay).toBe('');
    expect(errorFieldOf('limits.maxRevokesPerDay', form)).toEqual({ field: 'maxRevokesPerDay' });
  });

  it('round-trips a stored definition back into a form', () => {
    const form = packageBonusForm();
    const again = formFromDefinition(buildDefinition(form));
    expect(buildDefinition(again)).toEqual(buildDefinition(form));
    expect(again.conditions.map((c) => c.group)).toEqual(['all', 'all', 'any', 'any']);
  });
});

describe('channel (CMP-006 PR-D)', () => {
  it('offers Web, Mobil and Tümü — the catalogue channels in its order — defaulting to Tümü', () => {
    expect(CAMPAIGN_CHANNEL_OPTIONS.map((option) => option.value)).toEqual(catalog.channels.values);
    expect(CAMPAIGN_CHANNEL_OPTIONS.map((option) => option.label)).toEqual(['Web', 'Mobil', 'Tümü']);
    expect(emptyForm().channel).toBe('ALL');
    expect(buildDefinition(emptyForm()).channel).toBe('ALL');
  });

  it('carries the selected channel, round-trips it, and reads an absent one as Tümü', () => {
    for (const channel of ['WEB', 'MOBILE', 'ALL'] as const) {
      const form: CampaignForm = { ...packageBonusForm(), channel };
      expect(buildDefinition(form).channel).toBe(channel);
      expect(formFromDefinition(buildDefinition(form)).channel).toBe(channel);
    }
    const { channel: _omitted, ...legacy } = buildDefinition({ ...packageBonusForm(), channel: 'WEB' });
    expect(formFromDefinition(legacy).channel).toBe('ALL');
    expect(formFromDefinition({ ...legacy, channel: 'web' }).channel).toBe('ALL');
    expect(channelLabel(undefined)).toBe('Tümü');
    expect(channelLabel('MOBILE')).toBe('Mobil');
  });

  it('points a channel error at the channel field', () => {
    expect(errorFieldOf('channel', packageBonusForm())).toEqual({ field: 'channel' });
  });
});

describe('error → field', () => {
  it('maps a validator path onto the form field that owns it', () => {
    const form = packageBonusForm();
    expect(errorFieldOf('benefit.credits', form)).toEqual({ field: 'credits' });
    expect(errorFieldOf('limits.budgetCredits', form)).toEqual({ field: 'budgetCredits' });
    expect(errorFieldOf('window.endAt', form)).toEqual({ field: 'windowEndAt' });
    expect(errorFieldOf('eligibility.facts[1]', form)).toEqual({ field: 'facts' });
    expect(errorFieldOf('conditions.all[1].minor', form)).toEqual({ field: 'condition', conditionId: 'b', argument: 'minor' });
    expect(errorFieldOf('conditions.all[2].any[1].slugs[0]', form)).toEqual({ field: 'condition', conditionId: 'd', argument: 'slugs' });
    expect(errorFieldOf('conditions.all[2].any', form)).toEqual({ field: 'conditions' });
    expect(errorFieldOf('trigger', form)).toEqual({ field: 'trigger' });
    expect(errorFieldOf('', form)).toEqual({ field: 'form' });
    expect(errorFieldOf('somethingElse', form)).toEqual({ field: 'form' });
  });
});

describe('the sidebar', () => {
  it('lists Kampanyalar under Operasyon, beside the operations switches', () => {
    const operasyon = navGroups.find((group) => group.title === 'Operasyon');
    expect(operasyon?.items.find((entry) => entry.href === '/campaigns')?.label).toBe('Kampanyalar');
  });
});
