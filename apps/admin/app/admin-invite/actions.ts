'use server';

import { redirect } from 'next/navigation';

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function submitAdminInviteAction(formData: FormData) {
  const token = readFormString(formData, 'token').trim();
  const password = readFormString(formData, 'password');
  const passwordConfirm = readFormString(formData, 'passwordConfirm');

  if (!token) {
    redirect('/admin-invite?error=invalid');
  }

  if (!password || password.length < 8) {
    const params = new URLSearchParams({ token, error: 'password' });
    redirect(`/admin-invite?${params.toString()}`);
  }

  if (password !== passwordConfirm) {
    const params = new URLSearchParams({ token, error: 'mismatch' });
    redirect(`/admin-invite?${params.toString()}`);
  }

  const response = await fetch(`${apiUrl}/auth/admin-invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const message = await safeReadErrorMessage(response);
    const params = new URLSearchParams({ token, error: 'submit' });
    if (message) {
      params.set('errorMessage', message);
    }
    redirect(`/admin-invite?${params.toString()}`);
  }

  redirect('/admin-invite?success=1');
}

async function safeReadErrorMessage(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed?.message === 'string') return parsed.message;
      if (Array.isArray(parsed?.message) && typeof parsed.message[0] === 'string') {
        return parsed.message[0];
      }
    } catch {
      return text;
    }
    return null;
  } catch {
    return null;
  }
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
