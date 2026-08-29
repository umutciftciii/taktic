import { cookies } from 'next/headers';

/**
 * The one place this panel writes a cookie: the API's session cookie, re-issued
 * on the panel's own origin.
 *
 * The browser talks to Next and Next talks to the API, so the `Set-Cookie` the
 * API returns is for a response the browser never sees. Copying it means
 * reproducing the API's decision rather than forming a second one: the API
 * issued this session and is the only party that knows what it needs.
 *
 * Two attributes used to be lost.
 *
 * **Whether the cookie is persistent.** An ordinary session cookie carries
 * neither `Max-Age` nor `Expires` and dies with the browser. A remembered one
 * carries both. Re-issuing every cookie with an expiry would quietly turn
 * "Beni hatırla" on for everybody, and re-issuing none with one would turn it
 * off — which is the kind of security decision nobody notices being made.
 *
 * **Whether the cookie requires TLS.** `Secure` is read from the API's header
 * for the same reason as the expiry. It used to be decided here instead, from
 * the build-time `NODE_ENV` constant — and that is not a runtime read. Next
 * folds it away when it compiles, so a compiled server always said `Secure`
 * whatever it was later started with, and a panel served over plain HTTP handed
 * the browser a cookie no browser on plain HTTP is allowed to keep. Chromium
 * hides that on loopback, which it treats as a secure context. WebKit does not:
 * Safari dropped the cookie outright, so signing in appeared to work and the
 * session guard's first poll bounced the operator straight back to the sign-in
 * screen with "oturumunuz sonlandırıldı".
 *
 * Nothing is relaxed by reading these. Over HTTPS the API sets `Secure` and
 * this copies it, exactly as before. What stops is this panel overriding the
 * API's decision with a guess it had no way to re-evaluate.
 *
 * The web app carries the same module, plus the parts only it needs. The two
 * are checked against each other by `session-cookie.spec.ts` in the web app,
 * which also fails the build if a `secure:` decision reappears anywhere else in
 * either application.
 */

/**
 * The only cookie name this module will re-issue.
 *
 * A runtime read, unlike `NODE_ENV`: Next leaves ordinary server-side
 * environment lookups alone, and the API resolves the same variable the same
 * way. Anything else in the API's response — a cookie for another path, or one
 * a proxy added — is ignored rather than copied onto this origin.
 */
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

export type ParsedSessionCookie = {
  name: string;
  value: string;
  /** Whether the API marked the cookie `Secure`, i.e. HTTPS-only. */
  secure: boolean;
  /** Whether the API marked it `HttpOnly`. Never re-issued as false — see below. */
  httpOnly: boolean;
  /** The API's `SameSite`, floored at `lax`. */
  sameSite: 'lax' | 'strict';
  /** The API's `Path`, defaulting to the origin root. */
  path: string;
  /** Present only for a persistent ("remember me") cookie. */
  expires?: Date;
  /** Present only for a persistent cookie, and preferred over `expires`. */
  maxAge?: number;
};

/**
 * Parses one `Set-Cookie` value.
 *
 * Anything it cannot make sense of is `null`, never a partially-built cookie:
 * the caller treats that as "no session was issued" and carries on with the
 * signed-out path it already had. Nothing about the header reaches a log, a URL
 * or the screen — a malformed one still contains a session id.
 *
 * `Domain` is deliberately not read. This panel re-issues on its own origin
 * only, and honouring a domain attribute would be the one way a copied cookie
 * could end up somewhere the API did not put it.
 */
export function parseSetCookie(value: string | null): ParsedSessionCookie | null {
  if (!value) {
    return null;
  }

  const [nameValue, ...attributes] = value.split(';').map((part) => part.trim());
  if (!nameValue) {
    return null;
  }

  const [name, ...rawValue] = nameValue.split('=');
  if (!name || rawValue.length === 0) {
    return null;
  }

  const attribute = (prefix: string) =>
    attributes.find((entry) => entry.toLowerCase().startsWith(prefix));
  const flag = (word: string) => attributes.some((entry) => entry.toLowerCase() === word);

  const expiresAttribute = attribute('expires=');
  const maxAgeAttribute = attribute('max-age=');
  const pathAttribute = attribute('path=');
  const sameSiteAttribute = attribute('samesite=');

  const expires = expiresAttribute
    ? new Date(expiresAttribute.slice('expires='.length))
    : undefined;
  const maxAge = maxAgeAttribute ? Number(maxAgeAttribute.slice('max-age='.length)) : undefined;
  const sameSiteValue = sameSiteAttribute?.slice('samesite='.length).trim().toLowerCase();

  return {
    name,
    value: decodeURIComponent(rawValue.join('=')),
    secure: flag('secure'),
    httpOnly: flag('httponly'),
    // `strict` is the only value stricter than this panel's floor, so it is the
    // only one taken. A header that arrived saying `none` — or saying nothing —
    // gets `lax`: mirroring the API must never be a way to relax a cookie.
    sameSite: sameSiteValue === 'strict' ? 'strict' : 'lax',
    path: pathAttribute ? pathAttribute.slice('path='.length) || '/' : '/',
    ...(expires && !Number.isNaN(expires.getTime()) ? { expires } : {}),
    ...(maxAge !== undefined && Number.isFinite(maxAge) ? { maxAge } : {}),
  };
}

/**
 * Finds the session cookie in an API response.
 *
 * `getSetCookie` rather than `get`, where the runtime has it: `Headers.get`
 * folds repeated headers into one comma-separated string, and a `Set-Cookie`
 * value contains commas of its own inside `Expires`, so splitting that string
 * back apart is not something to attempt. The name is then matched exactly, so
 * a second cookie in the same response is left where it is.
 */
export function readSessionCookie(response: Response): ParsedSessionCookie | null {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')];

  for (const value of raw) {
    const parsed = parseSetCookie(value);
    if (parsed?.name === AUTH_COOKIE_NAME) {
      return parsed;
    }
  }

  return null;
}

/**
 * The options to hand `cookies().set`, mirroring what the API decided.
 *
 * `httpOnly` is the one attribute restated rather than copied: it is this
 * panel's own guarantee about its own origin, and a header that somehow arrived
 * without it must not be able to take it away. Everything else is the API's
 * answer, `secure` included — it describes the transport the session was issued
 * over, which the API knows and this panel can only guess at.
 */
export function sessionCookieOptions(session: ParsedSessionCookie) {
  const persistent = session.maxAge !== undefined || session.expires !== undefined;

  return {
    httpOnly: true,
    sameSite: session.sameSite,
    secure: session.secure,
    path: session.path,
    // Omitted entirely for a non-persistent cookie: passing `undefined` is not
    // the same as passing nothing to every cookie implementation, and the
    // difference here is whether the session survives the browser closing.
    ...(persistent
      ? {
          ...(session.maxAge !== undefined ? { maxAge: session.maxAge } : {}),
          ...(session.expires ? { expires: session.expires } : {}),
        }
      : {}),
  };
}

/**
 * Re-issues the API's session cookie on this origin, and says what it issued.
 *
 * The single entry point for the one flow this panel has that signs anybody in.
 * It returns the cookie it wrote so a caller needing the session id for its own
 * next request does not have to read it back out of a store it cannot read.
 */
export async function persistSessionCookie(
  response: Response,
): Promise<ParsedSessionCookie | null> {
  const session = readSessionCookie(response);
  if (!session) {
    return null;
  }

  (await cookies()).set(session.name, session.value, sessionCookieOptions(session));
  return session;
}
