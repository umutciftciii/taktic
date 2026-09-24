import { safeRedirectPathOrNull } from '@taktic/shared';
import { persistSessionCookie, type ParsedSessionCookie } from '../session-cookie';

const apiUrl = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type LoggedInUser = {
  id: string;
  role: 'SUPER_ADMIN' | 'CUSTOMER' | 'PROVIDER' | 'ADMIN';
};

/**
 * The sign-in form's submission: checks the credentials with the API, re-issues
 * its session cookie on this origin, and answers the path to send the browser to.
 *
 * Formerly the `loginAction` Server Action. It runs from the `/login/submit`
 * route handler now, so a sign-in form rendered by a previous build still posts
 * somewhere that exists — see @taktic/shared's form-post. Every rule it enforced
 * is unchanged; only `redirect(x)` became `return x`.
 */
export async function signIn(formData: FormData): Promise<string> {
  const email = readFormString(formData, 'email');
  const password = readFormString(formData, 'password');
  // Posted by the sign-in form, which got it from the address bar — so it is
  // whatever the author of the link that brought this person here wanted. The
  // single check is here rather than at the two places a path is returned below,
  // because a successful sign-in landing on somebody else's copy of this site
  // is exactly the moment nobody looks at the address bar. `null` means "there
  // was no usable destination", which is the same answer as "none was given":
  // the role's own screen. See @taktic/shared's safe-redirect.
  //
  // The route handler checks the returned path once more before it becomes a
  // `Location` header (formPostRoute); this is still the check that decides.
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
    return `/login?${params.toString()}`;
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

  return explicitRedirect || (await resolveDefaultRedirect(user, session));
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

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
