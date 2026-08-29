'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AdminProviderServiceCategories,
  ApiError,
  apiFetch,
  ProviderClaimInviteResult,
  ProviderProfile,
  ProviderStatus,
} from '../../lib/api';

export async function updateProviderStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const status = readFormString(formData, 'status') as ProviderStatus;

  await apiFetch<ProviderProfile>(`/providers/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({
      status,
      moderationNote: readOptionalFormString(formData, 'moderationNote'),
      rejectionReason: readOptionalFormString(formData, 'rejectionReason'),
    }),
  });

  revalidatePath('/providers');
  revalidatePath(`/providers/${id}`);
}

/**
 * Binds this provider to a category, or says why it could not.
 *
 * The search text the operator typed is carried back in the redirect so the
 * result lands on the list they were working through rather than resetting it —
 * attaching five providers to one draft is the actual task, and losing the
 * query after each one would make it five searches.
 */
export async function addProviderServiceCategoryAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const categoryId = readFormString(formData, 'categoryId');
  const query = readFormString(formData, 'categoryQuery');

  let result: AdminProviderServiceCategories & { created: boolean };
  try {
    result = await apiFetch<AdminProviderServiceCategories & { created: boolean }>(
      `/providers/${id}/service-categories`,
      { method: 'POST', body: JSON.stringify({ categoryId }) },
    );
  } catch (error) {
    redirect(providerCategoryUrl(id, query, categoryFailureCode(error)));
  }

  revalidatePath('/providers');
  revalidatePath(`/providers/${id}`);
  // "Added" and "was already there" are different sentences on purpose: the
  // second is what an operator sees when they attach the same pair twice, and
  // it has to read as a completed request rather than as a silent no-op.
  redirect(providerCategoryUrl(id, query, result.created ? 'added' : 'already'));
}

export async function removeProviderServiceCategoryAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const categoryId = readFormString(formData, 'categoryId');
  const query = readFormString(formData, 'categoryQuery');

  try {
    await apiFetch<AdminProviderServiceCategories>(
      `/providers/${id}/service-categories/${categoryId}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    redirect(providerCategoryUrl(id, query, categoryFailureCode(error)));
  }

  revalidatePath('/providers');
  revalidatePath(`/providers/${id}`);
  redirect(providerCategoryUrl(id, query, 'removed'));
}

function providerCategoryUrl(id: string, query: string, notice: string): string {
  const params = new URLSearchParams({ categoryNotice: notice });
  if (query.trim()) {
    params.set('categoryQuery', query.trim());
  }

  return `/providers/${id}?${params.toString()}#hizmet-kategorileri`;
}

/** Maps a refusal onto a short code the screen explains in its own words. */
function categoryFailureCode(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'error';
  }

  if (error.body.includes('CATEGORY_NOT_ASSIGNABLE')) {
    return 'not-assignable';
  }

  if (error.status === 404) {
    return 'not-found';
  }

  return 'error';
}

/**
 * Sends the applicant behind an unowned application a fresh claim link.
 *
 * The API answers with a status and an expiry only — no token, no URL, no
 * address — and this action passes on nothing more than an outcome code in the
 * query string. The operator can see the application's own contact address on
 * the same page; the link itself is between the platform and that mailbox.
 */
export async function sendProviderClaimInviteAction(formData: FormData) {
  const id = readFormString(formData, 'id');

  let result: ProviderClaimInviteResult;
  try {
    result = await apiFetch<ProviderClaimInviteResult>(`/providers/${id}/claim-invitations`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (error) {
    redirect(`/providers/${id}?claimInvite=${inviteFailureCode(error)}`);
  }

  revalidatePath(`/providers/${id}`);
  redirect(`/providers/${id}?claimInvite=${result.delivery === 'SENT' ? 'sent' : 'undelivered'}`);
}

/**
 * Maps a refusal onto a short, stable code the screen explains in its own
 * words. The API's message is deliberately not carried through a URL.
 */
function inviteFailureCode(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'error';
  }

  if (error.status === 429) {
    return 'rate-limited';
  }

  for (const code of ['CLAIM_EMAIL_MISSING', 'CLAIM_ALREADY_COMPLETED', 'CLAIM_NOT_AVAILABLE']) {
    if (error.body.includes(code)) {
      return code.toLowerCase().replace(/_/g, '-');
    }
  }

  if (error.body.includes('PROVIDER_CLAIM_DISABLED')) {
    return 'disabled';
  }

  return 'error';
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
