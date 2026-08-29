/**
 * Re-issuing the API's session cookie on this app's own origin.
 *
 * The browser talks to Next, and Next talks to the API. The `Set-Cookie` the
 * API returns is therefore for a response the browser never sees, so the login
 * action has to copy it onto its own. Copying it means reproducing the same
 * decision — including the one attribute that is easy to lose: whether the
 * cookie is persistent.
 *
 * An ordinary session cookie carries neither `Max-Age` nor `Expires` and dies
 * with the browser. A remembered one carries both. Re-issuing every cookie with
 * an expiry would quietly turn "Beni hatırla" on for everybody, which is
 * exactly the kind of security decision nobody would notice being made.
 */

export type ParsedSessionCookie = {
  name: string;
  value: string;
  /** Present only for a persistent ("remember me") cookie. */
  expires?: Date;
  /** Present only for a persistent cookie, and preferred over `expires`. */
  maxAge?: number;
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

  return {
    name,
    value: decodeURIComponent(rawValue.join('=')),
    ...(expires && !Number.isNaN(expires.getTime()) ? { expires } : {}),
    ...(maxAge !== undefined && Number.isFinite(maxAge) ? { maxAge } : {}),
  };
}

/**
 * The options to hand `cookies().set`, mirroring what the API decided.
 *
 * `httpOnly` and `sameSite` are not copied from the header but restated: they
 * are this application's own guarantee about its own origin, and a header that
 * somehow arrived without them must not be able to relax them.
 */
export function sessionCookieOptions(session: ParsedSessionCookie) {
  const persistent = session.maxAge !== undefined || session.expires !== undefined;

  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
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
