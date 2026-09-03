'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, OperationsSettings } from '../../lib/api';

/**
 * Saves the operations settings.
 *
 * Validation is deliberately duplicated rather than delegated: the checks below
 * catch the obvious mistakes without a round trip, and the API applies the real
 * rules again on the DTO — a form is a convenience, never the authority. A
 * value that slips past this function is still refused there, and the message
 * that comes back is what the screen shows.
 */
export async function saveOperationsSettingsAction(formData: FormData) {
  const raw = readString(formData, 'unviewedOfferRefundWindowHours').trim();

  const clientError = validate(raw);
  if (clientError) {
    redirect(buildUrl(raw, { error: clientError }));
  }

  let errorMessage: string | null = null;
  try {
    await apiFetch<OperationsSettings>('/operations-settings', {
      method: 'PUT',
      body: JSON.stringify({ unviewedOfferRefundWindowHours: Number(raw) }),
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  if (errorMessage) {
    // The value the operator typed is carried back so a rejected save does not
    // cost them their keystrokes.
    redirect(buildUrl(raw, { error: errorMessage }));
  }

  revalidatePath('/operations-settings');
  redirect('/operations-settings?ok=saved');
}

/** The same three rules the DTO enforces: a number, whole hours, in range. */
function validate(raw: string): string | null {
  if (raw === '') {
    return 'Kredi iade süresi zorunludur.';
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 'Kredi iade süresi sayı olmalıdır.';
  }
  if (!Number.isInteger(parsed)) {
    return 'Kredi iade süresi tam saat olarak girilmelidir; ondalık değer kullanılamaz.';
  }
  if (parsed < 1) {
    return 'Kredi iade süresi en az 1 saat olmalıdır.';
  }
  if (parsed > 720) {
    return 'Kredi iade süresi en fazla 720 saat olabilir.';
  }
  return null;
}

function buildUrl(raw: string, extra: Record<string, string>): string {
  const params = new URLSearchParams(extra);
  if (raw) params.set('unviewedOfferRefundWindowHours', raw);
  return `/operations-settings?${params.toString()}`;
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function extractApiMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Beklenmeyen hata.';
  const raw = error.message;
  try {
    const parsed = JSON.parse(raw) as { message?: string | string[]; error?: string };
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.message)) return parsed.message.join(' · ');
      if (typeof parsed.message === 'string') return parsed.message;
      if (typeof parsed.error === 'string') return parsed.error;
    }
  } catch {
    /* fall through */
  }
  return raw || 'Beklenmeyen hata.';
}

function isRedirectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}
