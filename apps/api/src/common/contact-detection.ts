import patterns from '@taktic/shared/contact-patterns.json';

/**
 * Marketplace requests now publish to providers without an operator reading
 * them first (see `SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH` for the sibling
 * limit that lives the same way). That removes the one human who used to
 * catch a customer trying to route around the platform — "call me on
 * 0532…", "mail me at…", a link to somewhere else — so the check has to run
 * before the text is ever stored.
 *
 * The JSON is imported rather than the package's TypeScript entry point on
 * purpose. This app is compiled to CommonJS and run from `dist`, and
 * `@taktic/shared` is `"type": "module"` shipping `.ts` source: a
 * `require('@taktic/shared')` in the built output type-checks and compiles,
 * then throws `SyntaxError: Unexpected token 'export'` the first time Node
 * loads it — the process would not boot. A JSON file has no such problem,
 * which is why the patterns live there and both sides read them from there
 * (see `packages/shared/src/contact-detection.ts`).
 *
 * The same reasoning is why `common/service-request-limits.ts` exists
 * alongside the package's description-length constant instead of importing
 * it.
 */
export type ContactDetailKind = 'phone' | 'email' | 'url';
export type ContactDetection = { kind: ContactDetailKind; match: string };

const phoneRun = new RegExp(patterns.phoneRun, 'g');
const separators = new RegExp(patterns.phoneSeparators, 'g');
const amountRange = new RegExp(patterns.amountRange);
const email = new RegExp(patterns.email, 'i');
const emailObfuscated = new RegExp(patterns.emailObfuscated, 'i');
const url = new RegExp(patterns.url, 'i');

/** Whether `inner`'s matched span sits entirely inside `outer`'s. */
function isContainedIn(inner: RegExpMatchArray, outer: RegExpMatchArray): boolean {
  const innerStart = inner.index ?? 0;
  const innerEnd = innerStart + inner[0].length;
  const outerStart = outer.index ?? 0;
  const outerEnd = outerStart + outer[0].length;
  return innerStart >= outerStart && innerEnd <= outerEnd;
}

/**
 * Finds the first thing in `text` that looks like a way to reach somebody
 * outside the platform. An obstacle, not a guarantee: a number spelled out in
 * words walks past it, and the provider's "Talebi bildir" is the second layer.
 *
 * The three patterns are checked together rather than strictly phone, then
 * email, then url, because a link can swallow a phone number
 * ("wa.me/905321234567") and an address can swallow a domain
 * ("ali@example.com" contains "example.com"). When one match's span sits
 * entirely inside another's, the wider, more specific match wins — a link or
 * an address, not the digit run or bare domain buried inside it.
 */
export function detectContactDetails(text: string): ContactDetection | null {
  const urlMatch = text.match(url);
  const emailMatch = text.match(email) ?? text.match(emailObfuscated);

  if (emailMatch && (!urlMatch || isContainedIn(urlMatch, emailMatch))) {
    return { kind: 'email', match: emailMatch[0] };
  }

  for (const candidate of text.matchAll(phoneRun)) {
    const match = candidate[0].trim();
    // "50.000 - 60.000 TL": a thousands-separated amount or range carries ten
    // or more digits behind a 0/5/90 prefix and would otherwise read as a
    // phone number. Budget text is the most common thing a customer writes.
    if (amountRange.test(match)) continue;
    const digits = match.replace(separators, '').replace(/^\+/, '');
    if (!/^\d+$/.test(digits)) continue;
    if (digits.length < patterns.phoneDigitsMin || digits.length > patterns.phoneDigitsMax) continue;
    if (!patterns.phonePrefixes.some((prefix) => digits.startsWith(prefix))) continue;
    if (urlMatch && isContainedIn(candidate, urlMatch)) continue;
    return { kind: 'phone', match };
  }

  if (urlMatch) return { kind: 'url', match: urlMatch[0] };

  return null;
}
