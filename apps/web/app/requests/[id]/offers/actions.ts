'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, CustomerServiceRequest } from '../../../../lib/api';

/**
 * Marks a matched request as delivered. The API only accepts this from the
 * customer who owns the request (or an admin), and only while the request is
 * MATCHED, so nothing here needs to re-check either.
 */
export async function completeRequestAction(formData: FormData) {
  const requestId = readFormString(formData, 'requestId');

  await apiFetch<CustomerServiceRequest>(`/service-requests/${requestId}/complete`, {
    method: 'POST',
  });

  revalidatePath('/requests/my');
  revalidatePath(`/requests/${requestId}/offers`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
