import { describe, expect, it } from 'vitest';
import catalog from '../../../packages/shared/business-registration.json';
import {
  BUSINESS_REGISTRATION_ERROR_MESSAGES,
  BUSINESS_REGISTRATION_TYPE_ORDER,
  businessRegistrationErrorKey,
  describeBusinessRegistration,
  readBusinessRegistration,
} from '../lib/business-registration';

describe('business registration (CMP-006 PR-C) — web wording', () => {
  it('offers every type the shared catalogue defines, NONE_DECLARED last', () => {
    expect([...BUSINESS_REGISTRATION_TYPE_ORDER].sort()).toEqual(Object.keys(catalog.types).sort());
    expect(BUSINESS_REGISTRATION_TYPE_ORDER.at(-1)).toBe('NONE_DECLARED');
  });

  it('describes a declared, a none-declared and a legacy record — masked only', () => {
    expect(
      describeBusinessRegistration({ status: 'DECLARED', type: 'SOLE_PROPRIETOR_TR_ID', numberMasked: '*********46', updatedAt: null }),
    ).toBe('Şahıs işletmesi (T.C. kimlik numarası) · *********46');
    expect(describeBusinessRegistration({ status: 'NONE_DECLARED', type: 'NONE_DECLARED', numberMasked: null, updatedAt: null })).toBe(
      'Beyan edilmedi',
    );
    expect(describeBusinessRegistration(undefined)).toBe('Belirtilmemiş (eski kayıt)');
  });

  it('maps every API refusal code to a message, and nothing else', () => {
    for (const code of [
      'BUSINESS_REGISTRATION_TYPE_REQUIRED',
      'BUSINESS_REGISTRATION_NUMBER_REQUIRED',
      'BUSINESS_REGISTRATION_NUMBER_NOT_ALLOWED',
      'BUSINESS_REGISTRATION_NUMBER_INVALID',
    ]) {
      const key = businessRegistrationErrorKey(JSON.stringify({ code }));
      expect(key).not.toBeNull();
      expect(BUSINESS_REGISTRATION_ERROR_MESSAGES[key!]).toBeTruthy();
    }
    expect(businessRegistrationErrorKey('{"code":"PROVIDER_EMAIL_REQUIRED"}')).toBeNull();
  });

  it('never posts a number with NONE_DECLARED', () => {
    const form = new FormData();
    form.set('businessRegistrationType', 'NONE_DECLARED');
    form.set('businessRegistrationNumber', '1234567890');
    expect(readBusinessRegistration(form)).toEqual({ type: 'NONE_DECLARED', number: null });
    form.set('businessRegistrationType', 'TAX_NUMBER');
    expect(readBusinessRegistration(form)).toEqual({ type: 'TAX_NUMBER', number: '1234567890' });
  });
});
