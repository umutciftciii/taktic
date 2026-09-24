import { NextResponse, type NextRequest } from 'next/server';

const authCookieName = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

/*
 * The sign-in, invite and sign-out forms post to fixed route handlers (see
 * @taktic/shared's form-post). The first two are reached without a session by
 * definition. `/logout` is public too: a tab whose session already ended must
 * still be able to press "Çıkış" and land on the sign-in screen, rather than
 * have its POST bounced by the redirect below.
 */
const PUBLIC_PATHS = new Set([
  '/login',
  '/login/submit',
  '/admin-invite',
  '/admin-invite/submit',
  '/logout',
]);

/*
 * The session probe answers for itself. `SessionGuard` polls it with `fetch`
 * and reads a 401 as "the session ended". Redirected to /login instead, the
 * probe got the sign-in page's HTML with a 200, `response.json()` threw, and a
 * tab whose cookie was gone never learned it had been signed out. The route
 * already returns 401 when there is no cookie (app/api/session/route.ts), so
 * it is let through here. This is the one exact path: every other `/api/*`
 * route still needs the cookie.
 */
const SELF_AUTHENTICATING_PATHS = new Set(['/api/session']);

export function middleware(request: NextRequest) {
  if (
    PUBLIC_PATHS.has(request.nextUrl.pathname) ||
    SELF_AUTHENTICATING_PATHS.has(request.nextUrl.pathname)
  ) {
    return NextResponse.next();
  }

  if (!request.cookies.get(authCookieName)?.value) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|brand/).*)'],
};
