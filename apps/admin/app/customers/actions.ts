'use server';

import { revalidatePath } from 'next/cache';
import {
  apiFetch,
  CustomerNote,
  UpdateCustomerStatusResponse,
} from '../../lib/api';

export async function createCustomerNoteAction(formData: FormData) {
  const customerId = readFormString(formData, 'customerId');
  const note = readFormString(formData, 'note').trim();

  if (!customerId || note.length < 2) {
    return;
  }

  await apiFetch<CustomerNote>(`/customers/${customerId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });

  revalidatePath(`/customers/${customerId}`);
}

export async function updateCustomerStatusAction(formData: FormData) {
  const customerId = readFormString(formData, 'customerId');
  const isActive = readFormString(formData, 'isActive') === 'true';

  if (!customerId) {
    return;
  }

  await apiFetch<UpdateCustomerStatusResponse>(`/customers/${customerId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  });

  revalidatePath('/customers');
  revalidatePath(`/customers/${customerId}`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
