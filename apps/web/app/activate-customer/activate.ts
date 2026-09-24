import { safeRedirectPathOrNull } from '@taktic/shared';
import { persistSessionCookie } from '../session-cookie';

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function submitCustomerActivation(formData: FormData): Promise<string> {
  const token = readFormString(formData, 'token').trim();
  const password = readFormString(formData, 'password');
  const passwordConfirm = readFormString(formData, 'passwordConfirm');
  // Posted back by the page's own hidden field, which only ever holds what
  // safeRedirectPathOrNull already approved on render — re-validated here
  // because a form field is as untrusted as any other request input. See
  // login/sign-in.ts for the same check on the sign-in form.
  const redirectTo = safeRedirectPathOrNull(readFormString(formData, 'redirectTo'));

  if (!token) {
    return `/activate-customer?${buildErrorParams({ error: 'invalid', redirectTo }).toString()}`;
  }

  if (!password || password.length < 8) {
    const params = buildErrorParams({ token, error: 'password', redirectTo });
    return `/activate-customer?${params.toString()}`;
  }

  if (password !== passwordConfirm) {
    const params = buildErrorParams({ token, error: 'mismatch', redirectTo });
    return `/activate-customer?${params.toString()}`;
  }

  const response = await fetch(`${apiUrl}/auth/customer-activation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const message = await safeReadErrorMessage(response);
    const params = buildErrorParams({ token, error: 'submit', redirectTo });
    if (message) {
      params.set('errorMessage', message);
    }
    return `/activate-customer?${params.toString()}`;
  }

  // Activation logs the customer in, so persist the session cookie the API
  // issued and drop them straight onto their own requests instead of a login
  // screen — that is the whole point of the claim flow.
  const session = await persistSessionCookie(response);
  if (session) {
    return redirectTo ?? '/requests/my';
  }

  return '/activate-customer?success=1';
}

function buildErrorParams(fields: {
  token?: string;
  error: string;
  redirectTo: string | null;
}): URLSearchParams {
  const params = new URLSearchParams({ error: fields.error });
  if (fields.token) {
    params.set('token', fields.token);
  }
  if (fields.redirectTo) {
    params.set('redirectTo', fields.redirectTo);
  }
  return params;
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
