'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, CompanySettings } from '../../lib/api';

/**
 * Saves the company footer.
 *
 * Validation is deliberately duplicated rather than delegated: the checks below
 * catch the obvious mistakes without a round trip, and the API applies the real
 * rules again on the DTO — a form is a convenience, never the authority. A
 * value that slips past this function is still refused there, and the message
 * that comes back is what the screen shows.
 */
export async function saveCompanySettingsAction(formData: FormData) {
  const draft = {
    legalName: readString(formData, 'legalName').trim(),
    supportEmail: readString(formData, 'supportEmail').trim(),
    postalAddress: readString(formData, 'postalAddress').trim(),
  };

  const clientError = validate(draft);
  if (clientError) {
    redirect(buildUrl(draft, { error: clientError }));
  }

  let errorMessage: string | null = null;
  try {
    await apiFetch<CompanySettings>('/company-settings', {
      method: 'PUT',
      body: JSON.stringify({
        legalName: draft.legalName,
        supportEmail: draft.supportEmail,
        postalAddress: draft.postalAddress || null,
      }),
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  if (errorMessage) {
    // The values the operator typed are carried back so a rejected save does
    // not cost them their keystrokes.
    redirect(buildUrl(draft, { error: errorMessage }));
  }

  revalidatePath('/company-settings');
  redirect('/company-settings?ok=saved');
}

function validate(draft: { legalName: string; supportEmail: string }): string | null {
  if (draft.legalName.length < 2) {
    return 'Yasal unvan zorunludur ve en az 2 karakter olmalıdır.';
  }
  if (draft.legalName === 'TakTick') {
    return 'Yasal unvan ürün adı olamaz; altbilgi göndereni tanımlar, ürünü değil.';
  }
  if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(draft.supportEmail)) {
    return 'Destek e-postası geçerli bir adres olmalıdır.';
  }
  if (draft.supportEmail.toLowerCase() === 'destek@example.test') {
    return 'Destek e-postası örnek/placeholder adres olamaz.';
  }
  return null;
}

function buildUrl(
  draft: { legalName: string; supportEmail: string; postalAddress: string },
  extra: Record<string, string>,
): string {
  const params = new URLSearchParams(extra);
  if (draft.legalName) params.set('legalName', draft.legalName);
  if (draft.supportEmail) params.set('supportEmail', draft.supportEmail);
  if (draft.postalAddress) params.set('postalAddress', draft.postalAddress);
  return `/company-settings?${params.toString()}`;
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
