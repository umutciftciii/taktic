'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, Offer, OfferStatus } from '../../lib/api';

export async function updateOfferStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const status = readFormString(formData, 'status') as OfferStatus;

  await apiFetch<Offer>(`/offers/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });

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

  await apiFetch<{ offer: Offer; balance: number }>(`/offers/${id}/refund-credit`, {
    method: 'POST',
    body: JSON.stringify({ reasonCode, note }),
  });

  revalidatePath('/offers');
  revalidatePath(`/offers/${id}`);
  redirect(`/offers/${id}?refunded=1`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
