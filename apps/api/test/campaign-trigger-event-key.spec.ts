import { describe, expect, it } from 'vitest';
import {
  buildFactSetKey,
  buildTriggerEventKey,
  type CampaignTriggerInput,
} from '../src/modules/campaigns/engine/trigger-event-key';

/**
 * The event identity is campaign-independent and carries no timestamp
 * (CMP-001 §2.7, §8.3): the same business event always yields the same key,
 * whichever campaign is asking and however many times it is raised.
 */
describe('buildTriggerEventKey', () => {
  it('names an approval by its provider', () => {
    expect(buildTriggerEventKey({ trigger: 'PROVIDER_APPROVED', providerId: 'prov_1' })).toBe(
      'PROVIDER_APPROVED:prov_1',
    );
  });

  it('names a settled payment by its purchase, not its provider', () => {
    expect(
      buildTriggerEventKey({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: 'prov_1', purchaseId: 'pur_9' }),
    ).toBe('PACKAGE_PAYMENT_SUCCEEDED:pur_9');
  });

  it('names an eligibility transition by its sorted fact set and its provider', () => {
    const input: CampaignTriggerInput = {
      trigger: 'PROVIDER_ELIGIBILITY_REACHED',
      providerId: 'prov_1',
      facts: ['PHONE_VERIFIED', 'PROVIDER_APPROVED', 'EMAIL_VERIFIED'],
    };
    expect(buildTriggerEventKey(input)).toBe(
      'PROVIDER_ELIGIBILITY_REACHED:EMAIL_VERIFIED+PHONE_VERIFIED+PROVIDER_APPROVED:prov_1',
    );
  });

  it('is stable across repeated calls and fact orderings', () => {
    const a = buildTriggerEventKey({
      trigger: 'PROVIDER_ELIGIBILITY_REACHED',
      providerId: 'p',
      facts: ['EMAIL_VERIFIED', 'PROVIDER_APPROVED'],
    });
    const b = buildTriggerEventKey({
      trigger: 'PROVIDER_ELIGIBILITY_REACHED',
      providerId: 'p',
      facts: ['PROVIDER_APPROVED', 'EMAIL_VERIFIED'],
    });
    expect(a).toBe(b);
  });
});

describe('buildFactSetKey', () => {
  it('sorts and joins with +, matching what the validator stores on the version', () => {
    expect(buildFactSetKey(['PROVIDER_APPROVED', 'EMAIL_VERIFIED'])).toBe('EMAIL_VERIFIED+PROVIDER_APPROVED');
  });

  it('refuses an empty set — an eligibility transition needs facts', () => {
    expect(() => buildFactSetKey([])).toThrow();
  });
});
