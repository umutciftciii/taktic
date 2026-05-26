'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ProviderProfile, ProviderStatus } from '../../lib/api';

export async function updateProviderStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const status = readFormString(formData, 'status') as ProviderStatus;

  await apiFetch<ProviderProfile>(`/providers/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({
      status,
      moderationNote: readOptionalFormString(formData, 'moderationNote'),
      rejectionReason: readOptionalFormString(formData, 'rejectionReason'),
    }),
  });

  revalidatePath('/providers');
  revalidatePath(`/providers/${id}`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
