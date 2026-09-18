/**
 * Whether this deployment may be indexed by a search engine, and at which
 * origin. Every SEO surface — the robots meta, `robots.txt`, `sitemap.xml`,
 * canonical links, Open Graph URLs and JSON-LD — asks this one question and
 * nothing else.
 *
 * ## Closed unless told otherwise
 *
 * Open needs two explicit statements from the deployment's own environment:
 *
 *   APP_ENVIRONMENT=production   the same declaration every environment-gated
 *                                behaviour reads (see lib/turnstile.ts and the
 *                                API's app-environment.ts). Staging and local
 *                                are closed; so is an undeclared or misspelt
 *                                value. NODE_ENV takes no part — under
 *                                `next start` it is always "production".
 *   WEB_APP_URL=https://…        the public origin the API already mails links
 *                                from, with the API's own rule for what counts
 *                                (public-urls.ts): a parseable https origin
 *                                with no path, query or fragment, and not
 *                                loopback. WEB_ORIGIN and NEXT_PUBLIC_WEB_URL
 *                                are honoured after it, in the same order.
 *
 * A production deployment that has not named its origin is closed too, on
 * purpose: the alternative is a canonical link or a sitemap pointing at
 * `localhost`, which tells a crawler the site lives on its own machine.
 *
 * ## Nothing here reads a request
 *
 * `Host`, `X-Forwarded-Host` and `Origin` are supplied by whoever is talking.
 * An origin a caller could choose would let anybody make the canonical URL of
 * every page point at their own domain.
 *
 * Read on every call rather than cached at import time, like the other
 * configuration readers in this application, so a test sees the environment
 * it set.
 */

const ORIGIN_VARIABLES = ['WEB_APP_URL', 'WEB_ORIGIN', 'NEXT_PUBLIC_WEB_URL'] as const;

export type SeoClosedReason =
  | 'ENVIRONMENT_UNDECLARED'
  | 'ENVIRONMENT_NOT_PRODUCTION'
  | 'ENVIRONMENT_INVALID'
  | 'ORIGIN_MISSING'
  | 'ORIGIN_MALFORMED'
  | 'ORIGIN_NOT_AN_ORIGIN'
  | 'ORIGIN_INSECURE'
  | 'ORIGIN_LOOPBACK';

export type SeoSite =
  | { indexable: true; origin: string }
  | { indexable: false; origin: null; reason: SeoClosedReason };

export function resolveSeoSite(env: NodeJS.ProcessEnv = process.env): SeoSite {
  const environment = env.APP_ENVIRONMENT?.trim() ?? '';
  if (!environment) {
    return closed('ENVIRONMENT_UNDECLARED');
  }
  if (environment === 'local' || environment === 'staging') {
    return closed('ENVIRONMENT_NOT_PRODUCTION');
  }
  if (environment !== 'production') {
    // A typo must not quietly read as anything. Not thrown either: this is a
    // gate on a page render, not a boot condition.
    return closed('ENVIRONMENT_INVALID');
  }

  const raw = ORIGIN_VARIABLES.map((name) => env[name]?.trim()).find((value) => value);
  if (!raw) {
    return closed('ORIGIN_MISSING');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return closed('ORIGIN_MALFORMED');
  }

  // Every path is joined onto this, and "https://host/app" + "/login" would
  // silently drop the "/app".
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return closed('ORIGIN_NOT_AN_ORIGIN');
  }

  if (isLoopback(parsed.hostname)) {
    return closed('ORIGIN_LOOPBACK');
  }

  if (parsed.protocol !== 'https:') {
    return closed('ORIGIN_INSECURE');
  }

  return { indexable: true, origin: parsed.origin };
}

function closed(reason: SeoClosedReason): SeoSite {
  return { indexable: false, origin: null, reason };
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}
