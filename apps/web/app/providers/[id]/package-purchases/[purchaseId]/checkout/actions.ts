'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, type PackagePurchase } from '../../../../../../lib/api';

export async function mockPayPackagePurchaseAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');
  const purchaseId = readFormString(formData, 'purchaseId');

  const purchase = await apiFetch<PackagePurchase>(`/providers/${providerId}/package-purchases/${purchaseId}/mock-pay`, {
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

  // A vitrin package grants a right rather than credits, and the screen that
  // says so lives under the vitrin — with the card the provider came from, so
  // the return leads straight back to it.
  if (purchase.kind === 'SHOWCASE_PACKAGE') {
    revalidatePath(`/providers/${providerId}/vitrin`);
    const card = readFormString(formData, 'returnCard');
    redirect(`/providers/${providerId}/vitrin/odeme/${purchaseId}?checkout=return${card ? `&card=${encodeURIComponent(card)}` : ''}`);
  }
  redirect(`/providers/${providerId}/package-purchases/${purchaseId}`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
