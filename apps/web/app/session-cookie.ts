import { cookies, headers } from 'next/headers';

/**
 * The one place this application writes a cookie.
 *
 * Two kinds pass through here, and they are decided differently on purpose.
 *
 * **The API's session cookie**, re-issued on this app's own origin. The browser
 * talks to Next and Next talks to the API, so the `Set-Cookie` the API returns
 * is for a response the browser never sees. Copying it means reproducing the
 * API's decision rather than forming a second one: the API issued this session
 * and is the only party that knows what it needs.
 *
 * **Cookies this app owns**, like the short-lived provider-claim token. There
 * is no API header to mirror for those, so the one attribute that cannot be
 * guessed — whether the connection requires TLS — is read from the request.
 *
 * ---
 *
 * Two attributes used to be lost, and both cost a real flow.
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
 * whatever it was later started with, and a stack served over plain HTTP handed
 * the browser a cookie no browser on plain HTTP is allowed to keep. Chromium
 * hides that on loopback, which it treats as a secure context. WebKit does not:
 * Safari dropped the cookie outright, so the flow appeared to succeed and the
 * session guard's first poll bounced the person straight back to the sign-in
 * screen with "oturumunuz sonlandırıldı" — and "Beni hatırla" remembered
 * nothing, because no cookie survived to be persistent.
 *
 * Nothing is relaxed by reading these. Over HTTPS the API sets `Secure` and
 * this copies it, exactly as before. What stops is this app overriding the
 * API's decision with a guess it had no way to re-evaluate.
 *
 * `session-cookie.spec.ts` is the executable half of this: it pins the mirrored
 * attributes in both directions, and it fails the build if a `secure:` decision
 * reappears anywhere else in either application.
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
 * the callers all treat that as "no session was issued" and carry on with the
 * signed-out path they already had. Nothing about the header reaches a log, a
 * URL or the screen — a malformed one still contains a session id.
 *
 * `Domain` is deliberately not read. This app re-issues on its own origin only,
 * and honouring a domain attribute would be the one way a copied cookie could
 * end up somewhere the API did not put it.
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
    // `strict` is the only value stricter than this app's floor, so it is the
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
 * application's own guarantee about its own origin, and a header that somehow
 * arrived without it must not be able to take it away. Everything else is the
 * API's answer, `secure` included — it describes the transport the session was
 * issued over, which the API knows and this app can only guess at.
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
 * The single entry point for every flow that signs somebody in — sign-in, both
 * registrations, customer activation and the provider claim. They used to do
 * this themselves, each with its own copy of the parser, and the copies had
 * drifted: none of them carried `Max-Age`, all of them passed `expires:
 * undefined` for an ordinary session, and all of them decided `Secure` from the
 * build-time constant. One caller is why there is one behaviour.
 *
 * Returns the cookie it wrote, so a caller that needs the session id for its
 * own next request — the sign-in action looks a provider's panel up with it —
 * does not have to read it back out of a store it cannot read.
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

/**
 * Whether the request being served arrived over TLS.
 *
 * A runtime fact, read from the request rather than assumed from the build.
 * Next fills `x-forwarded-proto` in on every request it handles: it honours what
 * a terminating proxy said, and falls back to whether its own socket was
 * encrypted. So this is "https" behind a load balancer, "https" on a directly
 * served TLS origin, and "http" on the plain-HTTP origins where marking a
 * cookie `Secure` is what threw the cookie away.
 *
 * Only for cookies this application issues itself. Anything the API issued is
 * mirrored from its header instead, which is a stronger answer than this one.
 */
export async function requestIsOverHttps(): Promise<boolean> {
  return (await headers()).get('x-forwarded-proto') === 'https';
}

/**
 * The options for a cookie this application owns rather than mirrors.
 *
 * Same floor as the session cookie — HttpOnly, SameSite=Lax — with `secure`
 * taken from the transport actually in use. Callers pass only what differs:
 * how long it lives and, where it is scoped to one screen, where it applies.
 */
export async function appCookieOptions(options: { path?: string; maxAge: number }) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: await requestIsOverHttps(),
    path: options.path ?? '/',
    maxAge: options.maxAge,
  };
}
