import { isCanonicalPageShape, normalizeSeoPath } from './seo-paths';

/**
 * SEO-004 — the redirects the web serves, and the cache it serves them from.
 *
 * The API's `GET /seo/redirects/active` lists what should be served now: active
 * redirects whose target is a live page and whose source is not. This module
 * keeps that list in process memory and answers "is this path redirected?"
 * without a network call on the request path, most of the time:
 *
 *   fresh   < TTL (60 s)              served as is
 *   stale   TTL … MAX_STALE (10 min)  served while one refresh runs behind it
 *   expired ≥ MAX_STALE               dropped: nothing is redirected until a
 *                                     refresh succeeds
 *
 * A refresh that fails keeps the last good list until it expires, and is not
 * retried for {@link RETRY_AFTER_FAILURE_MS}, so an API outage costs one
 * timed-out fetch per window, not one per request. With no usable list the
 * answer is "not redirected" and the request goes on to its page — which for a
 * redirect source is the 404 it would have been anyway. Nothing here ever
 * points a visitor somewhere the API did not list, and a list older than ten
 * minutes is never used.
 *
 * Every entry is re-checked on the way in: both paths must come out of
 * `normalizeSeoPath` unchanged, the target must have the shape of a public
 * page, and the status must be 301 or 302. An entry that fails is dropped,
 * not repaired.
 */

export const REDIRECT_SNAPSHOT_TTL_MS = 60_000;
export const REDIRECT_SNAPSHOT_MAX_STALE_MS = 10 * 60_000;
export const RETRY_AFTER_FAILURE_MS = 10_000;
export const REDIRECT_SNAPSHOT_TIMEOUT_MS = 1_500;
export const REDIRECT_SNAPSHOT_PATH = '/seo/redirects/active';

export type RedirectEntry = { target: string; status: 301 | 302 };
export type RedirectTable = Map<string, RedirectEntry>;

/** The API's body as a table, or null when it is not the documented shape. */
export function parseRedirectSnapshot(body: unknown): RedirectTable | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const list = (body as Record<string, unknown>).redirects;
  if (!Array.isArray(list)) return null;
  const table: RedirectTable = new Map();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { source, target, status } = item as Record<string, unknown>;
    if (status !== 301 && status !== 302) continue;
    const from = normalizeSeoPath(source);
    const to = normalizeSeoPath(target);
    if (!from.ok || !to.ok || from.path !== source || to.path !== target) continue;
    if (from.path === '/' || from.path === to.path || !isCanonicalPageShape(to.path)) continue;
    if (!table.has(from.path)) table.set(from.path, { target: to.path, status });
  }
  return table;
}

export type RedirectResolverOptions = {
  /** Fetches the snapshot body; rejects on any failure. */
  fetchSnapshot: () => Promise<unknown>;
  now?: () => number;
};

export type RedirectResolver = {
  /** The redirect for an already-normalised path, or null. */
  resolve(path: string): Promise<RedirectEntry | null>;
};

export function createRedirectResolver(options: RedirectResolverOptions): RedirectResolver {
  const now = options.now ?? Date.now;
  let table: RedirectTable | null = null;
  let fetchedAt = 0;
  let lastFailureAt: number | null = null;
  let inflight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const parsed = parseRedirectSnapshot(await options.fetchSnapshot());
        if (!parsed) throw new Error('snapshot is not the documented shape');
        table = parsed;
        fetchedAt = now();
        lastFailureAt = null;
      } catch {
        lastFailureAt = now();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const mayRetry = () => lastFailureAt === null || now() - lastFailureAt >= RETRY_AFTER_FAILURE_MS;

  return {
    async resolve(path) {
      const age = table ? now() - fetchedAt : Infinity;
      if (table && age >= REDIRECT_SNAPSHOT_MAX_STALE_MS) {
        table = null;
      }
      if (table && age < REDIRECT_SNAPSHOT_TTL_MS) {
        return table.get(path) ?? null;
      }
      if (table) {
        // Stale but usable: answer now, refresh behind the answer.
        if (mayRetry()) void refresh();
        return table.get(path) ?? null;
      }
      if (mayRetry()) await refresh();
      // `refresh` may have set it; the narrowing above does not know that.
      const refreshed = table as RedirectTable | null;
      return refreshed?.get(path) ?? null;
    },
  };
}

/**
 * The `Location` value: an absolute URL on `origin`, ending in exactly the
 * target, or null when that cannot be built. Absolute because Next refuses a
 * relative `Location` from middleware (`TypeError: Invalid URL`, a 500).
 *
 * `origin` is the deployment's configured public origin when it names one
 * ({@link configuredWebOrigin}); the middleware falls back to the origin of
 * the request itself only when none is configured (a local stack), and then
 * forbids caching the answer — see middleware.ts.
 */
export function redirectLocation(target: string, origin: string): string | null {
  if (!/^https?:\/\/[^/?#]+$/.test(origin)) return null;
  const encoded = target
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  if (!encoded.startsWith('/') || encoded.startsWith('//')) return null;
  let url: URL;
  try {
    url = new URL(encoded, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname !== encoded || url.search || url.hash) return null;
  return url.toString();
}

const ORIGIN_VARIABLES = ['WEB_APP_URL', 'WEB_ORIGIN', 'NEXT_PUBLIC_WEB_URL'] as const;

/**
 * The deployment's own public origin, if it names a usable one (any http(s)
 * bare origin — a local stack's http://localhost:3000 is fine for a Location).
 * Read on every call, like every configuration reader here.
 */
export function configuredWebOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = ORIGIN_VARIABLES.map((name) => env[name]?.trim()).find((value) => value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/' || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
