/**
 * Query-string helpers for the shared list components (ADMIN-DESIGN-001 Faz 2).
 *
 * Every list state that is worth sharing — the filters, the saved view, the tab
 * and the page — lives in the URL, so the screens work as plain GET forms and
 * links, a copied address reopens the same view, and none of it needs client
 * state. These functions are the one place that decides how that URL is
 * written: empty values are dropped rather than sent as `?status=`, and moving
 * to another view or tab always goes back to the first page, because page 4 of
 * one view says nothing about another.
 */

export type QueryValue = string | number | null | undefined;
export type QueryParams = Record<string, QueryValue>;

/** The page parameter every paginated list uses. */
export const PAGE_PARAM = 'page';

function isEmpty(value: QueryValue): boolean {
  return value === undefined || value === null || value === '';
}

/** `?a=1&b=2`, or `''` when nothing is left once empty values are dropped. */
export function buildQueryString(params: QueryParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (isEmpty(value)) continue;
    query.set(key, String(value));
  }
  const str = query.toString();
  return str ? `?${str}` : '';
}

/** `path` with `params` applied on top of `base`; an empty override removes a key. */
export function buildHref(path: string, base: QueryParams, overrides: QueryParams = {}): string {
  return `${path}${buildQueryString({ ...base, ...overrides })}`;
}

/**
 * The link to one tab or saved view.
 *
 * The default key is written as "no parameter" rather than `?tab=default`, so
 * the plain address and the default tab are the same URL. The page parameter
 * is always dropped.
 */
export function tabHref({
  path,
  params,
  param,
  key,
  defaultKey = '',
}: {
  path: string;
  params: QueryParams;
  param: string;
  key: string;
  defaultKey?: string;
}): string {
  return buildHref(path, params, {
    [param]: key === defaultKey ? undefined : key,
    [PAGE_PARAM]: undefined,
  });
}

/** The link to one page of a list; page 1 is written without a parameter. */
export function pageHref(path: string, params: QueryParams, page: number): string {
  return buildHref(path, params, { [PAGE_PARAM]: page <= 1 ? undefined : page });
}

/**
 * A `?tab=` value, trusted only if it names a real tab. Anything else — a
 * typo, a tab that no longer exists, a tampered link — falls back to the
 * default instead of rendering an empty panel.
 */
export function resolveTab<K extends string>(
  value: string | undefined,
  keys: readonly K[],
  fallback: K,
): K {
  return value !== undefined && (keys as readonly string[]).includes(value) ? (value as K) : fallback;
}

/** A positive page number from the query, 1 for anything else. */
export function parsePage(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}
