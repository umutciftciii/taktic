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

export function middleware(request: NextRequest) {
  if (PUBLIC_PATHS.has(request.nextUrl.pathname)) {
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
