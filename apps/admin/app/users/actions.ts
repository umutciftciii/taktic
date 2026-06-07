'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, UpdateUserStatusResponse } from '../../lib/api';

export async function updateUserStatusAction(formData: FormData) {
  const userId = readFormString(formData, 'userId');
  const isActive = readFormString(formData, 'isActive') === 'true';

  if (!userId) {
    return;
  }

  try {
    await apiFetch<UpdateUserStatusResponse>(`/users/${userId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? parseBackendMessage(error.message)
        : 'Kullanıcı durumu güncellenemedi.';
    redirect(`/users/${userId}?statusError=${encodeURIComponent(message)}`);
  }

  revalidatePath('/users');
  revalidatePath(`/users/${userId}`);
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
  return raw || 'Kullanıcı durumu güncellenemedi.';
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
