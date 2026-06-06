'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  CustomerActivationLinkResponse,
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

export async function createCustomerActivationLinkAction(formData: FormData) {
  const customerId = readFormString(formData, 'customerId');

  if (!customerId) {
    return;
  }

  let result: CustomerActivationLinkResponse;
  try {
    result = await apiFetch<CustomerActivationLinkResponse>(
      `/customers/${customerId}/activation-link`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? parseBackendMessage(error.message)
        : 'Aktivasyon linki oluşturulamadı.';
    redirect(
      `/customers/${customerId}?activationError=${encodeURIComponent(message)}`,
    );
  }

  revalidatePath(`/customers/${customerId}`);
  const params = new URLSearchParams({
    activationUrl: result.activationUrl,
    activationExpiresAt: result.expiresAt,
  });
  redirect(`/customers/${customerId}?${params.toString()}`);
}

function parseBackendMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed?.message === 'string') return parsed.message;
    if (Array.isArray(parsed?.message) && typeof parsed.message[0] === 'string') {
      return parsed.message[0];
    }
  } catch {
    // ignore
  }
  return raw || 'Aktivasyon linki oluşturulamadı.';
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
