'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
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
