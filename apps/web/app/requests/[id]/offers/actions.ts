'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  ApiError,
  type CustomerReviewState,
  CustomerServiceRequest,
} from '../../../../lib/api';

/**
 * Marks a matched request as delivered. The API only accepts this from the
 * customer who owns the request (or an admin), and only while the request is
 * MATCHED, so nothing here needs to re-check either.
 *
 * Lands on the review screen rather than back on the offers page: the moment
 * the job is done is the moment the customer is asked about it. The review
 * page itself decides what it shows — the form when reviews are on, and a
 * plain "this request is complete" otherwise — so with the feature off this
 * still ends on a page that makes sense. `redirect` throws, so it sits after
 * the revalidations and outside any try/catch.
 */
export async function completeRequestAction(formData: FormData) {
  const requestId = readFormString(formData, 'requestId');

  await apiFetch<CustomerServiceRequest>(`/service-requests/${requestId}/complete`, {
    method: 'POST',
  });

  revalidatePath('/requests/my');
  revalidatePath(`/requests/${requestId}/offers`);
  redirect(await completionDestination(requestId));
}

/**
 * Where a completed request lands. The review page when the feature is on;
 * the request's own page when it is off, because the review page answers 404
 * then and a customer who just marked a job done must not be shown one.
 * The state read here is the same one the review page reads.
 */
async function completionDestination(requestId: string): Promise<string> {
  try {
    const state = await apiFetch<CustomerReviewState>(`/service-requests/${requestId}/review`);
    if (state.eligibility !== 'disabled') {
      return `/requests/${requestId}/degerlendir`;
    }
  } catch {
    // An unreadable state is not a reason to strand the customer; the
    // offers page is always there.
  }
  return `/requests/${requestId}/offers`;
}

/**
 * Requests a one-time code for the request's phone number.
 *
 * The outcome travels back as a status word in the query string — never the
 * code itself, which the API does not return to anyone.
 */
export async function sendPhoneCodeAction(formData: FormData) {
  const requestId = readFormString(formData, 'requestId');
  const status = await callVerificationApi(`/service-requests/${requestId}/phone-verification`);

  revalidatePath(`/requests/${requestId}/offers`);
  redirect(`/requests/${requestId}/offers?verification=${status}`);
}

export async function verifyPhoneCodeAction(formData: FormData) {
  const requestId = readFormString(formData, 'requestId');
  const code = readFormString(formData, 'code').trim();
  const status = await callVerificationApi(
    `/service-requests/${requestId}/phone-verification/verify`,
    { code },
  );

  revalidatePath('/requests/my');
  revalidatePath(`/requests/${requestId}/offers`);
  redirect(`/requests/${requestId}/offers?verification=${status}`);
}

/** Maps the API result onto a small, safe vocabulary the page can render. */
async function callVerificationApi(path: string, body?: Record<string, string>) {
  try {
    await apiFetch(path, {
      method: 'POST',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return 'ok';
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error;
    }

    if (error.status === 429) return 'rate-limited';
    if (error.status === 400) return 'invalid';
    if (error.status === 409) return 'already-verified';
    return 'failed';
  }
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
