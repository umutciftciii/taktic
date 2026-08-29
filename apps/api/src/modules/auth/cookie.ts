import { AUTH_COOKIE_NAME } from './auth.constants';

export function parseCookieHeader(cookieHeader: string | undefined) {
  const cookies = new Map<string, string>();
  if (!cookieHeader) {
    return cookies;
  }

  for (const item of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = item.trim().split('=');
    if (!rawName || rawValue.length === 0) {
      continue;
    }

    cookies.set(rawName, decodeURIComponent(rawValue.join('=')));
  }

  return cookies;
}

export function getSessionIdFromRequest(request: { headers?: Record<string, string | string[] | undefined> }) {
  const cookieHeader = request.headers?.cookie;
  const normalizedCookieHeader = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
  return parseCookieHeader(normalizedCookieHeader).get(AUTH_COOKIE_NAME) ?? null;
}

/**
 * The session cookie.
 *
 * `rememberMe` decides one thing here: whether the cookie survives the browser
 * closing. A remembered session gets `Max-Age`/`Expires` matching its absolute
 * lifetime; an ordinary one gets neither, which makes it a session cookie the
 * browser drops on exit. Neither form is what actually keeps a session alive —
 * the server checks `expiresAt` and `lastSeenAt` against the database on every
 * request — so a cookie that outlives its row buys nobody anything.
 */
export function sessionCookie(sessionId: string, expiresAt: Date, rememberMe: boolean) {
  if (!rememberMe) {
    return serializeCookie(AUTH_COOKIE_NAME, sessionId, {});
  }

  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return serializeCookie(AUTH_COOKIE_NAME, sessionId, { expires: expiresAt, maxAge });
}

export function clearSessionCookie() {
  return serializeCookie(AUTH_COOKIE_NAME, '', { expires: new Date(0), maxAge: 0 });
}

function serializeCookie(
  name: string,
  value: string,
  options: { expires?: Date; maxAge?: number },
) {
  const secure = process.env.NODE_ENV === 'production';
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    options.maxAge === undefined ? '' : `Max-Age=${options.maxAge}`,
    options.expires === undefined ? '' : `Expires=${options.expires.toUTCString()}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}
