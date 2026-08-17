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

/**
 * Lifecycle operations live on their own endpoints rather than on the moderation
 * status route: they enforce transitions the moderation dropdown does not (only
 * a MATCHED request can be completed, a finished request cannot move again) and
 * they stamp the matching timestamps.
 */
export async function completeRequestAction(formData: FormData) {
  const id = readFormString(formData, 'id');

  await apiFetch<ServiceRequest>(`/service-requests/${id}/complete`, { method: 'POST' });

  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
}

export async function cancelRequestAction(formData: FormData) {
  const id = readFormString(formData, 'id');

  await apiFetch<ServiceRequest>(`/service-requests/${id}/cancel`, { method: 'POST' });

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
