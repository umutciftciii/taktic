'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, PackagePurchase, PackagePurchaseStatus } from '../../lib/api';

export async function updatePackagePurchaseStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const status = readFormString(formData, 'status') as PackagePurchaseStatus;
  const adminNote = readOptionalFormString(formData, 'adminNote');

  await apiFetch<PackagePurchase>(`/package-purchases/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, adminNote }),
  });

  revalidatePath('/package-purchases');
  revalidatePath(`/package-purchases/${id}`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
