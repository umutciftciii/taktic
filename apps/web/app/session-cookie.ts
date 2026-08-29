/**
 * Re-issuing the API's session cookie on this app's own origin.
 *
 * The browser talks to Next, and Next talks to the API. The `Set-Cookie` the
 * API returns is therefore for a response the browser never sees, so the login
 * action has to copy it onto its own. Copying it means reproducing the same
 * decision — including the two attributes that are easy to lose.
 *
 * **Whether the cookie is persistent.** An ordinary session cookie carries
 * neither `Max-Age` nor `Expires` and dies with the browser. A remembered one
 * carries both. Re-issuing every cookie with an expiry would quietly turn
 * "Beni hatırla" on for everybody, which is exactly the kind of security
 * decision nobody would notice being made.
 *
 * **Whether the cookie requires TLS.** `Secure` is read from the API's header
 * for the same reason as the expiry: the API issued this session and is what
 * knows the transport it was issued over. This used to be decided here instead,
 * from `process.env.NODE_ENV === 'production'` — and that is not a runtime read.
 * Next folds it away at build time, so a compiled server always said `Secure`
 * whatever it was later started with, and a stack served over plain HTTP handed
 * the browser a cookie no browser on plain HTTP is allowed to keep. Chromium
 * hides that on loopback, which it treats as a secure context. WebKit does not:
 * Safari dropped the cookie outright, so signing in appeared to work and the
 * session guard's first poll bounced the person straight back to the sign-in
 * screen with "oturumunuz sonlandırıldı" — and "Beni hatırla" remembered
 * nothing, because there was no cookie left to be persistent.
 *
 * Nothing is relaxed by reading it. Over HTTPS the API sets `Secure` and this
 * copies it, exactly as before. What stops is this app overriding the API's
 * decision with a guess it had no way to re-evaluate.
 */

export type ParsedSessionCookie = {
  name: string;
  value: string;
  /** Present only for a persistent ("remember me") cookie. */
  expires?: Date;
  /** Present only for a persistent cookie, and preferred over `expires`. */
  maxAge?: number;
  /** Whether the API marked the cookie `Secure`, i.e. HTTPS-only. */
  secure: boolean;
};

export function parseSetCookie(value: string | null): ParsedSessionCookie | null {
  if (!value) {
    return null;
  }

  const [nameValue, ...attributes] = value.split(';').map((part) => part.trim());
  if (!nameValue) {
    return null;
  }

  const [name, ...rawValue] = nameValue.split('=');
  if (!name) {
    return null;
  }

  const expiresAttribute = attributes.find((attribute) =>
    attribute.toLowerCase().startsWith('expires='),
  );
  const maxAgeAttribute = attributes.find((attribute) =>
    attribute.toLowerCase().startsWith('max-age='),
  );

  const expires = expiresAttribute
    ? new Date(expiresAttribute.slice('expires='.length))
    : undefined;
  const maxAge = maxAgeAttribute ? Number(maxAgeAttribute.slice('max-age='.length)) : undefined;

  // A valueless flag, matched case-insensitively the way the header defines it.
  const secure = attributes.some((attribute) => attribute.toLowerCase() === 'secure');

  return {
    name,
    value: decodeURIComponent(rawValue.join('=')),
    secure,
    ...(expires && !Number.isNaN(expires.getTime()) ? { expires } : {}),
    ...(maxAge !== undefined && Number.isFinite(maxAge) ? { maxAge } : {}),
  };
}

/**
 * The options to hand `cookies().set`, mirroring what the API decided.
 *
 * `httpOnly` and `sameSite` are not copied from the header but restated: they
 * are this application's own guarantee about its own origin, and a header that
 * somehow arrived without them must not be able to relax them. `secure` is the
 * opposite case and is copied — it describes the transport the session was
 * issued over, which the API knows and this app can only guess at. See above.
 */
export function sessionCookieOptions(session: ParsedSessionCookie) {
  const persistent = session.maxAge !== undefined || session.expires !== undefined;

  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: session.secure,
    path: '/',
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
