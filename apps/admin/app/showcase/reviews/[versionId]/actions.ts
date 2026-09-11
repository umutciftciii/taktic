'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch } from '../../../../lib/api';

/**
 * The two things an operator may do to a version: approve it, or refuse it with
 * a reason.
 *
 * Note what neither action carries. There is no provider id, no decision
 * timestamp and no reviewer: the API takes the operator from the session, the
 * version from the path, and refuses anything that is not currently PENDING. A
 * tampered form can only ever name a different version, which the API then
 * judges by its own rules.
 *
 * There is deliberately no third action. An operator cannot edit a card, cannot
 * un-decide a version, and cannot author one — the API has no route for any of
 * the three, and adding one here would have nothing to call.
 */

export async function approveShowcaseVersionAction(formData: FormData) {
  const versionId = readString(formData, 'versionId');
  if (!versionId) {
    redirect('/showcase/reviews');
  }

  // Whether this is the card's first publication has to be read before the
  // approve call, not after: approving is exactly what sets `card.liveVersion`,
  // so the same read afterwards would always say "revision".
  let isFirstPublication = false;
  try {
    const before = await apiFetch<{ card: { liveVersion: unknown } }>(
      `/admin/showcase/versions/${encodeURIComponent(versionId)}`,
    );
    isFirstPublication = before.card.liveVersion === null;
  } catch (error) {
    if (isRedirectError(error)) throw error;
    // Falls through with isFirstPublication left false; the approve call below
    // fails the same way and its own error is what reaches the operator.
  }

  const failure = await run(() =>
    apiFetch<unknown>(
      `/admin/showcase/versions/${encodeURIComponent(versionId)}/approve`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  );

  revalidatePath('/showcase/reviews');
  revalidatePath(`/showcase/reviews/${versionId}`);

  if (failure) {
    redirect(withParams(`/showcase/reviews/${versionId}`, { error: failure }));
  }

  redirect(
    withParams(`/showcase/reviews/${versionId}`, {
      approved: isFirstPublication ? 'first' : 'revision',
    }),
  );
}

export async function rejectShowcaseVersionAction(formData: FormData) {
  const versionId = readString(formData, 'versionId');
  const note = readString(formData, 'note').trim();

  if (!versionId) {
    redirect('/showcase/reviews');
  }

  // Checked here as well as by the DTO and by a database CHECK. Not because the
  // other two are in doubt, but because a provider reads this note: telling the
  // operator beside the field beats a 400 they have to interpret.
  if (note.length < 10) {
    redirect(
      withParams(`/showcase/reviews/${versionId}`, {
        error: 'Ret gerekçesi zorunludur ve en az 10 karakter olmalıdır.',
      }),
    );
  }

  const failure = await run(() =>
    apiFetch<unknown>(
      `/admin/showcase/versions/${encodeURIComponent(versionId)}/reject`,
      { method: 'POST', body: JSON.stringify({ note }) },
    ),
  );

  revalidatePath('/showcase/reviews');
  revalidatePath(`/showcase/reviews/${versionId}`);

  if (failure) {
    redirect(withParams(`/showcase/reviews/${versionId}`, { error: failure }));
  }

  redirect(withParams(`/showcase/reviews/${versionId}`, { rejected: '1' }));
}

/**
 * Runs a call and returns the operator-facing message, or null on success.
 *
 * The message is whatever the API put in the body's `message` field — already
 * Turkish and already written for an operator, for every code this endpoint
 * can return: `SHOWCASE_ENTITLEMENT_MISSING`, `SHOWCASE_PROVIDER_NOT_APPROVED`,
 * `SHOWCASE_CATEGORY_NOT_OFFERED` and `SHOWCASE_AREA_NOT_COVERED` included. There is deliberately no
 * code-to-message map here to keep in sync with the API's own wording.
 */
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
  return `${target}?${new URLSearchParams(params).toString()}`;
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function extractApiMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Beklenmeyen hata.';
  try {
    const parsed = JSON.parse(error.message) as { message?: string | string[]; error?: string };
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.message)) return parsed.message.join(' · ');
      if (typeof parsed.message === 'string') return parsed.message;
      if (typeof parsed.error === 'string') return parsed.error;
    }
  } catch {
    /* fall through */
  }
  return error.message || 'Beklenmeyen hata.';
}

function isRedirectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}
