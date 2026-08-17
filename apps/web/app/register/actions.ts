'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const apiUrl = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function registerCustomerAction(formData: FormData) {
  await register('/auth/register-customer', formData, '/requests/my');
}

export async function registerProviderAction(formData: FormData) {
  await register('/auth/register-provider', formData, '/providers/register');
}

async function register(path: string, formData: FormData, redirectTo: string) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: readFormString(formData, 'name'),
      email: readFormString(formData, 'email'),
      password: readFormString(formData, 'password'),
      phone: readOptionalFormString(formData, 'phone'),
    }),
  });

  if (!response.ok) {
    // The API answers 409 + ACTIVATION_REQUIRED when this e-mail belongs to an
    // account the platform auto-created for a guest service request. That is not
    // a dead end: an activation link has just been mailed, so tell the visitor
    // to open it rather than showing "already registered".
    if (response.status === 409 && (await isActivationRequired(response))) {
      redirect(`${redirectToForPath(path)}?notice=activation-sent`);
    }

    const reason = response.status === 409 ? 'duplicate' : 'invalid';
    redirect(`${redirectToForPath(path)}?error=${reason}`);
  }

  await response.json();
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

function redirectToForPath(path: string) {
  return path.includes('provider') ? '/register/provider' : '/register/customer';
}

async function isActivationRequired(response: Response): Promise<boolean> {
  try {
    const parsed = (await response.clone().json()) as { code?: unknown };
    return parsed?.code === 'ACTIVATION_REQUIRED';
  } catch {
    return false;
  }
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
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
