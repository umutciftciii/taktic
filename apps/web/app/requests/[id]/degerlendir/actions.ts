'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch, type CustomerReviewState } from '../../../../lib/api';

/**
 * The outcomes the review page can word. Everything the API refuses with a
 * code it recognises comes back as one of these in the query string; anything
 * else is a real failure and reaches the error boundary.
 */
export type ReviewSubmitStatus = 'ok' | 'contact' | 'closed' | 'exists' | 'invalid' | 'failed';

/**
 * Posts the customer's rating and comment for one completed request.
 *
 * Only the rating and the comment travel. The provider is worked out by the
 * API from the accepted offer — the form never names one, so nothing a form
 * could carry decides who is being rated. A second submission for the same
 * job is a 409 the page words as "already reviewed", never a second row.
 */
export async function submitReviewAction(formData: FormData) {
  const requestId = readFormString(formData, 'requestId');
  const rating = Number(readFormString(formData, 'rating'));
  const comment = readFormString(formData, 'comment').trim();
  const target = `/requests/${requestId}/degerlendir`;

  let status: ReviewSubmitStatus = 'ok';
  try {
    await apiFetch<CustomerReviewState>(`/service-requests/${requestId}/review`, {
      method: 'POST',
      body: JSON.stringify({ rating, comment: comment || null }),
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    status = statusFor(error);
  }

  revalidatePath('/requests/my');
  revalidatePath(`/requests/${requestId}/offers`);
  revalidatePath(target);
  redirect(`${target}?review=${status}`);
}

function statusFor(error: ApiError): ReviewSubmitStatus {
  const code = apiErrorCode(error);
  if (error.status === 400 && code === 'CONTACT_DETAILS_IN_TEXT') return 'contact';
  if (error.status === 400) return 'invalid';
  if (error.status === 409 && code === 'REVIEW_WINDOW_CLOSED') return 'closed';
  if (error.status === 409 && code === 'REVIEW_ALREADY_EXISTS') return 'exists';
  return 'failed';
}

/** The machine-readable `code` from an ApiError body, whatever the status. */
function apiErrorCode(error: ApiError): string | null {
  try {
    const parsed = JSON.parse(error.body) as { code?: unknown };
    return typeof parsed?.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
