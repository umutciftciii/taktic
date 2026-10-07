import seoPaths from '../../../packages/shared/seo-paths.json';

/**
 * SEO-004 — the request path in the one form redirects are stored in.
 *
 * The API stores every redirect source in this form
 * (apps/api/src/modules/seo/seo-paths.ts) and the middleware looks the
 * request path up in the same form, so the two must agree on every input.
 * They are separate code — the API cannot import this app — and are held to
 * the same cases in `packages/shared/seo-paths.json` by both test suites.
 *
 * Four things are normalised (one percent-decoding, NFC, locale-independent
 * lower case, one trailing slash); anything else unusual — a scheme, `//`, a
 * backslash in any spelling, an encoded separator, double encoding, a control
 * character, whitespace, a dot segment, an empty segment, a query, a
 * fragment, an over-long path — is refused, and a refused path is simply not
 * redirected.
 */

export const SEO_PATH_MAX_LENGTH: number = seoPaths.pathMaxLength;
const RAW_INPUT_MAX_LENGTH = 2048;

export type SeoPathRefusal =
  | 'NOT_A_STRING'
  | 'EMPTY'
  | 'ABSOLUTE_URL'
  | 'BACKSLASH'
  | 'NOT_ROOTED'
  | 'PROTOCOL_RELATIVE'
  | 'QUERY'
  | 'FRAGMENT'
  | 'ENCODED_SEPARATOR'
  | 'DOUBLE_ENCODED'
  | 'MALFORMED_ENCODING'
  | 'CONTROL_CHARACTER'
  | 'WHITESPACE'
  | 'EMPTY_SEGMENT'
  | 'DOT_SEGMENT'
  | 'TOO_LONG';

export type SeoPathResult = { ok: true; path: string } | { ok: false; refusal: SeoPathRefusal };

const refuse = (refusal: SeoPathRefusal): SeoPathResult => ({ ok: false, refusal });

export function normalizeSeoPath(raw: unknown): SeoPathResult {
  if (typeof raw !== 'string') return refuse('NOT_A_STRING');
  if (raw.length === 0) return refuse('EMPTY');
  if (raw.length > RAW_INPUT_MAX_LENGTH) return refuse('TOO_LONG');
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.includes('://')) return refuse('ABSOLUTE_URL');
  if (raw.includes('\\')) return refuse('BACKSLASH');
  if (!raw.startsWith('/')) return refuse('NOT_ROOTED');
  if (raw.startsWith('//')) return refuse('PROTOCOL_RELATIVE');
  if (raw.includes('?')) return refuse('QUERY');
  if (raw.includes('#')) return refuse('FRAGMENT');
  if (/%2f|%5c/i.test(raw)) return refuse('ENCODED_SEPARATOR');
  if (/%25/i.test(raw)) return refuse('DOUBLE_ENCODED');

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return refuse('MALFORMED_ENCODING');
  }

  if (/[\u0000-\u001f\u007f-\u009f]/.test(decoded)) return refuse('CONTROL_CHARACTER');
  if (/[\s\u200b-\u200f\u2028\u2029\u2060\ufeff]/u.test(decoded)) return refuse('WHITESPACE');
  if (decoded.includes('?')) return refuse('QUERY');
  if (decoded.includes('#')) return refuse('FRAGMENT');

  let path = decoded.normalize('NFC').toLowerCase();
  if (path === '/') return { ok: true, path };
  if (path.endsWith('/')) path = path.slice(0, -1);

  for (const segment of path.slice(1).split('/')) {
    if (segment === '') return refuse('EMPTY_SEGMENT');
    if (segment === '.' || segment === '..') return refuse('DOT_SEGMENT');
  }
  if (path.length > SEO_PATH_MAX_LENGTH) return refuse('TOO_LONG');
  return { ok: true, path };
}

/**
 * Whether a normalised path has the shape of one of the six indexable routes
 * (seo-routes.ts INDEXABLE_ROUTES) — the only thing a redirect may lead to.
 * The API checked that the target was a live page when it stored it; this is
 * the middleware's own refusal of anything else a snapshot might carry.
 */
export function isCanonicalPageShape(path: string): boolean {
  if (path === '/' || path === '/categories' || path === '/vitrin') return true;
  const segments = path.slice(1).split('/');
  return segments.length === 2 && ['categories', 'isletme', 'vitrin'].includes(segments[0]!) && /^[a-z0-9-]+$/.test(segments[1]!);
}
