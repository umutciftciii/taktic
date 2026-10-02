'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  CustomerActivationLinkResponse,
  readConflict,
  CustomerNote,
  UpdateCustomerStatusResponse,
} from '../../lib/api';
import { rethrowNextControlFlow } from '../../lib/next-control-flow';
import type { ActivationLinkState } from './activation-link-state';
import { hasConfirmationProof } from '../../lib/confirmation-proof-server';
import { CONFIRMATION_PROOF_FIELD, CONFIRMATION_PROOF_REFUSAL_MESSAGE } from '../../lib/confirmation-proof-keys';

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
 * Issues a password-set link. Issuing over a link that is still live (unused,
 * unexpired) voids it, so that is confirmed in a dialog
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001, Faz 2) — and whether a live link exists
 * is decided by the API, never by this form or its state.
 *
 * - No proof in the submission: the API is asked for a link *without* consent
 *   to replace (`replaceExisting: false`). With no live link it issues one;
 *   with one it refuses with 409 ACTIVATION_LINK_ALREADY_ACTIVE and writes
 *   nothing, and the screen switches to the confirmed reissue.
 * - A proof in the submission: it must verify for
 *   `customer.activation-link-reissue` (spent here, once), and only then is
 *   `replaceExisting: true` sent. A forged, replayed or foreign proof is
 *   refused before any request.
 *
 * The API makes the check and the write under one per-customer lock, so two
 * concurrent "first" issues cannot both succeed over each other.
 */
export async function createCustomerActivationLinkAction(
  _previous: ActivationLinkState,
  formData: FormData,
): Promise<ActivationLinkState> {
  const customerId = readFormString(formData, 'customerId');
  const proofSubmitted = readFormString(formData, CONFIRMATION_PROOF_FIELD) !== '';

  if (!customerId) {
    return { kind: 'error', message: 'Aktivasyon linki oluşturulamadı.' };
  }

  if (proofSubmitted && !(await hasConfirmationProof(formData, 'customer.activation-link-reissue'))) {
    return { kind: 'error', message: CONFIRMATION_PROOF_REFUSAL_MESSAGE, reissue: true };
  }

  let result: CustomerActivationLinkResponse;
  try {
    result = await apiFetch<CustomerActivationLinkResponse>(
      `/customers/${customerId}/activation-link`,
      {
        method: 'POST',
        body: JSON.stringify({ replaceExisting: proofSubmitted }),
      },
    );
  } catch (error) {
    // A 401/403 is a navigation (to /login or /yetkisiz), not a message.
    rethrowNextControlFlow(error);
    if (readConflict(error)?.code === 'ACTIVATION_LINK_ALREADY_ACTIVE') {
      return { kind: 'error', message: ACTIVATION_LINK_LIVE_MESSAGE, reissue: true };
    }
    const message =
      error instanceof Error
        ? parseBackendMessage(error.message)
        : 'Aktivasyon linki oluşturulamadı.';
    return proofSubmitted ? { kind: 'error', message, reissue: true } : { kind: 'error', message };
  }

  // The link goes back in the action's state and nowhere else. It is not put
  // in a redirect URL, a cookie or the page cache (see activation-link-form).
  return { kind: 'issued', activationUrl: result.activationUrl, expiresAt: result.expiresAt };
}

const ACTIVATION_LINK_LIVE_MESSAGE =
  'Bağlantı oluşturulmadı: bu müşterinin henüz kullanılmamış, geçerli bir şifre belirleme bağlantısı var. Yeni bağlantı onu geçersiz kılar; devam etmek için “Yeni bağlantı oluştur” ile onaylayın.';

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
