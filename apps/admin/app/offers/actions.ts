'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, Offer, OfferStatus, readConflict } from '../../lib/api';
import { isCreditBalanceLimitError, offerStatusErrorKey } from '../../lib/status-conflicts';
import { hasConfirmationProof } from '../../lib/confirmation-proof-server';

export async function updateOfferStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const status = readFormString(formData, 'status') as OfferStatus;

  // Accepting and rejecting on the customer's behalf are confirmed in a
  // dialog; shortlisting is not (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
  const proofKey = status === 'ACCEPTED' ? 'offer.accept' : status === 'REJECTED' ? 'offer.reject' : null;
  if (proofKey && !(await hasConfirmationProof(formData, proofKey))) {
    redirect(`/offers/${id}?statusError=confirmationRequired`);
  }

  try {
    await apiFetch<Offer>(`/offers/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  } catch (error) {
    // Every 409 here is a state conflict and nothing was written: the offer
    // was already decided (OFFER_ACTION_NOT_ALLOWED, PR #119), the request
    // moved on, or an acceptance lacked the customer's disclosure consent. The
    // operator lands back on the operations list with the reason.
    const conflict = readConflict(error);
    if (conflict) {
      redirect(`/offers/${id}?statusError=${offerStatusErrorKey(conflict.code)}`);
    }

    throw error;
  }

  revalidatePath('/offers');
  revalidatePath(`/offers/${id}`);
  redirect(`/offers/${id}?statusSaved=1`);
}

/**
 * The operations refund. Not the product's policy — see the API's
 * OffersService.refundOfferCredit — so this screen is the only place it is
 * offered, and the reason code it posts is an operations code, never
 * UNVIEWED_OFFER_48H.
 */
export async function refundOfferCreditAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const reasonCode = readFormString(formData, 'reasonCode');
  const note = readOptionalFormString(formData, 'note');

  // A reason chosen on purpose: the form no longer preselects one, and an
  // empty value never reaches the API (Paket A). Which codes exist stays the
  // API's to judge.
  if (reasonCode.trim() === '') {
    redirect(`/offers/${id}?tab=kredi&refundError=reasonRequired`);
  }
  if (!(await hasConfirmationProof(formData, 'offer.refund'))) {
    redirect(`/offers/${id}?tab=kredi&refundError=confirmationRequired`);
  }

  try {
    await apiFetch<{ offer: Offer; balance: number }>(`/offers/${id}/refund-credit`, {
      method: 'POST',
      body: JSON.stringify({ reasonCode, note }),
    });
  } catch (error) {
    // API-HARDENING-001: giving the credit back would pass the ledger bound.
    // Nothing was written; the form's tab says so.
    if (isCreditBalanceLimitError(error)) {
      redirect(`/offers/${id}?tab=kredi&refundError=creditBalanceLimit`);
    }
    throw error;
  }

  revalidatePath('/offers');
  revalidatePath(`/offers/${id}`);
  // Back to the tab the refund form lives on.
  redirect(`/offers/${id}?tab=kredi&refunded=1`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
