'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, parseDecimalToMinor, ProviderOffer } from '../../../../../lib/api';

export async function createOfferAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');
  const requestId = readFormString(formData, 'requestId');

  // The form accepts a human-readable decimal (e.g. "1500,00" or "149.90").
  // parseDecimalToMinor converts it to the minor-unit integer (kuruş for TRY).
  // null is passed straight through; the API DTO enforces @Min(100) and surfaces
  // a clear validation error if the value is missing or below 1,00.
  const priceAmountMinor = parseDecimalToMinor(readFormString(formData, 'priceAmount'));

  await apiFetch<ProviderOffer>(`/providers/${providerId}/requests/${requestId}/offers`, {
    method: 'POST',
    body: JSON.stringify({
      priceAmount: priceAmountMinor,
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
