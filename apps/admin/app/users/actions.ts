'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AdminInviteLinkResponse,
  apiFetch,
  CreateAdminUserResponse,
  UpdateUserStatusResponse,
} from '../../lib/api';

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

export async function createAdminUserAction(formData: FormData) {
  const name = readFormString(formData, 'name').trim();
  const email = readFormString(formData, 'email').trim().toLowerCase();
  const phone = readFormString(formData, 'phone').trim();

  if (name.length < 2) {
    redirect(
      `/users/new?error=${encodeURIComponent('Ad Soyad en az 2 karakter olmalıdır.')}`,
    );
  }

  if (!email || !email.includes('@')) {
    redirect(
      `/users/new?error=${encodeURIComponent('Geçerli bir e-posta adresi girin.')}`,
    );
  }

  let result: CreateAdminUserResponse;
  try {
    result = await apiFetch<CreateAdminUserResponse>(`/users`, {
      method: 'POST',
      body: JSON.stringify({ name, email, phone: phone || undefined }),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? parseBackendMessage(error.message, 'Admin kullanıcısı oluşturulamadı.')
        : 'Admin kullanıcısı oluşturulamadı.';
    const params = new URLSearchParams({ error: message });
    if (name) params.set('name', name);
    if (email) params.set('email', email);
    if (phone) params.set('phone', phone);
    redirect(`/users/new?${params.toString()}`);
  }

  revalidatePath('/users');
  revalidatePath(`/users/${result.user.id}`);
  const params = new URLSearchParams({
    inviteUrl: result.inviteUrl,
    expiresAt: result.expiresAt,
    userId: result.user.id,
  });
  redirect(`/users/new?${params.toString()}`);
}

export async function createAdminInviteLinkAction(formData: FormData) {
  const userId = readFormString(formData, 'userId');

  if (!userId) {
    return;
  }

  let result: AdminInviteLinkResponse;
  try {
    result = await apiFetch<AdminInviteLinkResponse>(`/users/${userId}/invite-link`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? parseBackendMessage(error.message, 'Davet linki oluşturulamadı.')
        : 'Davet linki oluşturulamadı.';
    redirect(`/users/${userId}?inviteError=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/users/${userId}`);
  const params = new URLSearchParams({
    inviteUrl: result.inviteUrl,
    inviteExpiresAt: result.expiresAt,
  });
  redirect(`/users/${userId}?${params.toString()}`);
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
