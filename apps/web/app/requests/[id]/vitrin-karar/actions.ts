'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ApiError, apiFetch } from '../../../../lib/api';

/**
 * The customer's answer after their vitrin lead's deadline passed.
 *
 * Two outcomes and nothing else. There is no "wait a bit longer" option,
 * deliberately: the business has already had the time it promised, and a third
 * button whose meaning was "ask me again" would be a decision the product would
 * then have to keep asking about.
 *
 * The decision is sent as a code and the API decides what it does. In
 * particular this action does **not** decide that a release goes to the market
 * immediately — it does not: the request re-enters ordinary moderation, and an
 * operator reads it before any second business sees it. That is the whole
 * answer to this flow having skipped moderation on the way in.
 */
export async function decideShowcaseFallbackAction(formData: FormData) {
  const requestId = readString(formData, 'requestId');
  const decision = readString(formData, 'decision');
  const target = `/requests/${requestId}/vitrin-karar`;

  try {
    await apiFetch(`/service-requests/${requestId}/showcase-fallback`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
  } catch (error) {
    redirect(`${target}?error=${errorCode(error)}`);
  }

  revalidatePath(target);
  revalidatePath('/requests/my');
  redirect(`${target}?decided=${decision === 'RELEASE' ? 'release' : 'closed'}`);
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function errorCode(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.body) as { code?: unknown };
      if (typeof parsed.code === 'string') {
        return encodeURIComponent(parsed.code);
      }
    } catch {
      // Not JSON, or JSON with no code.
    }
  }

  return 'SHOWCASE_FALLBACK_FAILED';
}
