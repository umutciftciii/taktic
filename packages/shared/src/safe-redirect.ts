/**
 * The one place that decides whether a `redirectTo` may be followed.
 *
 * Every sign-in screen in this product carries the destination the visitor was
 * heading for, and that value arrives from the address bar — which means it
 * arrives from whoever wrote the link. A value taken at face value turns the
 * login page into an open redirect: `/login?redirectTo=https://evil.example`
 * lands somebody on an attacker's copy of this site *after* they successfully
 * signed in, which is the moment they are least likely to look at the address
 * bar. The same value is also echoed back into a hidden form field, so it has
 * to be safe on the way in as well as on the way out.
 *
 * The rule is deliberately narrow: **a destination is either a path inside this
 * application, or it does not exist.** No host is ever accepted, not even this
 * deployment's own — the apps never need one, and a helper that can say yes to
 * a hostname is a helper somebody will eventually configure wrongly.
 *
 * What that excludes, and why each one is written out rather than left to the
 * parser:
 *
 *   `https://evil.example`   an absolute URL; a scheme is never a path.
 *   `//evil.example`         protocol-relative — a hostname wearing a path's
 *                            clothes, and the classic way past a
 *                            `startsWith('/')` check.
 *   `///evil.example`        the same thing with a slash added, which browsers
 *                            collapse back to the case above.
 *   `/\evil.example`         a backslash in a URL is normalised to a forward
 *                            slash, so this reaches the network as
 *                            `//evil.example`.
 *   `javascript:`, `data:`   not paths at all; excluded by the leading-slash
 *                            rule and named here so the intent is on the
 *                            record.
 *   control characters       newline, carriage return, NUL and friends are
 *                            stripped by browsers before a URL is parsed, so a
 *                            value that only looks safe with them in is not.
 *   `/%2f%2fevil.example`    percent-encoding that decodes into one of the
 *                            shapes above.
 *
 * Everything that survives is rebuilt from a parsed URL, so what the caller
 * gets back is a normalised `pathname + search + hash` — the query string and
 * the fragment of a legitimate destination are preserved, because dropping them
 * would send somebody who was two pages deep back to a list.
 */

/**
 * The origin every candidate is resolved against.
 *
 * `.invalid` is reserved by RFC 2606 and can never be registered, so a bug that
 * let this origin escape into a real redirect would point at nothing rather
 * than at somebody else's server.
 */
const RESOLUTION_BASE = 'https://redirect-check.invalid';

/** Where a rejected — or absent — destination goes by default. */
export const DEFAULT_SAFE_REDIRECT = '/';

/** ASCII control characters, which no legitimate destination contains. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * How many times a candidate is decoded before its shape is judged.
 *
 * Two rounds cover single and double encoding, which is everything a browser or
 * a proxy in front of this application could plausibly collapse; the third is
 * there so the loop can prove it reached a fixed point rather than stopping
 * because it ran out of turns.
 */
const MAX_DECODE_ROUNDS = 3;

/**
 * The destination, or `null` when there is not a safe one.
 *
 * Callers with a better fallback than "the site root" — a sign-in that knows
 * where this particular role belongs — use this and decide for themselves.
 * Everyone else uses {@link safeRedirectPath}.
 */
export function safeRedirectPathOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  // Browsers strip surrounding whitespace before parsing a URL, so the value
  // that would actually be followed is the trimmed one — judge that, not the
  // original.
  const candidate = raw.trim();

  if (!isSafeShape(candidate)) {
    return null;
  }

  // The same test again on what the value decodes to. `/%2f%2fevil.example`
  // passes the checks above as written, and is `///evil.example` by the time
  // anything resolves it.
  const decoded = fullyDecode(candidate);
  if (decoded === null || !isSafeShape(decoded)) {
    return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(candidate, RESOLUTION_BASE);
  } catch {
    return null;
  }

  // Belt and braces: nothing above should be able to produce a different
  // origin, and if something ever does, this is where it stops.
  if (resolved.origin !== new URL(RESOLUTION_BASE).origin) {
    return null;
  }

  // `/..%2f..` and friends normalise during parsing; re-check the result rather
  // than trusting that normalisation could only ever make a path more ordinary.
  if (!resolved.pathname.startsWith('/') || resolved.pathname.startsWith('//')) {
    return null;
  }

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * The destination, or `fallback` when there is not a safe one.
 *
 * The fallback is a route this repository owns and is never caller input, so it
 * is returned as given.
 */
export function safeRedirectPath(raw: unknown, fallback: string = DEFAULT_SAFE_REDIRECT): string {
  return safeRedirectPathOrNull(raw) ?? fallback;
}

/** Whether a literal string is shaped like an in-application path. */
function isSafeShape(value: string): boolean {
  if (!value.startsWith('/')) {
    return false;
  }

  // `//host` and `/\host` both address another origin. A backslash anywhere is
  // refused rather than only in second position: it has no business in a path
  // this application generates, and every browser rewrites it to `/`.
  if (value.startsWith('//') || value.includes('\\')) {
    return false;
  }

  return !CONTROL_CHARACTERS.test(value);
}

/**
 * Decodes until the value stops changing.
 *
 * Malformed percent-encoding is a rejection rather than a pass-through: every
 * destination this application produces is a path it built itself, so a value
 * `decodeURIComponent` cannot read did not come from here.
 */
function fullyDecode(value: string): string | null {
  let current = value;

  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }

    if (next === current) {
      return current;
    }

    current = next;
  }

  return current;
}
