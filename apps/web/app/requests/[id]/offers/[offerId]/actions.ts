'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, ApiError, RequestOfferDetail } from '../../../../../lib/api';

/**
 * Shortlist, reject, accept.
 *
 * The contact-sharing acknowledgement travels with an accept because that is
 * the request it belongs to: the API records the consent and writes the reveal
 * inside the same transaction that matches the request, so a stored consent
 * always belongs to a match that really happened.
 *
 * Nothing here decides anything. The checkbox is `required` in the markup and
 * re-checked by the API; this function only forwards what the form carried and
 * reports back what the API answered — a refusal used to surface as an
 * unhandled error page, which told the customer nothing about what to do.
 */
export async function customerOfferAction(formData: FormData) {
  const requestId = readFormString(formData, 'requestId');
  const offerId = readFormString(formData, 'offerId');
  const action = readFormString(formData, 'action');
  const disclosureAccepted = formData.get('contactDisclosureAccepted') === 'true';
  const disclosureVersion = readFormString(formData, 'contactDisclosureVersion');

  let errorMessage: string | null = null;

  try {
    await apiFetch<RequestOfferDetail>(`/service-requests/${requestId}/offers/${offerId}/action`, {
      method: 'POST',
      body: JSON.stringify({
        action,
        ...(action === 'ACCEPT'
          ? {
              contactDisclosureAccepted: disclosureAccepted,
              ...(disclosureVersion ? { contactDisclosureVersion: disclosureVersion } : {}),
            }
          : {}),
      }),
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = readApiMessage(error);
  }

  revalidatePath(`/requests/${requestId}/offers`);
  revalidatePath(`/requests/${requestId}/offers/${offerId}`);

  if (errorMessage) {
    const params = new URLSearchParams({ accept: 'error', message: errorMessage });
    redirect(`/requests/${requestId}/offers/${offerId}?${params.toString()}`);
  }
}

/**
 * The API's own sentence when it refused, and a neutral one otherwise.
 *
 * Only the business-rule refusals carry a message worth repeating — the
 * disclosure ones say what the customer has to do. Anything else is reported in
 * general terms rather than by echoing a server error onto the screen.
 */
function readApiMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Teklif kabul edilemedi. Lütfen tekrar deneyin.';
  }

  if (error.status === 409 || error.status === 400) {
    try {
      const parsed = JSON.parse(error.body) as { message?: unknown };
      if (typeof parsed?.message === 'string' && parsed.message.trim()) {
        return parsed.message;
      }
    } catch {
      /* fall through */
    }
  }

  return 'Teklif kabul edilemedi. Lütfen tekrar deneyin.';
}

function isRedirectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
