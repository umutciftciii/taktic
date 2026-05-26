'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ServiceRequest, ServiceRequestStatus } from '../../lib/api';

export async function updateRequestStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const status = readFormString(formData, 'status') as ServiceRequestStatus;

  await apiFetch<ServiceRequest>(`/service-requests/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });

  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
