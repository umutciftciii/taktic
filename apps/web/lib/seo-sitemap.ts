import { canonicalUrl } from './seo-routes';
import type { SeoSite } from './seo-site';

/**
 * What `sitemap.xml` lists: the six allow-listed routes — `/` and
 * `/categories` by name, `/vitrin` when the API says the shelf is indexable,
 * and the three dynamic ones — filled in from one API answer.
 *
 * ## One request, one source
 *
 * `GET /sitemap/entries` is the API's own statement of which public records
 * exist right now — category slugs, approved business ids, the ids of cards
 * on the air — each decided by the visibility rule the corresponding page
 * applies (the API's `SitemapService` reads the same three rules). It carries
 * identifiers and `updatedAt` only, so nothing here has to know what a
 * business or a card is; and it is one round trip whatever the counts, so
 * there is no page to walk and no cursor to stop.
 *
 * ## Every row is the page's own canonical
 *
 * Each URL is built by `canonicalUrl`, the function the page's
 * `<link rel="canonical">` is built by, so the sitemap row and the page agree
 * byte for byte. No date is invented: `lastModified` is the row's `updatedAt`
 * where the API sent one, and absent otherwise.
 *
 * ## Fails closed
 *
 * An API that errors, or a body this module does not recognise, yields the
 * two static rows and nothing else (not `/vitrin`, whose indexability is the
 * API's answer): a page that could not be confirmed
 * public is not listed. A row without the field it needs is skipped, and a
 * record the API happens to repeat is listed once.
 */

/** Same shape as one entry of Next's `MetadataRoute.Sitemap`. */
export type SitemapEntry = { url: string; lastModified?: Date };

export type SitemapFetch = (path: string) => Promise<unknown>;

export const SITEMAP_ENTRIES_PATH = '/sitemap/entries';

export async function buildSitemap(site: SeoSite, fetchJson: SitemapFetch): Promise<SitemapEntry[]> {
  if (!site.indexable) {
    return [];
  }

  const origin = site.origin;
  const entries: SitemapEntry[] = [
    { url: canonicalUrl(origin, '/', {}) },
    { url: canonicalUrl(origin, '/categories', {}) },
  ];

  const body = await readEntries(fetchJson);
  if (!body) {
    return entries;
  }

  // SEO-004: `/vitrin` is listed only when the API says the shelf itself is
  // indexable — the same rule its own `<head>` reads. It used to be listed
  // unconditionally, beside a page that said `noindex`. Absent or anything
  // but a literal `true` keeps it out (fail closed).
  if (body.showcaseShelfIndexable) {
    entries.push({ url: canonicalUrl(origin, '/vitrin', {}) });
  }

  const seen = new Set<string>();
  const add = (url: string, updatedAt: string | null) => {
    if (seen.has(url)) return;
    seen.add(url);
    const lastModified = updatedAt ? new Date(updatedAt) : null;
    entries.push({
      url,
      ...(lastModified && !Number.isNaN(lastModified.getTime()) ? { lastModified } : {}),
    });
  };

  for (const row of body.categories) {
    const slug = stringField(row, 'slug');
    if (slug) add(canonicalUrl(origin, '/categories/:slug', { slug }), stringField(row, 'updatedAt'));
  }
  for (const row of body.providers) {
    const id = stringField(row, 'id');
    if (id) add(canonicalUrl(origin, '/isletme/:id', { id }), stringField(row, 'updatedAt'));
  }
  for (const row of body.showcaseCards) {
    const cardId = stringField(row, 'cardId');
    if (cardId) add(canonicalUrl(origin, '/vitrin/:cardId', { cardId }), null);
  }

  return entries;
}

type EntriesBody = {
  categories: unknown[];
  providers: unknown[];
  showcaseCards: unknown[];
  showcaseShelfIndexable: boolean;
};

/** The API's answer, or null for an error or a body of any other shape. */
async function readEntries(fetchJson: SitemapFetch): Promise<EntriesBody | null> {
  let body: unknown;
  try {
    body = await fetchJson(SITEMAP_ENTRIES_PATH);
  } catch {
    return null;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { categories, providers, showcaseCards, showcaseShelf } = body as Record<string, unknown>;
  if (!Array.isArray(categories) || !Array.isArray(providers) || !Array.isArray(showcaseCards)) return null;
  const showcaseShelfIndexable =
    typeof showcaseShelf === 'object' &&
    showcaseShelf !== null &&
    (showcaseShelf as Record<string, unknown>).indexable === true;
  return { categories, providers, showcaseCards, showcaseShelfIndexable };
}

function stringField(row: unknown, name: string): string | null {
  if (!row || typeof row !== 'object') return null;
  const value = (row as Record<string, unknown>)[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
