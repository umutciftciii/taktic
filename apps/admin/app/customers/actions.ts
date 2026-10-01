'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  CustomerActivationLinkResponse,
  CustomerNote,
  UpdateCustomerStatusResponse,
} from '../../lib/api';
import { rethrowNextControlFlow } from '../../lib/next-control-flow';
import type { ActivationLinkState } from './activation-link-state';
import { hasConfirmationProof } from '../../lib/confirmation-proof-server';
import { CONFIRMATION_PROOF_REFUSAL_MESSAGE } from '../../lib/confirmation-proof-keys';

export async function createCustomerNoteAction(formData: FormData) {
  const customerId = readFormString(formData, 'customerId');
  const note = readFormString(formData, 'note').trim();

  if (!customerId || note.length < 2) {
    return;
  }

  await apiFetch<CustomerNote>(`/customers/${customerId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });

  revalidatePath(`/customers/${customerId}`);
}

export async function updateCustomerStatusAction(formData: FormData) {
  const customerId = readFormString(formData, 'customerId');
  const isActive = readFormString(formData, 'isActive') === 'true';

  if (!customerId) {
    return;
  }

  // Both directions are confirmed in a dialog, each with its own key: a proof
  // for turning an account back on cannot passivate one, and the other way
  // round (ADMIN-DESTRUCTIVE-CONFIRMATION-001, Faz 1 and Faz 2).
  const confirmed = isActive
    ? await hasConfirmationProof(formData, 'customer.activate')
    : await hasConfirmationProof(formData, 'customer.status');
  if (!confirmed) {
    redirect(`/customers/${customerId}?statusError=${encodeURIComponent(CONFIRMATION_PROOF_REFUSAL_MESSAGE)}`);
  }

  await apiFetch<UpdateCustomerStatusResponse>(`/customers/${customerId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  });

  revalidatePath('/customers');
  revalidatePath(`/customers/${customerId}`);
}

/**
 * Issues a password-set link. The first one goes straight through; issuing
 * again — which voids the link already handed out — is confirmed in a dialog
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001, Faz 2).
 *
 * "Again" is what the form says (`replaces=1`, written only on the reissue
 * button) or what the previous state shows (a link was issued, or a reissue
 * was refused). The API does not tell the panel whether an unused link exists,
 * so a submission that claims to be a first issue is one; the guard is
 * against the pre-hydration click and the JavaScript-less post of the reissue
 * button, which both carry `replaces=1`.
 */
export async function createCustomerActivationLinkAction(
  previous: ActivationLinkState,
  formData: FormData,
): Promise<ActivationLinkState> {
  const customerId = readFormString(formData, 'customerId');
  const reissue = isActivationLinkReissue(previous, formData);
  const failed = (message: string): ActivationLinkState =>
    reissue ? { kind: 'error', message, reissue: true } : { kind: 'error', message };

  if (!customerId) {
    return failed('Aktivasyon linki oluşturulamadı.');
  }

  if (reissue && !(await hasConfirmationProof(formData, 'customer.activation-link-reissue'))) {
    return failed(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
  }

  let result: CustomerActivationLinkResponse;
  try {
    result = await apiFetch<CustomerActivationLinkResponse>(
      `/customers/${customerId}/activation-link`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  } catch (error) {
    // A 401/403 is a navigation (to /login or /yetkisiz), not a message.
    rethrowNextControlFlow(error);
    const message =
      error instanceof Error
        ? parseBackendMessage(error.message)
        : 'Aktivasyon linki oluşturulamadı.';
    return failed(message);
  }

  // The link goes back in the action's state and nowhere else. It is not put
  // in a redirect URL, a cookie or the page cache (see activation-link-form).
  return { kind: 'issued', activationUrl: result.activationUrl, expiresAt: result.expiresAt };
}

function isActivationLinkReissue(previous: ActivationLinkState, formData: FormData): boolean {
  if (readFormString(formData, 'replaces') === '1') return true;
  return previous?.kind === 'issued' || (previous?.kind === 'error' && previous.reissue === true);
}

function parseBackendMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed?.message === 'string') return parsed.message;
    if (Array.isArray(parsed?.message) && typeof parsed.message[0] === 'string') {
      return parsed.message[0];
    }
  } catch {
    // ignore
  }
  return raw || 'Aktivasyon linki oluşturulamadı.';
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
