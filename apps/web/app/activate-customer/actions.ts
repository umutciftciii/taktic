'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function submitCustomerActivationAction(formData: FormData) {
  const token = readFormString(formData, 'token').trim();
  const password = readFormString(formData, 'password');
  const passwordConfirm = readFormString(formData, 'passwordConfirm');

  if (!token) {
    redirect('/activate-customer?error=invalid');
  }

  if (!password || password.length < 8) {
    const params = new URLSearchParams({ token, error: 'password' });
    redirect(`/activate-customer?${params.toString()}`);
  }

  if (password !== passwordConfirm) {
    const params = new URLSearchParams({ token, error: 'mismatch' });
    redirect(`/activate-customer?${params.toString()}`);
  }

  const response = await fetch(`${apiUrl}/auth/customer-activation`, {
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
    redirect(`/activate-customer?${params.toString()}`);
  }

  // Activation logs the customer in, so persist the session cookie the API
  // issued and drop them straight onto their own requests instead of a login
  // screen — that is the whole point of the claim flow.
  const session = parseSetCookie(response.headers.get('set-cookie'));
  if (session) {
    (await cookies()).set(session.name, session.value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      expires: session.expires,
    });

    redirect('/requests/my');
  }

  redirect('/activate-customer?success=1');
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

  const expiresAttribute = attributes.find((attribute) =>
    attribute.toLowerCase().startsWith('expires='),
  );

  return {
    name,
    value: decodeURIComponent(rawValue.join('=')),
    expires: expiresAttribute ? new Date(expiresAttribute.slice('expires='.length)) : undefined,
  };
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
