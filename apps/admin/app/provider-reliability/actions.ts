'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from '../../lib/api';
import { hasConfirmationProof } from '../../lib/confirmation-proof-server';
import { rethrowNextControlFlow } from '../../lib/next-control-flow';
import { readApiErrorCode } from '../../lib/service-incidents';

/**
 * REL-002 Faz 4 — the provider reliability review workflow: take a review on
 * (Üstlen) and close it with a note (Sonuçlandır). Neither changes anything
 * about the provider's account; suspending stays the provider screen's own
 * moderation flow.
 *
 * Both are asked first and refused without the dialog's proof. The operator
 * goes back where they pressed the button: the queue, or the provider's
 * "Güvenilirlik" card — never to an address taken from the form.
 */

export async function acknowledgeReliabilityReviewAction(formData: FormData) {
  const reviewId = readString(formData, 'reviewId');
  const back = returnPath(formData);
  if (!reviewId) redirect(back.path);
  if (!(await hasConfirmationProof(formData, 'reliability-review.acknowledge'))) {
    redirect(back.with({ reliability: 'confirmation' }));
  }
  await submit(`/admin/provider-reliability-reviews/${encodeURIComponent(reviewId)}/acknowledge`, {}, 'acknowledged', back);
}

export async function resolveReliabilityReviewAction(formData: FormData) {
  const reviewId = readString(formData, 'reviewId');
  const back = returnPath(formData);
  if (!reviewId) redirect(back.path);
  if (!(await hasConfirmationProof(formData, 'reliability-review.resolve'))) {
    redirect(back.with({ reliability: 'confirmation' }));
  }
  await submit(
    `/admin/provider-reliability-reviews/${encodeURIComponent(reviewId)}/resolve`,
    { note: readString(formData, 'note') },
    'resolved',
    back,
  );
}

type Back = { path: string; with: (params: Record<string, string>) => string };

/** `/provider-reliability`, or one provider's card when the form says it came from there. */
function returnPath(formData: FormData): Back {
  const providerId = readString(formData, 'providerId');
  if (readString(formData, 'from') === 'provider' && /^[\w-]{1,64}$/.test(providerId)) {
    const path = `/providers/${encodeURIComponent(providerId)}`;
    return {
      path,
      with: (params) => `${path}?${new URLSearchParams(params).toString()}#guvenilirlik`,
    };
  }
  const path = '/provider-reliability';
  const filter = readString(formData, 'filter');
  const keep: Record<string, string> = ['WARNING', 'ADMIN_REVIEW_REQUIRED', 'review'].includes(filter) ? { filter } : {};
  return { path, with: (params) => `${path}?${new URLSearchParams({ ...keep, ...params }).toString()}` };
}

async function submit(path: string, body: Record<string, unknown>, done: string, back: Back) {
  let failure: string | null = null;
  try {
    await apiFetch<unknown>(path, { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    rethrowNextControlFlow(error);
    failure =
      error instanceof ApiError
        ? (readApiErrorCode(error.body) ?? (error.status === 404 ? 'NOT_FOUND' : 'error'))
        : 'error';
  }
  revalidatePath('/provider-reliability');
  revalidatePath(back.path);
  redirect(back.with({ reliability: failure ?? done }));
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
