import { persistSessionCookie } from '../session-cookie';

const apiUrl = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * The admin sign-in form's submission. Formerly the `loginAction` Server
 * Action; it runs from the `/login/submit` route handler now, so a sign-in form
 * left open across a deploy still reaches it (see @taktic/shared's form-post).
 * It answers the path to send the browser to.
 */
export async function signIn(formData: FormData): Promise<string> {
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
    return '/login?error=1';
  }

  // The API decided how long this session lives, whether its cookie survives
  // the browser closing and whether it requires TLS; this only re-issues that
  // decision on this origin. Re-issuing every cookie with an expiry — which is
  // what this used to do — would turn "Beni hatırla" on for everybody, and
  // marking every cookie `Secure` cost Safari the session outright. See
  // session-cookie.ts.
  await persistSessionCookie(response);

  return '/';
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
