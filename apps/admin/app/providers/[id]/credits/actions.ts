'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ProviderCreditTransaction } from '../../../../lib/api';

export type CreditOperationType = 'GRANT' | 'DEDUCT';

export async function grantProviderCreditsAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');

  await apiFetch<ProviderCreditTransaction>(`/providers/${providerId}/credits/grant`, {
    method: 'POST',
    body: JSON.stringify(creditPayload(formData)),
  });

  revalidatePath(`/providers/${providerId}`);
  revalidatePath(`/providers/${providerId}/credits`);
}

export async function deductProviderCreditsAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');

  await apiFetch<ProviderCreditTransaction>(`/providers/${providerId}/credits/deduct`, {
    method: 'POST',
    body: JSON.stringify(creditPayload(formData)),
  });

  revalidatePath(`/providers/${providerId}`);
  revalidatePath(`/providers/${providerId}/credits`);
}

export async function submitCreditOperationAction(formData: FormData) {
  const operationType = readFormString(formData, 'operationType');

  if (operationType === 'DEDUCT') {
    await deductProviderCreditsAction(formData);
    return;
  }

  await grantProviderCreditsAction(formData);
}

function creditPayload(formData: FormData) {
  return {
    amount: readFormNumber(formData, 'amount'),
    reason: readOptionalFormString(formData, 'reason'),
  };
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
