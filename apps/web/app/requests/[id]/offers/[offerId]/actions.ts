'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, RequestOfferDetail } from '../../../../../lib/api';

export async function customerOfferAction(formData: FormData) {
  const requestId = readFormString(formData, 'requestId');
  const offerId = readFormString(formData, 'offerId');
  const action = readFormString(formData, 'action');

  await apiFetch<RequestOfferDetail>(`/service-requests/${requestId}/offers/${offerId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });

  revalidatePath(`/requests/${requestId}/offers`);
  revalidatePath(`/requests/${requestId}/offers/${offerId}`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
