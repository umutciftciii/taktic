'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, type SupportTicketDetail } from '../../lib/api';

/**
 * The two things an operator may do to a ticket: answer it, and move it.
 *
 * Note what neither action carries. There is no customer id, no author and no
 * "from" status: the API takes the operator from the session, the ticket from
 * the path, and judges the move against the status the row actually holds. A
 * tampered form can only ever name a different ticket, which the API then
 * judges by its own rules — and there is no third action, because an operator
 * cannot open a ticket for somebody or hand one to another customer.
 *
 * Every refusal comes back in the query string rather than as an exception. A
 * transition that was refused because somebody else moved the ticket first
 * looks identical to one that never ran unless the screen says so.
 */

export async function replySupportTicketAction(formData: FormData) {
  const id = readString(formData, 'id');
  const body = readString(formData, 'body');

  if (!id) {
    redirect('/support');
  }

  if (!body.trim()) {
    redirect(withParams(`/support/${id}`, { error: 'Mesaj boş olamaz.' }));
  }

  const failure = await run(() =>
    apiFetch<unknown>(`/admin/support/tickets/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  );

  revalidatePath('/support');
  revalidatePath(`/support/${id}`);

  if (failure) {
    redirect(withParams(`/support/${id}`, { error: failure }));
  }

  redirect(withParams(`/support/${id}`, { sent: '1' }));
}

export async function changeSupportTicketStatusAction(formData: FormData) {
  const id = readString(formData, 'id');
  const status = readString(formData, 'status');

  if (!id || !status) {
    redirect('/support');
  }

  const failure = await run(() =>
    apiFetch<SupportTicketDetail>(`/admin/support/tickets/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),
  );

  revalidatePath('/support');
  revalidatePath(`/support/${id}`);

  if (failure) {
    redirect(withParams(`/support/${id}`, { error: failure }));
  }

  redirect(withParams(`/support/${id}`, { statusSaved: '1' }));
}

/** Runs a call and returns the operator-facing message, or null on success. */
async function run(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return extractApiMessage(error);
  }
}

function withParams(target: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `${target}?${search.toString()}`;
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
