'use server';

import { safeRedirectPathOrNull } from '@taktic/shared';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { persistSessionCookie, type ParsedSessionCookie } from '../session-cookie';

const apiUrl = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const authCookieName = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

type LoggedInUser = {
  id: string;
  role: 'SUPER_ADMIN' | 'CUSTOMER' | 'PROVIDER';
};

export async function loginAction(formData: FormData) {
  const email = readFormString(formData, 'email');
  const password = readFormString(formData, 'password');
  // Posted by the sign-in form, which got it from the address bar — so it is
  // whatever the author of the link that brought this person here wanted. The
  // single check is here rather than at the two `redirect()` calls below,
  // because a successful sign-in landing on somebody else's copy of this site
  // is exactly the moment nobody looks at the address bar. `null` means "there
  // was no usable destination", which is the same answer as "none was given":
  // the role's own screen. See @taktic/shared's safe-redirect.
  const explicitRedirect = safeRedirectPathOrNull(readFormString(formData, 'redirectTo'));
  // An unticked checkbox posts nothing at all, which is the "no" this reads.
  const rememberMe = formData.get('rememberMe') === 'true';

  const response = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, rememberMe }),
  });

  if (!response.ok) {
    const params = new URLSearchParams({ error: '1' });
    if (explicitRedirect) {
      params.set('redirectTo', explicitRedirect);
    }
    redirect(`/login?${params.toString()}`);
  }

  // The API decided how long this session lives, whether its cookie survives
  // the browser closing and whether it requires TLS; this only re-issues that
  // decision on this origin. See session-cookie.ts.
  const session = await persistSessionCookie(response);

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
  await endSession();
  redirect('/login');
}

export async function customerLogoutAction() {
  await endSession();
  redirect('/');
}

export async function providerDashboardLogoutAction() {
  await endSession();
  redirect('/');
}

/**
 * Ends the session on the server, then drops the cookie.
 *
 * Both halves matter, and the order is the point. Deleting the cookie alone —
 * which is all this used to do — leaves the session row alive and usable: a
 * second tab, another device, or anybody holding a copy of that cookie stays
 * signed in after the person believes they signed out. Revoking it server-side
 * is what makes "çıkış yap" mean it, and it is what lets every other tab find
 * out within one poll.
 *
 * A failed revoke still clears the cookie. Leaving somebody signed in on this
 * browser because the API was briefly unreachable would be the worse of the two
 * outcomes, and the session's own idle and absolute clocks still end it.
 */
async function endSession() {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  if (cookieHeader) {
    try {
      await fetch(`${apiUrl}/auth/logout`, {
        method: 'POST',
        headers: { cookie: cookieHeader },
        cache: 'no-store',
      });
    } catch {
      // Deliberately swallowed — see above.
    }
  }

  cookieStore.delete(authCookieName);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
