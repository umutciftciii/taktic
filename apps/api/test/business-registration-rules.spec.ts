import { BusinessRegistrationType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeRegistrationNumber,
  isValidTurkishIdentityNumber,
  maskLegacyTaxNumber,
  maskRegistrationNumber,
  validateBusinessRegistration,
} from '../src/modules/business-registration/business-registration.rules';

/**
 * The canonical business registration rules (CMP-006 PR-C design §1.2), pure:
 * every type, the missing and mismatched cases, normalisation and masking.
 */

/** A T.C. identity number whose check digits hold: 1000000014 6 → 10000000146. */
const VALID_TCKN = '10000000146';

describe('validateBusinessRegistration — each type', () => {
  it.each([
    [BusinessRegistrationType.TAX_NUMBER, '1234567890', '1234567890'],
    [BusinessRegistrationType.MERSIS, '0123 4567 8901 2345', '0123456789012345'],
    [BusinessRegistrationType.TRADE_REGISTRY, '12345-6', '123456'],
    [BusinessRegistrationType.CRAFTSMAN_REGISTRY, '34/1234', '341234'],
    [BusinessRegistrationType.SOLE_PROPRIETOR_TR_ID, VALID_TCKN, VALID_TCKN],
  ])('%s accepts a well-formed number and stores its canonical digits', (type, input, canonical) => {
    expect(validateBusinessRegistration(type, input)).toEqual({ ok: true, value: { type, numberCanonical: canonical } });
  });

  it('NONE_DECLARED is accepted with no number, and refused with one', () => {
    expect(validateBusinessRegistration('NONE_DECLARED', null)).toEqual({
      ok: true,
      value: { type: 'NONE_DECLARED', numberCanonical: null },
    });
    expect(validateBusinessRegistration('NONE_DECLARED', '   ')).toMatchObject({ ok: true });
    expect(validateBusinessRegistration('NONE_DECLARED', '1234567890')).toEqual({
      ok: false,
      code: 'BUSINESS_REGISTRATION_NUMBER_NOT_ALLOWED',
    });
  });

  it('nothing declared is null — the provider stays "unspecified", nothing is written', () => {
    expect(validateBusinessRegistration(undefined, undefined)).toEqual({ ok: true, value: null });
    expect(validateBusinessRegistration('', '  ')).toEqual({ ok: true, value: null });
  });
});

describe('validateBusinessRegistration — missing and mismatched', () => {
  it('a number without a type, or an unknown type, is TYPE_REQUIRED', () => {
    expect(validateBusinessRegistration(null, '1234567890')).toEqual({ ok: false, code: 'BUSINESS_REGISTRATION_TYPE_REQUIRED' });
    expect(validateBusinessRegistration('PASSPORT', '1234567890')).toEqual({ ok: false, code: 'BUSINESS_REGISTRATION_TYPE_REQUIRED' });
  });

  it.each(['TAX_NUMBER', 'MERSIS', 'TRADE_REGISTRY', 'CRAFTSMAN_REGISTRY', 'SOLE_PROPRIETOR_TR_ID'])(
    '%s without a number is NUMBER_REQUIRED',
    (type) => {
      expect(validateBusinessRegistration(type, '')).toEqual({ ok: false, code: 'BUSINESS_REGISTRATION_NUMBER_REQUIRED' });
    },
  );

  it.each([
    ['TAX_NUMBER', '123456789', 'nine digits'],
    ['TAX_NUMBER', '12345678901', 'eleven digits'],
    ['TAX_NUMBER', '12345A7890', 'a letter'],
    ['MERSIS', '123456789012345', 'fifteen digits'],
    ['TRADE_REGISTRY', '1234567890123', 'thirteen digits'],
    ['CRAFTSMAN_REGISTRY', '-/.', 'separators only'],
    ['SOLE_PROPRIETOR_TR_ID', '10000000147', 'a wrong 11th check digit'],
    ['SOLE_PROPRIETOR_TR_ID', '10000000156', 'a wrong 10th check digit'],
    ['SOLE_PROPRIETOR_TR_ID', '00000000146', 'a leading zero'],
    ['SOLE_PROPRIETOR_TR_ID', '1234567890', 'ten digits'],
    ['TAX_NUMBER', '1'.repeat(41), 'more than the input bound'],
  ])('%s refuses %s (%s) with NUMBER_INVALID', (type, input) => {
    expect(validateBusinessRegistration(type, input)).toEqual({ ok: false, code: 'BUSINESS_REGISTRATION_NUMBER_INVALID' });
  });

  it('a refusal never carries the number', () => {
    const result = validateBusinessRegistration('SOLE_PROPRIETOR_TR_ID', '10000000147');
    expect(JSON.stringify(result)).not.toContain('10000000147');
  });
});

describe('normalisation', () => {
  it('NFKC folds full-width digits; spaces, dots, hyphens and slashes are dropped', () => {
    expect(canonicalizeRegistrationNumber('１２３ ４５.６-７/８ 9０')).toBe('1234567890');
    expect(validateBusinessRegistration('TAX_NUMBER', '１２３４５６７８９０')).toMatchObject({
      ok: true,
      value: { numberCanonical: '1234567890' },
    });
  });

  it('the type is trimmed but case-sensitive (a closed enum, not free text)', () => {
    expect(validateBusinessRegistration(' TAX_NUMBER ', '1234567890')).toMatchObject({ ok: true });
    expect(validateBusinessRegistration('tax_number', '1234567890')).toMatchObject({ ok: false });
  });
});

describe('T.C. identity number check digits', () => {
  it.each([VALID_TCKN, '11111111110', '12345678950'])('%s is valid', (value) => {
    expect(isValidTurkishIdentityNumber(value)).toBe(true);
  });
  it.each(['11111111111', '12345678901', '1000000014', 'abcdefghijk'])('%s is not', (value) => {
    expect(isValidTurkishIdentityNumber(value)).toBe(false);
  });
});

describe('masking', () => {
  it('keeps the last two digits and the length', () => {
    expect(maskRegistrationNumber('1234567890')).toBe('********90');
    expect(maskRegistrationNumber(VALID_TCKN)).toBe('*********46');
    expect(maskRegistrationNumber('7')).toBe('*');
    expect(maskRegistrationNumber('12')).toBe('*2');
  });

  it('masks the legacy free text the same way, and null stays null', () => {
    expect(maskLegacyTaxNumber(' 1234567066 ')).toBe('********66');
    expect(maskLegacyTaxNumber('')).toBeNull();
    expect(maskLegacyTaxNumber(null)).toBeNull();
  });
});
