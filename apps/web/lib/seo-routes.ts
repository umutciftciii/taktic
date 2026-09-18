/**
 * Which screens a search engine may index, and which query strings turn one
 * of them into a variant it may not.
 *
 * ## An allow-list, checked against the app directory
 *
 * The root layout's default is `noindex, nofollow` for every route, and a
 * page opts in by building its metadata with `publicPageMetadata` from one
 * of the patterns below. Nothing else can be indexed, whatever it renders.
 * `test/seo-routes.spec.ts` walks every `page.tsx` and fails when a route is
 * in none of the three lists here, so a screen added later is a decision
 * somebody has to write down rather than a page a crawler decides about.
 *
 * The six routes are the public surfaces that mean something on their own: the
 * home page, the category catalogue and one category, one approved business,
 * the vitrin shelf and one live card. Everything a session or a token unlocks,
 * and every success screen, form and search result, stays out.
 *
 * ## A query string is not a new page
 *
 * `/categories?q=klima` is the catalogue filtered, `/isletme/x?cursor=…` is
 * the same business one review page later, and `/vitrin/x?step=form` is the
 * same card with its form open. None of them is a page of its own, so each
 * pattern names the parameters that make it a variant; a variant is
 * `noindex, follow` and carries no canonical link — a canonical pointing at
 * another page together with a noindex is a mixed signal Google documents as
 * one to avoid. A parameter not named here (utm_*, fbclid, gclid, anything a
 * campaign appends) does not make a variant: the page is indexable and its
 * canonical is the clean path, which folds the copies back into one.
 */

/** `:name` matches exactly one path segment, the way the app directory's `[name]` does. */
export const INDEXABLE_ROUTES = [
  '/',
  '/categories',
  '/categories/:slug',
  '/isletme/:id',
  '/vitrin',
  '/vitrin/:cardId',
] as const;

export type IndexableRoute = (typeof INDEXABLE_ROUTES)[number];

/**
 * The parameters that make each indexable route a variant. Every name a page
 * actually reads from its `searchParams` — see the page files — and no other.
 */
const FUNCTIONAL_QUERY: Record<IndexableRoute, readonly string[]> = {
  '/': [],
  '/categories': ['q'],
  '/categories/:slug': ['entry', 'r'],
  '/isletme/:id': ['cursor'],
  '/vitrin': ['il', 'ilce'],
  '/vitrin/:cardId': ['step', 'sent', 'city', 'district', 'neighborhood', 'phone'],
};

/**
 * What `robots.txt` disallows in production. Prefixes with a trailing slash
 * cover a whole subtree; the others are exact screens. `/providers/` covers the
 * provider panel and the application form and success screen alike — both are
 * noindex anyway, and the public profile lives under `/isletme/`.
 */
export const ROBOTS_DISALLOW: readonly string[] = [
  '/account/',
  '/activate-customer',
  '/api/',
  '/claim-provider',
  '/destek',
  '/e-posta-dogrula',
  '/login',
  '/mesajlar',
  '/provider-invite/',
  '/providers/',
  '/register/',
  '/requests/',
  '/sifre-sifirla',
  '/sifre-unuttum',
];

/**
 * Reachable by a crawler, indexed by none: the contact-sharing disclosure is
 * linked from every request form and has to be readable, but it is a legal
 * text rather than a landing surface. Whether it should be indexed is a
 * content decision left to SEO-002.
 */
export const NOINDEX_CRAWLABLE_ROUTES = ['/sozlesmeler/iletisim-paylasimi'] as const;

type SearchParams = Record<string, string | string[] | undefined>;

/** Whether this request's query string makes the page a variant (see above). */
export function hasFunctionalQuery(route: IndexableRoute, searchParams: SearchParams): boolean {
  return FUNCTIONAL_QUERY[route].some((name) => {
    const value = searchParams[name];
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === 'string' && value.length > 0;
  });
}

/**
 * The clean path a route is indexed under: dynamic segments filled in and
 * escaped, no query, no fragment. A segment the caller did not supply is an
 * error rather than a literal `:slug` in a canonical link.
 */
export function canonicalPath(route: IndexableRoute, params: Record<string, string>): string {
  const segments = route
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      const name = segment.slice(1);
      const value = params[name];
      if (value === undefined || value === '') {
        throw new Error(`canonicalPath(${route}): missing segment "${name}"`);
      }
      return encodeURIComponent(value);
    });
  return `/${segments.join('/')}`;
}
