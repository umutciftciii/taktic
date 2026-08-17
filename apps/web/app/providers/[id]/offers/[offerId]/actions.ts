'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch, ProviderOffer } from '../../../../../lib/api';

/**
 * Withdraws the provider's own offer.
 *
 * Both failure modes the API can report here are expected outcomes rather than
 * crashes, so they land back on the offer screen with an explanation instead of
 * the generic error boundary: a 409 means the offer stopped being withdrawable
 * (the customer acted first, another tab already withdrew it, or the request
 * closed), and a 401/403/404 means this session may not touch this offer at all.
 */
export async function withdrawOfferAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');
  const offerId = readFormString(formData, 'offerId');
  const detailPath = `/providers/${providerId}/offers/${offerId}`;

  let outcome: 'ok' | 'conflict' | 'denied' = 'ok';

  try {
    await apiFetch<ProviderOffer>(`/providers/${providerId}/offers/${offerId}/withdraw`, {
      method: 'POST',
    });
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error;
    }

    if (error.status === 409) {
      outcome = 'conflict';
    } else if (error.status === 401 || error.status === 403 || error.status === 404) {
      outcome = 'denied';
    } else {
      throw error;
    }
  }

  // Even a refused withdrawal revalidates: a 409 usually means the record moved
  // on, and the screen must show what it moved to rather than the stale state
  // the provider clicked from.
  revalidatePath(detailPath);
  revalidatePath(`/providers/${providerId}/offers`);

  redirect(outcome === 'ok' ? detailPath : `${detailPath}?withdrawError=${outcome}`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
