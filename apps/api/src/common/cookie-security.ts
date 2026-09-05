import { resolvePublicWebBaseUrl } from './public-urls';

/**
 * Whether a cookie this API issues must carry `Secure`.
 *
 * One question, asked from one place, by every path that writes or clears the
 * session cookie. It used to be `process.env.NODE_ENV === 'production'`, and
 * that is the wrong question in both directions:
 *
 * **It is not the transport.** A deployment reachable at `https://…` and
 * started with `NODE_ENV=development` — which is exactly how the staging stack
 * runs, and why this exists — handed the browser a session cookie with no
 * `Secure`. Such a cookie is sent over plain HTTP too, so anything that can
 * strip TLS from one request (a hostile network, a downgraded link, a mixed
 * page) gets a live session id in cleartext. `HttpOnly` does not help: it hides
 * the cookie from script, not from the wire.
 *
 * **It is not the environment either.** `NODE_ENV=production` on the plain-HTTP
 * local stack marks the cookie `Secure`, and a browser then refuses to keep it —
 * that is the Safari failure the web app's `session-cookie.ts` documents, seen
 * from the other end.
 *
 * So the answer is read from the thing that actually describes where the
 * browser is: **the public web origin this deployment is configured with**.
 * `WEB_APP_URL` / `WEB_ORIGIN` / `NEXT_PUBLIC_WEB_URL` are already set on every
 * deployment — the CORS allow-list and every mailed link are built from the same
 * resolution — so no new variable is introduced and nothing new is mandatory. An
 * https origin means the browser holding this cookie reached us over TLS, and
 * `Secure` costs it nothing; the local `http://localhost:3000` default means it
 * did not, and `Secure` would throw the cookie away.
 *
 * **Nothing here reads a request.** `X-Forwarded-Proto` and its relatives are
 * attacker-supplied on any hop that does not overwrite them, and a header that
 * can turn `Secure` off is not a security decision — it is a switch handed to
 * whoever is talking. This function takes no arguments for that reason: there is
 * no request to be confused by.
 */
export function sessionCookieIsSecure(): boolean {
  // `baseUrl` is always an origin `URL` produced and normalised (see
  // public-urls.ts, which promises never to throw and never to return a value
  // `new URL()` would reject), so a scheme prefix test is exact — and, unlike
  // parsing here, cannot fail on the sign-in path.
  return resolvePublicWebBaseUrl().baseUrl.startsWith('https://');
}
