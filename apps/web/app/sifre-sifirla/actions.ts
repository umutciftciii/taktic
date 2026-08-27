'use server';

import { redirect } from 'next/navigation';
import { apiUrl, readApiMessage } from '../api-base';
import { PASSWORD_MIN_LENGTH } from '../../lib/password-policy';

export async function confirmPasswordResetAction(formData: FormData) {
  const token = readFormString(formData, 'token').trim();
  const password = readFormString(formData, 'password');
  const passwordConfirm = readFormString(formData, 'passwordConfirm');

  if (!token) {
    redirect('/sifre-sifirla?error=invalid');
  }

  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    redirect(`/sifre-sifirla?${new URLSearchParams({ token, error: 'password' })}`);
  }

  if (password !== passwordConfirm) {
    redirect(`/sifre-sifirla?${new URLSearchParams({ token, error: 'mismatch' })}`);
  }

  const response = await fetch(`${apiUrl}/auth/password-reset/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const message = await readApiMessage(response);
    const params = new URLSearchParams({ token, error: 'submit' });
    if (message) {
      params.set('errorMessage', message);
    }
    redirect(`/sifre-sifirla?${params.toString()}`);
  }

  // No session is set. The reset revoked every session this account had, and
  // handing a fresh one back here would undo half of that — so the person signs
  // in with the password they just chose.
  redirect('/sifre-sifirla?success=1');
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
