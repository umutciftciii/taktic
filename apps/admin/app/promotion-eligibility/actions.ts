'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch } from '../../lib/api';
import { rethrowNextControlFlow } from '../../lib/next-control-flow';

/**
 * A person's decision on a held event (CMP-006 PR-C). The API re-checks the
 * permission, the reason (10–1000) and that the event is still held, inside
 * its own transaction; a second or concurrent decision comes back as its 409
 * sentence in the query string. Nothing here grants: ELIGIBLE only puts the
 * event back in the worker's queue, once.
 */
export async function decideEligibilityAction(formData: FormData) {
  const eventId = readString(formData, 'eventId');
  if (!eventId) {
    redirect('/promotion-eligibility');
  }
  const decision = readString(formData, 'decision');
  const reason = readString(formData, 'reason').trim();

  let failure: string | null = null;
  if (decision !== 'ELIGIBLE' && decision !== 'INELIGIBLE') {
    failure = 'Bir karar seçin.';
  } else if (reason.length < 10 || reason.length > 1000) {
    failure = 'Gerekçe 10–1000 karakter olmalı.';
  } else {
    try {
      await apiFetch<unknown>(`/admin/promotion-eligibility/holds/${encodeURIComponent(eventId)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason }),
      });
    } catch (error) {
      rethrowNextControlFlow(error);
      failure = extractApiMessage(error);
    }
  }

  revalidatePath('/promotion-eligibility');
  revalidatePath(`/promotion-eligibility/${eventId}`);
  const params = new URLSearchParams(failure ? { error: failure } : { done: decision });
  redirect(`/promotion-eligibility/${encodeURIComponent(eventId)}?${params.toString()}`);
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function extractApiMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Beklenmeyen hata.';
  try {
    const parsed = JSON.parse(error.message) as { message?: string | string[] };
    if (Array.isArray(parsed.message)) return parsed.message.join(' · ');
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    /* fall through */
  }
  return error.message || 'Beklenmeyen hata.';
}
