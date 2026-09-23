import { BadRequestException } from '@nestjs/common';
import { BusinessRegistrationType } from '@prisma/client';
import catalog from '@taktic/shared/business-registration.json';

/**
 * The canonical business registration (CMP-006 PR-C): which kinds exist, what
 * a number of each kind looks like, and how it is normalised and masked.
 *
 * The rules live in `packages/shared/business-registration.json` so the web
 * form reads the same lengths the API enforces; the JSON is imported rather
 * than the package's TypeScript entry point for the CommonJS reason
 * `common/service-request-limits.ts` documents.
 *
 * Nothing here ever puts the number into an error. A refusal names the rule
 * that failed, not the value that failed it.
 */

type TypeRule = { label: string; minDigits: number; maxDigits: number; checksum: string | null };

const RULES = catalog.types as Record<BusinessRegistrationType, TypeRule>;

export const BUSINESS_REGISTRATION_TYPES = Object.values(BusinessRegistrationType);
export const BUSINESS_REGISTRATION_INPUT_MAX_LENGTH = catalog.inputMaxLength;
export const BUSINESS_REGISTRATION_MASK_VISIBLE_DIGITS = catalog.maskVisibleDigits;

export const BUSINESS_REGISTRATION_ERROR = {
  typeRequired: 'BUSINESS_REGISTRATION_TYPE_REQUIRED',
  numberRequired: 'BUSINESS_REGISTRATION_NUMBER_REQUIRED',
  numberNotAllowed: 'BUSINESS_REGISTRATION_NUMBER_NOT_ALLOWED',
  numberInvalid: 'BUSINESS_REGISTRATION_NUMBER_INVALID',
} as const;

export type BusinessRegistrationErrorCode =
  (typeof BUSINESS_REGISTRATION_ERROR)[keyof typeof BUSINESS_REGISTRATION_ERROR];

/** A validated declaration: NONE_DECLARED alone, or a type with its canonical digits. */
export type NormalizedBusinessRegistration =
  | { type: typeof BusinessRegistrationType.NONE_DECLARED; numberCanonical: null }
  | { type: Exclude<BusinessRegistrationType, 'NONE_DECLARED'>; numberCanonical: string };

export type BusinessRegistrationResult =
  | { ok: true; value: NormalizedBusinessRegistration | null }
  | { ok: false; code: BusinessRegistrationErrorCode };

/**
 * NFKC first (full-width digits become ASCII), then the separators people
 * type — spaces of any kind, dots, hyphens, slashes — are dropped. What is
 * left must be ASCII digits and nothing else.
 */
export function canonicalizeRegistrationNumber(raw: string): string {
  return raw.normalize('NFKC').replace(/[\s.\-/]/gu, '');
}

/**
 * The declaration a form or a body carries, as the pair it arrives in.
 * Neither field → null (nothing was declared; the provider stays
 * "unspecified"). A number without a type, a type without the number it
 * needs, a number on NONE_DECLARED, or a number of the wrong shape → a
 * closed code.
 */
export function validateBusinessRegistration(
  typeInput: string | null | undefined,
  numberInput: string | null | undefined,
): BusinessRegistrationResult {
  const type = typeInput?.trim() ? typeInput.trim() : null;
  const number = numberInput?.trim() ? numberInput.trim() : null;

  if (type === null) {
    return number === null ? { ok: true, value: null } : { ok: false, code: BUSINESS_REGISTRATION_ERROR.typeRequired };
  }
  if (!(BUSINESS_REGISTRATION_TYPES as string[]).includes(type)) {
    return { ok: false, code: BUSINESS_REGISTRATION_ERROR.typeRequired };
  }
  if (type === BusinessRegistrationType.NONE_DECLARED) {
    return number === null
      ? { ok: true, value: { type: BusinessRegistrationType.NONE_DECLARED, numberCanonical: null } }
      : { ok: false, code: BUSINESS_REGISTRATION_ERROR.numberNotAllowed };
  }
  if (number === null) {
    return { ok: false, code: BUSINESS_REGISTRATION_ERROR.numberRequired };
  }
  if (number.length > BUSINESS_REGISTRATION_INPUT_MAX_LENGTH) {
    return { ok: false, code: BUSINESS_REGISTRATION_ERROR.numberInvalid };
  }

  const canonical = canonicalizeRegistrationNumber(number);
  const rule = RULES[type as BusinessRegistrationType];
  if (
    !/^[0-9]+$/.test(canonical) ||
    canonical.length < rule.minDigits ||
    canonical.length > rule.maxDigits ||
    (rule.checksum === 'TR_IDENTITY' && !isValidTurkishIdentityNumber(canonical))
  ) {
    return { ok: false, code: BUSINESS_REGISTRATION_ERROR.numberInvalid };
  }
  return {
    ok: true,
    value: { type: type as Exclude<BusinessRegistrationType, 'NONE_DECLARED'>, numberCanonical: canonical },
  };
}

/** The same, as a 400 with `{ code }` — the shape the web form keys its message on. */
export function requireValidBusinessRegistration(
  typeInput: string | null | undefined,
  numberInput: string | null | undefined,
): NormalizedBusinessRegistration | null {
  const result = validateBusinessRegistration(typeInput, numberInput);
  if (!result.ok) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: result.code,
      message: BUSINESS_REGISTRATION_MESSAGES[result.code],
    });
  }
  return result.value;
}

const BUSINESS_REGISTRATION_MESSAGES: Record<BusinessRegistrationErrorCode, string> = {
  BUSINESS_REGISTRATION_TYPE_REQUIRED: 'İşletme kaydı türünü seçin.',
  BUSINESS_REGISTRATION_NUMBER_REQUIRED: 'Seçtiğiniz kayıt türü için numara girin.',
  BUSINESS_REGISTRATION_NUMBER_NOT_ALLOWED: '"Beyan etmiyorum" seçildiğinde numara girilmez.',
  BUSINESS_REGISTRATION_NUMBER_INVALID: 'Kayıt numarası seçtiğiniz türle uyumlu değil.',
};

/**
 * T.C. kimlik numarası: 11 digits, the first not 0; the 10th is
 * ((d1+d3+d5+d7+d9)·7 − (d2+d4+d6+d8)) mod 10 and the 11th is the sum of the
 * first ten mod 10.
 */
export function isValidTurkishIdentityNumber(value: string): boolean {
  if (!/^[1-9][0-9]{10}$/.test(value)) {
    return false;
  }
  const d = [...value].map(Number);
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  const tenth = (((odd * 7 - even) % 10) + 10) % 10;
  if (tenth !== d[9]) {
    return false;
  }
  const eleventh = d.slice(0, 10).reduce((sum, digit) => sum + digit, 0) % 10;
  return eleventh === d[10];
}

/** Every digit but the last two replaced by `*` — same length, so the CHECK can hold it to the canonical form. */
export function maskRegistrationNumber(canonical: string): string {
  const visible = Math.min(BUSINESS_REGISTRATION_MASK_VISIBLE_DIGITS, Math.max(0, canonical.length - 1));
  return '*'.repeat(canonical.length - visible) + canonical.slice(canonical.length - visible);
}

/**
 * The legacy free-text tax number, masked the same way, for every response
 * that used to carry it raw. Non-digits are masked too: the text is
 * unverified and may be anything.
 */
export function maskLegacyTaxNumber(value: string | null | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  const trimmed = value.trim();
  const visible = Math.min(BUSINESS_REGISTRATION_MASK_VISIBLE_DIGITS, Math.max(0, trimmed.length - 1));
  return '*'.repeat(trimmed.length - visible) + trimmed.slice(trimmed.length - visible);
}

export function businessRegistrationLabel(type: BusinessRegistrationType): string {
  return RULES[type].label;
}
