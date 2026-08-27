'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, NotificationLogEntry } from '../../lib/api';

/**
 * Asks the API to re-send one failed notification.
 *
 * The action forwards an id and nothing else. There is no recipient, no
 * template and no message content here to forward — the API rebuilds all of it
 * from domain data — so a tampered form can only ever name a different row,
 * which the API then judges by its own rules.
 *
 * The outcome is carried back in the query string rather than swallowed,
 * because a retry that ran and failed again looks identical to one that never
 * ran unless the screen says so.
 */
export async function retryNotificationAction(formData: FormData) {
  const id = readString(formData, 'id');
  if (!id) {
    redirect('/notifications');
  }

  const target = readString(formData, 'returnTo') || `/notifications/${id}`;

  let entry: NotificationLogEntry | null = null;
  let errorMessage: string | null = null;

  try {
    entry = await apiFetch<NotificationLogEntry>(
      `/notification-logs/${encodeURIComponent(id)}/retry`,
      { method: 'POST' },
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  revalidatePath('/notifications');
  revalidatePath(`/notifications/${id}`);

  if (errorMessage) {
    redirect(withParams(target, { retry: 'error', message: errorMessage }));
  }

  // A settled attempt, either way. SENT is the success; anything else means the
  // send ran and did not land, and the row's own error class explains it.
  redirect(withParams(target, { retry: entry?.status === 'SENT' ? 'sent' : 'failed' }));
}

function withParams(target: string, params: Record<string, string>): string {
  const [path, existing] = target.split('?');
  const search = new URLSearchParams(existing ?? '');
  for (const [key, value] of Object.entries(params)) {
    search.set(key, value);
  }

  return `${path}?${search.toString()}`;
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
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
