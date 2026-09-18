import { canonicalPath } from './seo-routes';
import type { SeoSite } from './seo-site';

/**
 * What `sitemap.xml` lists: the six allow-listed routes, filled in from the
 * same public API answers the pages themselves render from.
 *
 * ## Only URLs that answer 200
 *
 *   /categories/<slug>   from `GET /categories` — the public listing, which
 *                        is ACTIVE leaves only, a strict subset of what the
 *                        detail page serves (isPubliclyListable ⊂
 *                        isPubliclyReachable in the API's taxonomy rules)
 *   /isletme/<id>        from `GET /providers/public-directory` — approved
 *                        profiles, the one status the public page renders
 *   /vitrin/<cardId>     from `GET /showcase/feed`, walked to the end — the
 *                        same predicate `GET /showcase/cards/:id` answers a
 *                        card with, so a listed card is a card that is served
 *
 * No row is invented, no query string is added, and no date is made up:
 * `lastModified` is the row's own `updatedAt` where the API sends one, and
 * absent where it does not (the static surfaces, a feed card).
 *
 * ## Never a 500
 *
 * A source that fails is skipped and the rest is listed; a sitemap with the
 * categories and no businesses is a sitemap, and a crawler that gets a 500
 * instead may drop the whole file. The caller decides how the fetch is done —
 * without the visitor's cookies, see app/sitemap.ts — and this module only
 * reads what comes back.
 */

/** Same shape as one entry of Next's `MetadataRoute.Sitemap`. */
export type SitemapEntry = { url: string; lastModified?: Date };

export type SitemapFetch = (path: string) => Promise<unknown>;

/** The feed's own page ceiling (SHOWCASE_FEED_MAX_LIMIT on the API). */
const FEED_PAGE_SIZE = 48;

/** Enough for any realistic number of live placements; a runaway cursor stops here. */
const FEED_MAX_PAGES = 200;

export async function buildSitemap(site: SeoSite, fetchJson: SitemapFetch): Promise<SitemapEntry[]> {
  if (!site.indexable) {
    return [];
  }

  const origin = site.origin;
  const entries: SitemapEntry[] = [
    { url: `${origin}/` },
    { url: `${origin}/categories` },
    { url: `${origin}/vitrin` },
  ];

  const [categories, providers, cards] = await Promise.all([
    attempt(() => listCategories(fetchJson)),
    attempt(() => listProviders(fetchJson)),
    attempt(() => listCards(fetchJson)),
  ]);

  for (const category of categories) {
    entries.push(entry(origin, canonicalPath('/categories/:slug', { slug: category.slug }), category.updatedAt));
  }
  for (const provider of providers) {
    entries.push(entry(origin, canonicalPath('/isletme/:id', { id: provider.id }), provider.updatedAt));
  }
  for (const card of cards) {
    entries.push(entry(origin, canonicalPath('/vitrin/:cardId', { cardId: card.cardId })));
  }

  return entries;
}

function entry(origin: string, path: string, updatedAt?: string): SitemapEntry {
  const lastModified = updatedAt ? new Date(updatedAt) : null;
  return {
    url: `${origin}${path}`,
    ...(lastModified && !Number.isNaN(lastModified.getTime()) ? { lastModified } : {}),
  };
}

async function attempt<T>(load: () => Promise<T[]>): Promise<T[]> {
  try {
    return await load();
  } catch {
    return [];
  }
}

async function listCategories(fetchJson: SitemapFetch): Promise<{ slug: string; updatedAt?: string }[]> {
  const rows = await fetchJson('/categories');
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const slug = stringField(row, 'slug');
    return slug ? [{ slug, updatedAt: stringField(row, 'updatedAt') ?? undefined }] : [];
  });
}

async function listProviders(fetchJson: SitemapFetch): Promise<{ id: string; updatedAt?: string }[]> {
  const body = await fetchJson('/providers/public-directory');
  const rows = body && typeof body === 'object' ? (body as { providers?: unknown }).providers : null;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const id = stringField(row, 'id');
    return id ? [{ id, updatedAt: stringField(row, 'updatedAt') ?? undefined }] : [];
  });
}

async function listCards(fetchJson: SitemapFetch): Promise<{ cardId: string }[]> {
  const found: { cardId: string }[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < FEED_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(FEED_PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    const body = await fetchJson(`/showcase/feed?${query.toString()}`);
    const feed = body && typeof body === 'object' ? (body as { cards?: unknown; nextCursor?: unknown }) : null;
    const cards = Array.isArray(feed?.cards) ? feed.cards : [];

    for (const card of cards) {
      const cardId = stringField(card, 'cardId');
      if (cardId && !found.some((known) => known.cardId === cardId)) found.push({ cardId });
    }

    const next = typeof feed?.nextCursor === 'string' && feed.nextCursor ? feed.nextCursor : null;
    // A cursor that comes back unchanged is a feed that will never end.
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }

  return found;
}

function stringField(row: unknown, name: string): string | null {
  if (!row || typeof row !== 'object') return null;
  const value = (row as Record<string, unknown>)[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
