import { cookies } from 'next/headers';

const apiUrl = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const authCookieName = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

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
export async function endSession() {
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
