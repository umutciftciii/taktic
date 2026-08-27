/**
 * The one place that knows where this deployment lives on the public internet.
 *
 * Every link the platform mails — an activation link, a reset link, a request
 * detail page, the logo an inbox has to fetch — is built from this base. Before
 * it existed each caller reached for its own environment variable and its own
 * fallback, which is how a hard-coded `taktick.com` ends up in a template that
 * a staging deployment then mails out.
 *
 * Two rules:
 *
 * 1. **A deployment that delivers must say it.** There is no fallback there. A
 *    deployment that does not declare its own address would mail links to
 *    `localhost`, and the failure would only surface in somebody else's inbox.
 * 2. **https, except on loopback.** A link in a security e-mail is exactly the
 *    thing a recipient is told to check, and a plaintext one can be rewritten
 *    in transit. Loopback is exempted so `http://localhost:3000` keeps working
 *    for development, and that exemption is what rule 1 closes.
 *
 * Rule 1 keys on the transport, not on NODE_ENV. `EMAIL_TRANSPORT=resend` is
 * what decides whether a link this module builds is opened from somebody else's
 * device; whether the process was started as "development" decides nothing.
 * Production remains a second trigger, because a production process is required
 * to deliver anyway.
 *
 * Read on every call rather than cached, like every other configuration switch
 * in this codebase, so a test sees the environment it actually has.
 */

import { isDeliveringEmailTransportConfigured } from '../modules/notifications/email-transport';

/** The development fallback. Never used once the process can deliver mail. */
export const DEFAULT_PUBLIC_WEB_BASE_URL = 'http://localhost:3000';

/**
 * The variables that may name the web application, most specific first.
 *
 * `WEB_APP_URL` is the one to set. The other two are the names this repository
 * already used before the setting was centralised, and they are still honoured
 * so an existing deployment does not have to be reconfigured to keep working.
 */
const WEB_BASE_URL_VARIABLES = ['WEB_APP_URL', 'WEB_ORIGIN', 'NEXT_PUBLIC_WEB_URL'] as const;

/**
 * Where the e-mail images live.
 *
 * Defaults to the web application, because that is where `public/` is served
 * from and no second host is needed. It is separable because a deployment that
 * puts its static assets behind a CDN has to be able to say so without moving
 * the application itself.
 */
const ASSET_BASE_URL_VARIABLE = 'EMAIL_ASSET_BASE_URL';

export function readPublicWebBaseUrl(): string {
  const raw = firstConfigured(WEB_BASE_URL_VARIABLES);

  if (!raw) {
    if (requiresPublicBaseUrl()) {
      throw new Error(
        'WEB_APP_URL is required once e-mail is actually delivered (EMAIL_TRANSPORT=resend, or ' +
          'NODE_ENV=production): every link this application mails is built from it, and there ' +
          'is no address it could guess that would not be wrong.',
      );
    }

    return DEFAULT_PUBLIC_WEB_BASE_URL;
  }

  return normalizeBaseUrl(raw, WEB_BASE_URL_VARIABLES[0]);
}

export function readEmailAssetBaseUrl(): string {
  const raw = process.env[ASSET_BASE_URL_VARIABLE]?.trim();
  return raw ? normalizeBaseUrl(raw, ASSET_BASE_URL_VARIABLE) : readPublicWebBaseUrl();
}

/**
 * Builds an absolute URL onto the public web application.
 *
 * `path` is always treated as absolute from the site root — it is a route this
 * repository owns, never caller input — and the query is appended through
 * URLSearchParams so a token can never break out of the parameter it is in.
 */
export function publicWebUrl(
  path: string,
  query: Record<string, string> = {},
  base: string = readPublicWebBaseUrl(),
): string {
  const url = new URL(path.startsWith('/') ? path.slice(1) : path, `${base}/`);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

export function publicAssetUrl(path: string): string {
  return publicWebUrl(path, {}, readEmailAssetBaseUrl());
}

/**
 * Called once at boot so a missing or malformed base URL stops the process
 * rather than surfacing as a dead link in somebody's inbox a day later.
 */
export function assertPublicUrlConfig(): void {
  readPublicWebBaseUrl();
  readEmailAssetBaseUrl();
}

function firstConfigured(names: readonly string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return null;
}

function normalizeBaseUrl(raw: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // The value is echoed here on purpose: unlike an API key, a base URL is not
    // a credential, and the operator cannot fix a typo they cannot see.
    throw new Error(`${name} must be a valid absolute URL (received "${raw}")`);
  }

  if (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) {
    throw new Error(
      `${name} must use https unless it points at loopback (received "${parsed.protocol}//${parsed.hostname}")`,
    );
  }

  if (requiresPublicBaseUrl() && isLoopback(parsed.hostname)) {
    throw new Error(
      `${name} must not point at loopback once e-mail is actually delivered: the links built ` +
        'from it are opened from other people’s devices.',
    );
  }

  // No trailing slash, no path: everything downstream joins a rooted path onto
  // it, and "https://host/app" + "/login" would silently drop the "/app".
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an origin without a path, query or fragment (received "${raw}")`);
  }

  return parsed.origin;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/**
 * Whether this process may only build links onto a real, public address.
 *
 * True as soon as anything it composes can reach a stranger's inbox — see the
 * module comment. The import points at the notifications module on purpose:
 * that is where the transport switch lives, and nothing there reads this file,
 * so there is no cycle.
 */
function requiresPublicBaseUrl(): boolean {
  return isProduction() || isDeliveringEmailTransportConfigured();
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
