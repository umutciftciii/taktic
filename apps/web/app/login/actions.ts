'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const authCookieName = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

export async function loginAction(formData: FormData) {
  const email = readFormString(formData, 'email');
  const password = readFormString(formData, 'password');
  const redirectTo = readFormString(formData, 'redirectTo') || '/';

  const response = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    redirect(`/login?error=1&redirectTo=${encodeURIComponent(redirectTo)}`);
  }

  const session = parseSetCookie(response.headers.get('set-cookie'));
  if (session) {
    (await cookies()).set(session.name, session.value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      expires: session.expires,
    });
  }

  redirect(redirectTo);
}

export async function logoutAction() {
  (await cookies()).delete(authCookieName);
  redirect('/login');
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function parseSetCookie(value: string | null) {
  if (!value) {
    return null;
  }

  const [nameValue, ...attributes] = value.split(';').map((part) => part.trim());
  if (!nameValue) {
    return null;
  }

  const [name, ...rawValue] = nameValue.split('=');
  if (!name) {
    return null;
  }

  const expiresAttribute = attributes.find((attribute) => attribute.toLowerCase().startsWith('expires='));

  return {
    name,
    value: decodeURIComponent(rawValue.join('=')),
    expires: expiresAttribute ? new Date(expiresAttribute.slice('expires='.length)) : undefined,
  };
}
