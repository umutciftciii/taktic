import seoPaths from '@taktic/shared/seo-paths.json';

/**
 * SEO-004 — the one form an address is stored, compared and served in.
 *
 * Every redirect source and target, and every 404 suggestion, passes through
 * {@link normalizeSeoPath}; the web middleware runs its own copy of the same
 * rules (apps/web/lib/seo-paths.ts) on the request path before it looks a
 * redirect up. Both are held to the cases in `packages/shared/seo-paths.json`.
 *
 * ## Refuse, never repair
 *
 * Only four things are normalised, because each of them names the same
 * address in two spellings: one percent-decoding, Unicode NFC, lower case
 * (locale-independent — `I` is `i` here whatever the server's locale says)
 * and one trailing slash. Everything else that is unusual is refused with a
 * code, not cleaned up: a scheme, `//`, a backslash in any spelling, an
 * encoded `/` or `\`, a second layer of encoding, a control character,
 * whitespace, a `.` or `..` segment, an empty segment, a query, a fragment, a
 * path longer than {@link SEO_PATH_MAX_LENGTH}. A redirect can only ever be
 * stored between two plain local paths, so it can never be made to point off
 * the site (no open redirect), and the middleware cannot be made to match a
 * path the API would not have stored.
 */

export const SEO_PATH_MAX_LENGTH: number = seoPaths.pathMaxLength;

/** A raw input longer than this is refused before any work is done on it. */
const RAW_INPUT_MAX_LENGTH = 2048;

export const SEO_PATH_REFUSALS = [
  'NOT_A_STRING',
  'EMPTY',
  'ABSOLUTE_URL',
  'BACKSLASH',
  'NOT_ROOTED',
  'PROTOCOL_RELATIVE',
  'QUERY',
  'FRAGMENT',
  'ENCODED_SEPARATOR',
  'DOUBLE_ENCODED',
  'MALFORMED_ENCODING',
  'CONTROL_CHARACTER',
  'WHITESPACE',
  'EMPTY_SEGMENT',
  'DOT_SEGMENT',
  'TOO_LONG',
] as const;
export type SeoPathRefusal = (typeof SEO_PATH_REFUSALS)[number];

export type SeoPathResult = { ok: true; path: string } | { ok: false; refusal: SeoPathRefusal };

const refuse = (refusal: SeoPathRefusal): SeoPathResult => ({ ok: false, refusal });

export function normalizeSeoPath(raw: unknown): SeoPathResult {
  if (typeof raw !== 'string') return refuse('NOT_A_STRING');
  if (raw.length === 0) return refuse('EMPTY');
  if (raw.length > RAW_INPUT_MAX_LENGTH) return refuse('TOO_LONG');
  // A scheme ("https:", "javascript:") or an authority anywhere in the path.
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

  const segments = path.slice(1).split('/');
  for (const segment of segments) {
    if (segment === '') return refuse('EMPTY_SEGMENT');
    if (segment === '.' || segment === '..') return refuse('DOT_SEGMENT');
  }
  if (path.length > SEO_PATH_MAX_LENGTH) return refuse('TOO_LONG');
  return { ok: true, path };
}

/** The path's segments, without the leading empty one. `/` has none. */
export function seoPathSegments(path: string): string[] {
  return path === '/' ? [] : path.slice(1).split('/');
}

const PUBLIC_FAMILIES: readonly string[] = seoPaths.publicFamilies;
const RESERVED_TOP_LEVEL: readonly string[] = seoPaths.reservedTopLevelSegments;

export type SeoSourceRefusal = 'ROOT' | 'RESERVED_ROUTE' | 'STATIC_ASSET';

/**
 * Whether a normalised path may be a redirect *source* at all, before the
 * database is asked whether it is a live page. The root, every private or
 * functional route tree of the web app, the bare public listings
 * (`/categories`, `/isletme`, `/vitrin`) and anything that looks like a file
 * are refused: the middleware never runs on a file path, and a redirect on an
 * application route would hijack it.
 */
export function seoSourceRefusal(path: string): SeoSourceRefusal | null {
  const segments = seoPathSegments(path);
  if (segments.length === 0) return 'ROOT';
  const [first] = segments;
  if (RESERVED_TOP_LEVEL.includes(first!)) return 'RESERVED_ROUTE';
  if (PUBLIC_FAMILIES.includes(first!) && segments.length === 1) return 'RESERVED_ROUTE';
  // The middleware never runs on a path with a dot in it (a file), so a
  // source with one could be stored and never served.
  if (segments.some((segment) => segment.includes('.'))) return 'STATIC_ASSET';
  return null;
}

/**
 * The page a canonical path names, when it names one of the six indexable
 * routes (apps/web/lib/seo-routes.ts INDEXABLE_ROUTES), or null. This is the
 * only shape a redirect target may have; whether that page is live right now
 * is the database's question (SeoLivePages).
 */
export type SeoPageRef =
  | { kind: 'HOME' }
  | { kind: 'CATALOGUE' }
  | { kind: 'SHELF' }
  | { kind: 'CATEGORY'; slug: string }
  | { kind: 'PROVIDER'; id: string }
  | { kind: 'SHOWCASE_CARD'; cardId: string };

export function seoPageRef(path: string): SeoPageRef | null {
  const segments = seoPathSegments(path);
  if (segments.length === 0) return { kind: 'HOME' };
  const [family, id] = segments;
  if (segments.length === 1) {
    if (family === 'categories') return { kind: 'CATALOGUE' };
    if (family === 'vitrin') return { kind: 'SHELF' };
    return null;
  }
  if (segments.length !== 2) return null;
  if (family === 'categories') return { kind: 'CATEGORY', slug: id! };
  if (family === 'isletme') return { kind: 'PROVIDER', id: id! };
  if (family === 'vitrin') return { kind: 'SHOWCASE_CARD', cardId: id! };
  return null;
}

export function categoryPath(slug: string): string {
  return `/categories/${slug}`;
}
