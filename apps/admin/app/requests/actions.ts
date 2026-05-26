'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ServiceRequest, ServiceRequestStatus } from '../../lib/api';

export async function updateRequestStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const status = readFormString(formData, 'status') as ServiceRequestStatus;

  await apiFetch<ServiceRequest>(`/service-requests/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({
      status,
      moderationNote: readOptionalFormString(formData, 'moderationNote'),
      rejectionReason: readOptionalFormString(formData, 'rejectionReason'),
    }),
  });

  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
}

export async function recalculateRequestQualityAction(formData: FormData) {
  const id = readFormString(formData, 'id');

  await apiFetch<ServiceRequest>(`/service-requests/${id}/recalculate-quality`, {
    method: 'POST',
  });

  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
