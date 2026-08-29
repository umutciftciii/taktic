'use server';

import { redirect } from 'next/navigation';
import { persistSessionCookie } from '../session-cookie';

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
  // Registering signs the new account in, so the API's session cookie is
  // re-issued on this origin — with the API's own attributes, not a second
  // guess at them. See session-cookie.ts.
  await persistSessionCookie(response);

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
