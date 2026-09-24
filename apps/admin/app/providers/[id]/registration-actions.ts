'use server';

import { apiFetch } from '../../../lib/api';

/**
 * The one way the panel learns a raw registration number (CMP-006 PR-C): a
 * request to the audited route, made when an operator presses the button —
 * never while the page renders, so opening a provider is not a sensitive read.
 * The API checks PROVIDER_REGISTRATION_READ_SENSITIVE and writes the access
 * log before it answers.
 */
export type RawRegistrationState =
  | { status: 'idle' }
  | { status: 'shown'; registrationNumber: string | null; legacyTaxNumber: string | null }
  | { status: 'error'; message: string };

export async function revealBusinessRegistrationAction(
  _previous: RawRegistrationState,
  formData: FormData,
): Promise<RawRegistrationState> {
  const providerId = formData.get('providerId');
  if (typeof providerId !== 'string' || !providerId) {
    return { status: 'error', message: 'Hizmet veren bulunamadı.' };
  }
  try {
    const raw = await apiFetch<{ registration: { number: string | null }; legacy: { taxNumber: string | null } }>(
      `/providers/${encodeURIComponent(providerId)}/business-registration/raw`,
    );
    return { status: 'shown', registrationNumber: raw.registration.number, legacyTaxNumber: raw.legacy.taxNumber };
  } catch {
    return { status: 'error', message: 'Ham değer okunamadı. Yetkinizi kontrol edin.' };
  }
}
