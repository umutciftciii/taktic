'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ProviderOffer } from '../../../../../lib/api';

export async function createOfferAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');
  const requestId = readFormString(formData, 'requestId');

  await apiFetch<ProviderOffer>(`/providers/${providerId}/requests/${requestId}/offers`, {
    method: 'POST',
    body: JSON.stringify({
      priceAmount: readFormNumber(formData, 'priceAmount'),
      currency: readOptionalFormString(formData, 'currency'),
      estimatedStartDate: readOptionalFormString(formData, 'estimatedStartDate'),
      estimatedCompletionDate: readOptionalFormString(formData, 'estimatedCompletionDate'),
      message: readFormString(formData, 'message'),
      warrantyNote: readOptionalFormString(formData, 'warrantyNote'),
      internalNote: readOptionalFormString(formData, 'internalNote'),
    }),
  });

  revalidatePath(`/providers/${providerId}/requests/${requestId}`);
  revalidatePath(`/providers/${providerId}/offers`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}

function readFormNumber(formData: FormData, key: string) {
  const value = Number(readFormString(formData, key));
  return Number.isFinite(value) ? value : 0;
}
