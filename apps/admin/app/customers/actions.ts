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

  // Passivating is confirmed in a dialog; activating is not
  // (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
  if (!isActive && !(await hasConfirmationProof(formData, 'customer.status'))) {
    redirect(`/customers/${customerId}?statusError=${encodeURIComponent(CONFIRMATION_PROOF_REFUSAL_MESSAGE)}`);
  }

  await apiFetch<UpdateCustomerStatusResponse>(`/customers/${customerId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  });

  revalidatePath('/customers');
  revalidatePath(`/customers/${customerId}`);
}

export async function createCustomerActivationLinkAction(
  _previous: ActivationLinkState,
  formData: FormData,
): Promise<ActivationLinkState> {
  const customerId = readFormString(formData, 'customerId');

  if (!customerId) {
    return { kind: 'error', message: 'Aktivasyon linki oluşturulamadı.' };
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
    return { kind: 'error', message };
  }

  // The link goes back in the action's state and nowhere else. It is not put
  // in a redirect URL, a cookie or the page cache (see activation-link-form).
  return { kind: 'issued', activationUrl: result.activationUrl, expiresAt: result.expiresAt };
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
