'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  MarketplacePublishSettings,
  OperationsSettings,
  ProviderReviewSettings,
  SCHEDULER_JOB_KEYS,
  SchedulerSettings,
} from '../../lib/api';

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

/**
 * Switches one background job on or off.
 *
 * The form posts the job it means and the state it wants; neither is derived
 * from anything the operator typed. The key is checked against the closed list
 * before a request is made — not because the API would accept an unknown one
 * (it answers 404) but because a mistyped key should not turn into a redirect
 * carrying an upstream error message.
 *
 * Nothing about who is doing this travels in the payload: the API takes the
 * operator from the session and writes that name into the audit row.
 */
export async function toggleSchedulerAction(formData: FormData) {
  const job = readString(formData, 'job').trim();
  const enabled = readString(formData, 'enabled').trim();

  if (!(SCHEDULER_JOB_KEYS as readonly string[]).includes(job)) {
    redirect(schedulerUrl({ error: 'Böyle bir zamanlanmış iş yok.' }));
  }

  if (enabled !== 'true' && enabled !== 'false') {
    redirect(schedulerUrl({ error: 'Zamanlanmış iş durumu yalnızca açık veya kapalı olabilir.' }));
  }

  let errorMessage: string | null = null;
  try {
    await apiFetch<SchedulerSettings>(
      `/operations-settings/schedulers/${encodeURIComponent(job)}`,
      { method: 'PUT', body: JSON.stringify({ enabled: enabled === 'true' }) },
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  if (errorMessage) {
    redirect(schedulerUrl({ error: errorMessage }));
  }

  revalidatePath('/operations-settings');
  redirect(schedulerUrl({ ok: enabled === 'true' ? 'scheduler-on' : 'scheduler-off' }));
}

/** Always back to the jobs card, so the operator lands on what they changed. */
function schedulerUrl(params: Record<string, string>): string {
  return `/operations-settings?${new URLSearchParams(params).toString()}#zamanlanmis-isler`;
}

/**
 * Switches marketplace auto-publish on or off.
 *
 * The same shape as `toggleSchedulerAction`, on its own endpoint: the form
 * posts the state it wants, computed from what is currently true, so a double
 * submission asks for the same thing twice and the audit trail records one
 * change. The operator's identity comes from the session on the API side.
 *
 * Only the *next* request is affected. One already waiting in "Yeni Talep"
 * stays there until a moderator acts on it, and one already published is not
 * pulled back when the switch goes off.
 */
export async function toggleAutoPublishAction(formData: FormData) {
  const enabled = readString(formData, 'enabled').trim();

  if (enabled !== 'true' && enabled !== 'false') {
    redirect(autoPublishUrl({ error: 'Otomatik yayın durumu yalnızca açık veya kapalı olabilir.' }));
  }

  let errorMessage: string | null = null;
  try {
    await apiFetch<MarketplacePublishSettings>('/operations-settings/marketplace-publish', {
      method: 'PUT',
      body: JSON.stringify({ enabled: enabled === 'true' }),
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  if (errorMessage) {
    redirect(autoPublishUrl({ error: errorMessage }));
  }

  revalidatePath('/operations-settings');
  revalidatePath('/requests');
  redirect(autoPublishUrl({ ok: enabled === 'true' ? 'auto-publish-on' : 'auto-publish-off' }));
}

/** Back to the auto-publish card, so the operator lands on what they changed. */
function autoPublishUrl(params: Record<string, string>): string {
  return `/operations-settings?${new URLSearchParams(params).toString()}#otomatik-yayin`;
}

/**
 * Switches provider reviews on or off.
 *
 * The same shape as the two toggles above, on its own endpoint. What the
 * switch governs is on the API side: with it off, no customer can write a
 * review, no invitation is mailed, and every public surface reads as if
 * reviews did not exist — while existing rows stay where they are. Turning
 * it back on shows them again unchanged.
 *
 * The API accepts this from a SUPER_ADMIN alone, which is every operator
 * this panel signs in; the identity comes from the session, never the form.
 */
export async function toggleProviderReviewsAction(formData: FormData) {
  const enabled = readString(formData, 'enabled').trim();

  if (enabled !== 'true' && enabled !== 'false') {
    redirect(
      providerReviewsUrl({ error: 'Değerlendirme durumu yalnızca açık veya kapalı olabilir.' }),
    );
  }

  let errorMessage: string | null = null;
  try {
    await apiFetch<ProviderReviewSettings>('/operations-settings/provider-reviews', {
      method: 'PUT',
      body: JSON.stringify({ enabled: enabled === 'true' }),
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  if (errorMessage) {
    redirect(providerReviewsUrl({ error: errorMessage }));
  }

  revalidatePath('/operations-settings');
  revalidatePath('/provider-reviews/reports');
  redirect(providerReviewsUrl({ ok: enabled === 'true' ? 'provider-reviews-on' : 'provider-reviews-off' }));
}

/** Back to the reviews card, so the operator lands on what they changed. */
function providerReviewsUrl(params: Record<string, string>): string {
  return `/operations-settings?${new URLSearchParams(params).toString()}#degerlendirmeler`;
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
