'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const apiUrl = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const authCookieName = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

type LoggedInUser = {
  id: string;
  role: 'SUPER_ADMIN' | 'CUSTOMER' | 'PROVIDER';
};

type ParsedSessionCookie = {
  name: string;
  value: string;
  expires: Date | undefined;
};

export async function loginAction(formData: FormData) {
  const email = readFormString(formData, 'email');
  const password = readFormString(formData, 'password');
  const explicitRedirect = readFormString(formData, 'redirectTo').trim();

  const response = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const params = new URLSearchParams({ error: '1' });
    if (explicitRedirect) {
      params.set('redirectTo', explicitRedirect);
    }
    redirect(`/login?${params.toString()}`);
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

  let user: LoggedInUser | null = null;
  try {
    user = (await response.json()) as LoggedInUser;
  } catch {
    user = null;
  }

  const target = explicitRedirect || (await resolveDefaultRedirect(user, session));
  redirect(target);
}

async function resolveDefaultRedirect(
  user: LoggedInUser | null,
  session: ParsedSessionCookie | null,
): Promise<string> {
  if (!user) {
    return '/';
  }

  if (user.role === 'PROVIDER') {
    const providerId = await fetchProviderId(session);
    return providerId ? `/providers/${providerId}/requests` : '/providers/me';
  }

  if (user.role === 'CUSTOMER') {
    return '/requests/my';
  }

  return '/';
}

async function fetchProviderId(session: ParsedSessionCookie | null): Promise<string | null> {
  if (!session) {
    return null;
  }
  try {
    const cookieHeader = `${session.name}=${encodeURIComponent(session.value)}`;
    const res = await fetch(`${apiUrl}/providers/me/dashboard`, {
      headers: { cookie: cookieHeader },
      cache: 'no-store',
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { provider?: { id?: string } | null };
    return body.provider?.id ?? null;
  } catch {
    return null;
  }
}

export async function logoutAction() {
  (await cookies()).delete(authCookieName);
  redirect('/login');
}

export async function customerLogoutAction() {
  (await cookies()).delete(authCookieName);
  redirect('/');
}

export async function providerDashboardLogoutAction() {
  (await cookies()).delete(authCookieName);
  redirect('/');
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function parseSetCookie(value: string | null): ParsedSessionCookie | null {
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
