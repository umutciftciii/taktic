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

export async function refundOfferCreditAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const reason = readOptionalFormString(formData, 'reason');
  const reasonCode = readFormString(formData, 'reasonCode');
  const override = formData.get('override') === 'true';

  await apiFetch<{ offer: Offer; balance: number }>(`/offers/${id}/refund-credit`, {
    method: 'POST',
    body: JSON.stringify({ reasonCode, reason, override }),
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
