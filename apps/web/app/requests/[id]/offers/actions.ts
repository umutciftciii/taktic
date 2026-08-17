'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, ApiError, CustomerServiceRequest } from '../../../../lib/api';

/**
 * Marks a matched request as delivered. The API only accepts this from the
 * customer who owns the request (or an admin), and only while the request is
 * MATCHED, so nothing here needs to re-check either.
 */
export async function completeRequestAction(formData: FormData) {
  const requestId = readFormString(formData, 'requestId');

  await apiFetch<CustomerServiceRequest>(`/service-requests/${requestId}/complete`, {
    method: 'POST',
  });

  revalidatePath('/requests/my');
  revalidatePath(`/requests/${requestId}/offers`);
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
