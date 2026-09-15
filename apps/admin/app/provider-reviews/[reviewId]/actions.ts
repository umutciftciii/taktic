'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch, type AdminReviewDetail } from '../../../lib/api';

/**
 * The operator's decision on one review: take the comment down, take the
 * whole review down, or put it back.
 *
 * The API does everything in one transaction — the conditional update, the
 * moderation log row, the closing of any open report, the customer's notice
 * — and refuses with a 409 when the review is already in the asked-for
 * state, which is what two operators deciding at once produces: one wins,
 * the other reads "already done". That refusal and the missing reason are
 * the two answers this action words; anything else reaches the error
 * boundary.
 */
export async function moderateReviewAction(formData: FormData) {
  const reviewId = readFormString(formData, 'reviewId');
  const action = readFormString(formData, 'action');
  const reason = readOptionalFormString(formData, 'reason');
  const target = `/provider-reviews/${reviewId}`;

  if (action !== 'REMOVE_COMMENT' && action !== 'REMOVE_REVIEW' && action !== 'RESTORE') {
    redirect(`${target}?error=action`);
  }

  // The API refuses a removal without a reason with a 400, which would land
  // on the generic error page. The browser's `required` normally catches this
  // first; this is the guard for a submission that bypassed it.
  if (action !== 'RESTORE' && !reason) {
    redirect(`${target}?error=reason`);
  }

  let detail: AdminReviewDetail;
  try {
    detail = await apiFetch<AdminReviewDetail>(`/provider-reviews/${reviewId}/moderate`, {
      method: 'POST',
      body: JSON.stringify({
        action,
        ...(action !== 'RESTORE' ? { reason } : {}),
        note: readOptionalFormString(formData, 'note'),
      }),
    });
  } catch (error) {
    if (apiErrorCode(error) === 'REVIEW_MODERATION_NOOP') {
      redirect(`${target}?error=noop`);
    }
    throw error;
  }

  revalidateReview(reviewId, detail.provider.id, detail.request.id);
  redirect(`${target}?ok=${action}`);
}

/** Closes the open report as "fine as it is"; the review stays as it was. */
export async function dismissReviewReportAction(formData: FormData) {
  const reviewId = readFormString(formData, 'reviewId');
  const target = `/provider-reviews/${reviewId}`;

  let detail: AdminReviewDetail;
  try {
    detail = await apiFetch<AdminReviewDetail>(`/provider-reviews/${reviewId}/reports/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ resolutionNote: readOptionalFormString(formData, 'resolutionNote') }),
    });
  } catch (error) {
    if (apiErrorCode(error) === 'NO_OPEN_REVIEW_REPORT') {
      redirect(`${target}?error=noOpen`);
    }
    throw error;
  }

  revalidateReview(reviewId, detail.provider.id, detail.request.id);
  redirect(`${target}?ok=DISMISSED`);
}

function revalidateReview(reviewId: string, providerId: string, requestId: string) {
  revalidatePath('/provider-reviews/reports');
  revalidatePath(`/provider-reviews/${reviewId}`);
  revalidatePath(`/providers/${providerId}`);
  revalidatePath(`/requests/${requestId}`);
}

/** The machine-readable `code` from an ApiError body, whatever the status. */
function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
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

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
