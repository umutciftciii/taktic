'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AdminInviteLinkResponse,
  apiFetch,
  CreateAdminUserResponse,
  UpdateUserStatusResponse,
} from '../../lib/api';
import { rethrowNextControlFlow } from '../../lib/next-control-flow';
import type { InviteLinkState } from './invite-link-state';

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
    // A 401/403 is a navigation, not a message: `?statusError=NEXT_REDIRECT`
    // is what swallowing it used to produce.
    rethrowNextControlFlow(error);
    const message =
      error instanceof Error
        ? parseBackendMessage(error.message)
        : 'Kullanıcı durumu güncellenemedi.';
    redirect(`/users/${userId}?statusError=${encodeURIComponent(message)}`);
  }

  revalidatePath('/users');
  revalidatePath(`/users/${userId}`);
}

export async function createAdminUserAction(
  _previous: InviteLinkState,
  formData: FormData,
): Promise<InviteLinkState> {
  const name = readFormString(formData, 'name').trim();
  const email = readFormString(formData, 'email').trim().toLowerCase();
  const phone = readFormString(formData, 'phone').trim();
  const values = { name, email, phone };

  if (name.length < 2) {
    return { kind: 'error', message: 'Ad Soyad en az 2 karakter olmalıdır.', values };
  }

  if (!email || !email.includes('@')) {
    return { kind: 'error', message: 'Geçerli bir e-posta adresi girin.', values };
  }

  let result: CreateAdminUserResponse;
  try {
    result = await apiFetch<CreateAdminUserResponse>(`/users`, {
      method: 'POST',
      body: JSON.stringify({ name, email, phone: phone || undefined }),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    const message =
      error instanceof Error
        ? parseBackendMessage(error.message, 'Admin kullanıcısı oluşturulamadı.')
        : 'Admin kullanıcısı oluşturulamadı.';
    return { kind: 'error', message, values };
  }

  revalidatePath('/users');
  return {
    kind: 'issued',
    inviteUrl: result.inviteUrl,
    expiresAt: result.expiresAt,
    userId: result.user.id,
  };
}

export async function createAdminInviteLinkAction(
  _previous: InviteLinkState,
  formData: FormData,
): Promise<InviteLinkState> {
  const userId = readFormString(formData, 'userId');

  if (!userId) {
    return { kind: 'error', message: 'Davet linki oluşturulamadı.' };
  }

  let result: AdminInviteLinkResponse;
  try {
    result = await apiFetch<AdminInviteLinkResponse>(`/users/${userId}/invite-link`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    const message =
      error instanceof Error
        ? parseBackendMessage(error.message, 'Davet linki oluşturulamadı.')
        : 'Davet linki oluşturulamadı.';
    return { kind: 'error', message };
  }

  return { kind: 'issued', inviteUrl: result.inviteUrl, expiresAt: result.expiresAt, userId };
}

function parseBackendMessage(raw: string, fallback = 'İşlem başarısız oldu.'): string {
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed?.message === 'string') return parsed.message;
    if (Array.isArray(parsed?.message) && typeof parsed.message[0] === 'string') {
      return parsed.message[0];
    }
  } catch {
    // ignore
  }
  return raw || fallback;
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
