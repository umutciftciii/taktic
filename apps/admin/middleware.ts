import { NextResponse, type NextRequest } from 'next/server';

const authCookieName = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

const PUBLIC_PATHS = new Set(['/login', '/admin-invite']);

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
