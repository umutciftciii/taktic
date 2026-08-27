/**
 * The one place that knows where this deployment lives on the public internet.
 *
 * Every link the platform mails — an activation link, a reset link, a request
 * detail page, the logo an inbox has to fetch — is built from this base. Before
 * it existed each caller reached for its own environment variable and its own
 * fallback, which is how a hard-coded `taktick.com` ends up in a template that
 * a staging deployment then mails out.
 *
 * **Nothing here ever throws, and nothing here stops the process.** That is a
 * correction, and it is the whole point of this module's shape. This validation
 * used to run at boot and refuse to start the API when the base URL was not a
 * public https origin — so a developer whose local stack happened to have a
 * real transport selected lost the API, and with it authentication, the admin
 * panel and every request and offer flow, because of a rule about *e-mail*. The
 * blast radius was wrong by an order of magnitude: an unusable link in a
 * message is a mail problem, not a reason for a marketplace to be down.
 *
 * So resolution is now a *description* rather than an assertion. Two rules
 * still decide whether a base may be mailed to a stranger:
 *
 * 1. **It has to exist and be an origin.** A missing, unparseable or
 *    path-carrying value cannot address anything.
 * 2. **https, except that loopback is not public at all.** A link in a security
 *    e-mail is exactly the thing a recipient is told to check, and a plaintext
 *    one can be rewritten in transit; `http://localhost:3000` is worse still,
 *    because it resolves to the recipient's own machine.
 *
 * Both are reported as an issue, never raised. `readPublicWebBaseUrl()` always
 * hands back something a URL can be built from — link building happens deep
 * inside business flows, and an accepted offer must not fail because a footer
 * would have been wrong — and the delivering transport asks
 * {@link isPublicUrlDeliverable} before it puts a message on the wire. A
 * message that would carry an unusable link is refused there and recorded as a
 * FAILED notification, which is the layer where "this cannot be delivered"
 * belongs.
 *
 * Read on every call rather than cached, like every other configuration switch
 * in this codebase, so a test sees the environment it actually has.
 */

/** The development fallback, and the base used when a value cannot be parsed. */
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

/**
 * Why a base URL may not be mailed to a stranger.
 *
 * A closed set, and every member names a *class* of defect rather than quoting
 * the value: these travel into log lines next to a masked recipient, and a base
 * URL that turned out to be a pasted credential must not be echoed there.
 */
export const PUBLIC_URL_ISSUES = [
  'MISSING',
  'MALFORMED',
  'NOT_AN_ORIGIN',
  'INSECURE',
  'LOOPBACK',
] as const;

export type PublicUrlIssue = (typeof PUBLIC_URL_ISSUES)[number];

export type PublicUrlResolution = {
  /** Always usable for building a link. Never empty, never throws. */
  baseUrl: string;
  /** Which variable the value came from, so an operator edits the right one. */
  source: string;
  /** Null when this base may appear in a message to a stranger. */
  issue: PublicUrlIssue | null;
};

export function resolvePublicWebBaseUrl(): PublicUrlResolution {
  const found = firstConfigured(WEB_BASE_URL_VARIABLES);

  if (!found) {
    return {
      baseUrl: DEFAULT_PUBLIC_WEB_BASE_URL,
      // Nothing is set, so name the variable an operator should set.
      source: WEB_BASE_URL_VARIABLES[0],
      issue: 'MISSING',
    };
  }

  return describeBaseUrl(found.value, found.name);
}

export function resolveEmailAssetBaseUrl(): PublicUrlResolution {
  const raw = process.env[ASSET_BASE_URL_VARIABLE]?.trim();
  // Unset is not a defect: the assets live on the web application by default,
  // and that base carries its own verdict.
  return raw ? describeBaseUrl(raw, ASSET_BASE_URL_VARIABLE) : resolvePublicWebBaseUrl();
}

export function readPublicWebBaseUrl(): string {
  return resolvePublicWebBaseUrl().baseUrl;
}

export function readEmailAssetBaseUrl(): string {
  return resolveEmailAssetBaseUrl().baseUrl;
}

/**
 * Whether both bases may appear in a delivered message.
 *
 * Asked by the delivering transport, once per send. The asset base is included
 * because every designed template embeds the logo: a message whose image URL
 * points at the recipient's own machine is as broken as one whose button does.
 */
export function isPublicUrlDeliverable(): boolean {
  return publicUrlIssues().length === 0;
}

/**
 * The issues, for the log line the refusal writes. Named by variable so the
 * operator is sent to the setting that is actually at fault — this used to say
 * `WEB_APP_URL` even when the value had come from `WEB_ORIGIN`.
 *
 * De-duplicated, because with no CDN configured the asset base *is* the web
 * base: reporting one misconfigured value twice would read as two problems.
 */
export function publicUrlIssues(): { source: string; issue: PublicUrlIssue }[] {
  const seen = new Set<string>();

  return [resolvePublicWebBaseUrl(), resolveEmailAssetBaseUrl()]
    .filter((resolution) => resolution.issue !== null)
    .filter((resolution) => {
      const key = `${resolution.source}:${resolution.issue}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .map((resolution) => ({ source: resolution.source, issue: resolution.issue as PublicUrlIssue }));
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
 * Classifies one configured value.
 *
 * The returned `baseUrl` is always something `new URL()` accepts, including for
 * a value this function is about to call unusable: callers build links
 * unconditionally and the verdict is consulted separately, so there is never a
 * moment where a bad setting turns into an exception in a business flow.
 */
function describeBaseUrl(raw: string, name: string): PublicUrlResolution {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { baseUrl: DEFAULT_PUBLIC_WEB_BASE_URL, source: name, issue: 'MALFORMED' };
  }

  // Everything downstream joins a rooted path onto this, and
  // "https://host/app" + "/login" would silently drop the "/app".
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { baseUrl: parsed.origin, source: name, issue: 'NOT_AN_ORIGIN' };
  }

  if (isLoopback(parsed.hostname)) {
    return { baseUrl: parsed.origin, source: name, issue: 'LOOPBACK' };
  }

  if (parsed.protocol !== 'https:') {
    return { baseUrl: parsed.origin, source: name, issue: 'INSECURE' };
  }

  return { baseUrl: parsed.origin, source: name, issue: null };
}

function firstConfigured(
  names: readonly string[],
): { name: string; value: string } | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return { name, value };
    }
  }

  return null;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}
