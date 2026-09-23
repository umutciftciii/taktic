'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch } from '../../lib/api';

/**
 * CMP-006 PR-B — the operator's refund actions.
 *
 * Every one of them is a request to the API, which re-checks the permission,
 * the gate, the current status and (for an approval) the eligibility inside
 * its own transaction; the buttons on the screen are the API's `allowedActions`
 * and nothing more. There is deliberately no "mark as refunded" action: the
 * payment provider's signed webhook is the only thing that settles a request.
 *
 * Refusals come back in the query string, verbatim from the API, so an
 * operator sees *why* (maker-checker, eligibility changed, gate closed).
 */

export async function takePackageRefundAction(formData: FormData) {
  const id = readString(formData, 'id');
  await submit(id, `/admin/package-refund-requests/${encodeURIComponent(id)}/take`, {}, 'taken');
}

export async function approvePackageRefundAction(formData: FormData) {
  const id = readString(formData, 'id');
  const kind = readString(formData, 'kind');
  const body =
    kind === 'EXCEPTION'
      ? {
          kind,
          exceptionGround: readString(formData, 'exceptionGround'),
          exceptionReason: readString(formData, 'exceptionReason'),
        }
      : { kind: 'NORMAL' };
  await submit(id, `/admin/package-refund-requests/${encodeURIComponent(id)}/approve`, body, 'approved');
}

export async function rejectPackageRefundAction(formData: FormData) {
  const id = readString(formData, 'id');
  await submit(
    id,
    `/admin/package-refund-requests/${encodeURIComponent(id)}/reject`,
    { reason: readString(formData, 'reason') },
    'rejected',
  );
}

export async function markPackageRefundSettlementFailedAction(formData: FormData) {
  const id = readString(formData, 'id');
  await submit(
    id,
    `/admin/package-refund-requests/${encodeURIComponent(id)}/settlement-failed`,
    { reason: readString(formData, 'reason') },
    'failed',
  );
}

/** Opening a request on a provider's existing ticket, from the ticket screen. */
export async function openPackageRefundRequestAction(formData: FormData) {
  const ticketId = readString(formData, 'supportTicketId');
  const purchaseId = readString(formData, 'purchaseId');
  if (!ticketId) {
    redirect('/support');
  }
  if (!purchaseId) {
    redirect(`/support/${ticketId}?error=${encodeURIComponent('Bir satın alma seçin.')}`);
  }

  let createdId: string | null = null;
  let failure: string | null = null;
  try {
    const created = await apiFetch<{ id: string }>('/admin/package-refund-requests', {
      method: 'POST',
      body: JSON.stringify({ supportTicketId: ticketId, purchaseId }),
    });
    createdId = created.id;
  } catch (error) {
    if (isRedirectError(error)) throw error;
    failure = extractApiMessage(error);
  }

  revalidatePath(`/support/${ticketId}`);
  revalidatePath('/package-refunds');
  if (!createdId) {
    redirect(`/support/${ticketId}?error=${encodeURIComponent(failure ?? 'İade isteği açılamadı.')}`);
  }
  redirect(`/package-refunds/${createdId}?done=created`);
}

async function submit(id: string, path: string, body: Record<string, unknown>, done: string) {
  if (!id) {
    redirect('/package-refunds');
  }

  let failure: string | null = null;
  try {
    await apiFetch<unknown>(path, { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    failure = extractApiMessage(error);
  }

  revalidatePath('/package-refunds');
  revalidatePath(`/package-refunds/${id}`);
  const params = new URLSearchParams(failure ? { error: failure } : { done });
  redirect(`/package-refunds/${id}?${params.toString()}`);
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function extractApiMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Beklenmeyen hata.';
  const raw = error.message;
  try {
    const parsed = JSON.parse(raw) as { message?: string | string[]; error?: string };
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.message)) return parsed.message.join(' · ');
      if (typeof parsed.message === 'string') return parsed.message;
      if (typeof parsed.error === 'string') return parsed.error;
    }
  } catch {
    /* fall through */
  }
  return raw || 'Beklenmeyen hata.';
}

function isRedirectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}
