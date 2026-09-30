'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, PackagePurchase, PackagePurchaseStatus, readConflict } from '../../lib/api';

export async function updatePackagePurchaseStatusAction(formData: FormData) {
  // `purchaseId`, not `id`: a control named "id" shadows `form.id`, and React
  // then tags the submitter's name/value with a `form` attribute naming no
  // form — the chosen `status` never reached the API (ADMIN-DESIGN-001 Faz 3D,
  // where the status became the pressed button's value).
  const id = readFormString(formData, 'purchaseId');
  const status = readFormString(formData, 'status') as PackagePurchaseStatus;
  const adminNote = readOptionalFormString(formData, 'adminNote');

  try {
    await apiFetch<PackagePurchase>(`/package-purchases/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, adminNote }),
    });
  } catch (error) {
    // API-HARDENING-001: a paid purchase with a held credit is not the
    // operator's to cancel. The detail page already says so; this is the
    // answer for a submission that bypassed the hidden form.
    if (readConflict(error)?.code === 'PURCHASE_CREDIT_HOLD_OPEN') {
      redirect(`/package-purchases/${id}`);
    }
    throw error;
  }

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
