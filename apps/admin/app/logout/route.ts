import { formPostRoute } from '@taktic/shared';
import { cookies } from 'next/headers';

const apiUrl = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const authCookieName = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

/**
 * `POST /logout` — the topbar's "Çıkış".
 *
 * A fixed URL rather than a Server Action id, so signing out works from a tab
 * rendered by a previous build. The origin check in @taktic/shared's form-post
 * keeps another site from signing an operator out.
 */
export const POST = formPostRoute(async () => {
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
  return '/login';
}, '/login');
