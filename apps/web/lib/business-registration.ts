import catalog from '../../../packages/shared/business-registration.json';

/**
 * The canonical business registration (CMP-006 PR-C), as the web app words
 * it. Client-safe: the application form's registration fields are a Client
 * Component. Types, labels and lengths come from
 * `packages/shared/business-registration.json`, the file the API validates
 * against, so the form cannot offer a type or a length the server refuses.
 */

export type BusinessRegistrationType = keyof typeof catalog.types;

export type BusinessRegistrationView = {
  status: 'DECLARED' | 'NONE_DECLARED' | 'UNSPECIFIED';
  type: BusinessRegistrationType | null;
  numberMasked: string | null;
  updatedAt: string | null;
};

export const BUSINESS_REGISTRATION_TYPE_ORDER = catalog.order as BusinessRegistrationType[];
export const BUSINESS_REGISTRATION_INPUT_MAX_LENGTH = catalog.inputMaxLength;
export const NONE_DECLARED: BusinessRegistrationType = 'NONE_DECLARED';

export function businessRegistrationLabel(type: BusinessRegistrationType): string {
  return catalog.types[type].label;
}

/** A short hint of the expected shape, for the number field. */
export function businessRegistrationHint(type: BusinessRegistrationType): string | null {
  const rule = catalog.types[type];
  if (type === NONE_DECLARED) return null;
  return rule.minDigits === rule.maxDigits ? `${rule.maxDigits} haneli` : `En fazla ${rule.maxDigits} hane`;
}

/** One line for any screen that shows a provider's registration: type and masked number, or its absence. */
export function describeBusinessRegistration(view: BusinessRegistrationView | null | undefined): string {
  if (!view || view.status === 'UNSPECIFIED' || !view.type) {
    return 'Belirtilmemiş (eski kayıt)';
  }
  if (view.status === 'NONE_DECLARED') {
    return 'Beyan edilmedi';
  }
  return `${businessRegistrationLabel(view.type)} · ${view.numberMasked ?? ''}`;
}

/** The API's closed refusal codes, mapped to a query-string key a page can render. */
const ERROR_KEYS = {
  BUSINESS_REGISTRATION_TYPE_REQUIRED: 'registration-type',
  BUSINESS_REGISTRATION_NUMBER_REQUIRED: 'registration-number-required',
  BUSINESS_REGISTRATION_NUMBER_NOT_ALLOWED: 'registration-number-not-allowed',
  BUSINESS_REGISTRATION_NUMBER_INVALID: 'registration-number-invalid',
} as const;

export type BusinessRegistrationErrorKey = (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS];

export const BUSINESS_REGISTRATION_ERROR_MESSAGES: Record<BusinessRegistrationErrorKey, string> = {
  'registration-type': 'İşletme kaydı türünü seçin.',
  'registration-number-required': 'Seçtiğiniz kayıt türü için numara girin.',
  'registration-number-not-allowed': '"Beyan etmiyorum" seçildiğinde numara girilmez.',
  'registration-number-invalid': 'Kayıt numarası seçtiğiniz türle uyumlu değil. Haneleri kontrol edin.',
};

/** The error key for a refusal body, or null when the refusal is about something else. */
export function businessRegistrationErrorKey(body: string): BusinessRegistrationErrorKey | null {
  for (const [code, key] of Object.entries(ERROR_KEYS)) {
    if (body.includes(code)) return key;
  }
  return null;
}

export function isBusinessRegistrationErrorKey(value: string | undefined): value is BusinessRegistrationErrorKey {
  return value !== undefined && value in BUSINESS_REGISTRATION_ERROR_MESSAGES;
}

/** The pair a form posts, trimmed; NONE_DECLARED never carries a number. */
export function readBusinessRegistration(formData: FormData): { type: string | null; number: string | null } {
  const type = String(formData.get('businessRegistrationType') ?? '').trim() || null;
  const number = String(formData.get('businessRegistrationNumber') ?? '').trim() || null;
  return { type, number: type === NONE_DECLARED ? null : number };
}
