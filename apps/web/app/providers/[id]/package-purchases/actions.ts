'use server';

import { redirect } from 'next/navigation';
import { apiFetch, PackagePurchase } from '../../../../lib/api';

export async function createPackagePurchaseAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');
  const packageId = readFormString(formData, 'packageId');
  const providerNote = readOptionalFormString(formData, 'providerNote');

  const purchase = await apiFetch<PackagePurchase>(`/providers/${providerId}/package-purchases`, {
    method: 'POST',
    body: JSON.stringify({ packageId, providerNote }),
  });

  redirect(`/providers/${providerId}/package-purchases/${purchase.id}/checkout`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
