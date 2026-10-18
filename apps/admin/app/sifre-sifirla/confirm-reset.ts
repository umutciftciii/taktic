import { PASSWORD_MIN_LENGTH } from '../../lib/password-policy';

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * ADMIN-AUTH-001: an operator choosing a new password from a mailed link.
 *
 * The same shape as the invite form's submission. No session is set: the reset
 * revoked every session this account had, and handing a fresh one back here
 * would undo half of that — the operator signs in with the password they chose.
 */
export async function confirmPasswordReset(formData: FormData): Promise<string> {
  const token = readFormString(formData, 'token').trim();
  const password = readFormString(formData, 'password');
  const passwordConfirm = readFormString(formData, 'passwordConfirm');

  if (!token) {
    return '/sifre-sifirla?error=invalid';
  }

  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return `/sifre-sifirla?${new URLSearchParams({ token, error: 'password' })}`;
  }

  if (password !== passwordConfirm) {
    return `/sifre-sifirla?${new URLSearchParams({ token, error: 'mismatch' })}`;
  }

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password }),
      cache: 'no-store',
    });
  } catch {
    return `/sifre-sifirla?${new URLSearchParams({ token, error: 'submit' })}`;
  }

  if (!response.ok) {
    return `/sifre-sifirla?${new URLSearchParams({ token, error: 'submit' })}`;
  }

  return '/sifre-sifirla?success=1';
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
