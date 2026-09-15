'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from '../../../../lib/api';

/**
 * Reports one review to the operators and lands back on the list.
 *
 * The API decides everything about the report: that the caller is the
 * reviewed provider (an operator gets a 403 there, never a report on the
 * business's behalf), that the review still has a comment to report, that
 * there is no open report on it yet, and the daily budget. The three refusals
 * it words for the provider come back as a query flag the page turns into a
 * sentence; anything else is a real failure and reaches the error boundary.
 */
export async function reportReviewAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');
  const reviewId = readFormString(formData, 'reviewId');
  const base = `/providers/${providerId}/degerlendirmeler`;

  try {
    await apiFetch(`/providers/${providerId}/reviews/${reviewId}/reports`, {
      method: 'POST',
      body: JSON.stringify({
        reason: readFormString(formData, 'reason'),
        note: readOptionalFormString(formData, 'note'),
      }),
    });
  } catch (error) {
    const code = apiErrorCode(error);
    if (code === 'REVIEW_REPORT_ALREADY_EXISTS') redirect(`${base}?reportError=exists`);
    if (code === 'REVIEW_REPORT_RATE_LIMITED') redirect(`${base}?reportError=limit`);
    if (code === 'REVIEW_NOT_REPORTABLE') redirect(`${base}?reportError=not-reportable`);
    throw error;
  }

  revalidatePath(base);
  redirect(`${base}?reported=1`);
}

/** The machine-readable `code` from any ApiError body, whatever the status. */
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
