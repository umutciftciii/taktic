'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CLAIM_TOKEN_COOKIE } from '../../lib/provider-claim';

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Every redirect out of these actions is to a bare path or to one carrying a
 * short error code, and never to one carrying the token.
 *
 * The link the applicant received has the token in its query string once, which
 * is unavoidable. From there on it lives in an httpOnly cookie: a token that is
 * copied into the login URL, into an error URL or into a `redirectTo` parameter
 * ends up in browser history, in a Referer header and in every access log
 * between here and the browser, and it is a credential that grants ownership of
 * a business's application.
 */
async function rememberToken(token: string) {
  (await cookies()).set(CLAIM_TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 900,
  });
}

/**
 * Moves the token into the cookie and sends the applicant to sign in.
 *
 * `redirectTo` names the claim screen and nothing else — the screen finds its
 * token again on its own.
 */
export async function startClaimLoginAction(formData: FormData) {
  const token = readFormString(formData, 'token').trim();
  if (token) {
    await rememberToken(token);
  }

  redirect('/login?redirectTo=/claim-provider');
}

export async function submitProviderClaimAction(formData: FormData) {
  const token = readFormString(formData, 'token').trim();
  const needsPassword = readFormString(formData, 'needsPassword') === 'true';
  const password = readFormString(formData, 'password');
  const passwordConfirm = readFormString(formData, 'passwordConfirm');

  if (!token) {
    redirect('/claim-provider');
  }

  // Held before any refusal, so re-rendering the screen never needs the token
  // back in a URL.
  await rememberToken(token);

  if (needsPassword) {
    if (password.length < 8) {
      redirect('/claim-provider?error=password');
    }

    if (password !== passwordConfirm) {
      redirect('/claim-provider?error=mismatch');
    }
  }

  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${apiUrl}/auth/provider-claim`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: JSON.stringify(needsPassword ? { token, password } : { token }),
    cache: 'no-store',
  });

  if (!response.ok) {
    // No message is carried over. Every refusal this endpoint produces is
    // already neutral, and re-validating on the claim screen reproduces the
    // same state with the same wording — copying an API string into a URL is
    // how tokens and addresses leak into places nobody audits.
    redirect('/claim-provider');
  }

  const session = parseSetCookie(response.headers.get('set-cookie'));
  const store = await cookies();

  // The token is spent; nothing may still be holding it.
  store.delete(CLAIM_TOKEN_COOKIE);

  if (session) {
    store.set(session.name, session.value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      expires: session.expires,
    });
  }

  redirect('/providers/me');
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

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
