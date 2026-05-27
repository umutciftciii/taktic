'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, PackagePurchase } from '../../../../../../lib/api';

export async function mockPayPackagePurchaseAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');
  const purchaseId = readFormString(formData, 'purchaseId');

  await apiFetch<PackagePurchase>(`/providers/${providerId}/package-purchases/${purchaseId}/mock-pay`, {
    method: 'POST',
    body: JSON.stringify({
      cardholderName: readFormString(formData, 'cardholderName'),
      cardNumber: readFormString(formData, 'cardNumber'),
      expiryMonth: Number(readFormString(formData, 'expiryMonth')),
      expiryYear: Number(readFormString(formData, 'expiryYear')),
      cvv: readFormString(formData, 'cvv'),
    }),
  });

  revalidatePath(`/providers/${providerId}/credits`);
  revalidatePath(`/providers/${providerId}/package-purchases`);
  redirect(`/providers/${providerId}/package-purchases/${purchaseId}`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
