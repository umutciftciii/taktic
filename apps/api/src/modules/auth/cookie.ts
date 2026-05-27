import { AUTH_COOKIE_NAME, SESSION_TTL_DAYS } from './auth.constants';

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

export function sessionCookie(sessionId: string, expiresAt: Date) {
  return serializeCookie(AUTH_COOKIE_NAME, sessionId, {
    expires: expiresAt,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie() {
  return serializeCookie(AUTH_COOKIE_NAME, '', {
    expires: new Date(0),
    maxAge: 0,
  });
}

function serializeCookie(
  name: string,
  value: string,
  options: { expires: Date; maxAge: number },
) {
  const secure = process.env.NODE_ENV === 'production';
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAge}`,
    `Expires=${options.expires.toUTCString()}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}
