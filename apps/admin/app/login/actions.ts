'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { persistSessionCookie } from '../session-cookie';

const apiUrl = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const authCookieName = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

export async function loginAction(formData: FormData) {
  const email = readFormString(formData, 'email');
  const password = readFormString(formData, 'password');
  // An unticked checkbox posts nothing at all, which is the "no" this reads.
  const rememberMe = formData.get('rememberMe') === 'true';

  const response = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, rememberMe }),
  });

  if (!response.ok) {
    redirect('/login?error=1');
  }

  // The API decided how long this session lives, whether its cookie survives
  // the browser closing and whether it requires TLS; this only re-issues that
  // decision on this origin. Re-issuing every cookie with an expiry — which is
  // what this used to do — would turn "Beni hatırla" on for everybody, and
  // marking every cookie `Secure` cost Safari the session outright. See
  // session-cookie.ts.
  await persistSessionCookie(response);

  redirect('/');
}

export async function logoutAction() {
  const cookieStore = await cookies();

  try {
    // Revoking server-side is what makes "çıkış" mean it: the cookie may still
    // exist in another tab or on another device, and it has to stop working.
    await fetch(`${apiUrl}/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookieStore.toString() },
      cache: 'no-store',
    });
  } catch {
    // The cookie still goes. Leaving an operator signed in on this browser
    // because the API was briefly unreachable is the worse of the two outcomes,
    // and the session's own idle and absolute clocks still end it.
  }

  cookieStore.delete(authCookieName);
  redirect('/login');
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
