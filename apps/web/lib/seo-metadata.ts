import { detectContactDetails } from '@taktic/shared';
import type { Metadata } from 'next';
import { canonicalPath, hasFunctionalQuery, type IndexableRoute } from './seo-routes';
import { resolveSeoSite, type SeoSite } from './seo-site';

/**
 * The `<head>` of every page, built from one function per kind of page.
 *
 * Three builders and nothing else writes `robots`, `alternates` or
 * `openGraph` in this application:
 *
 *   rootMetadata        the layout default every page inherits. Closed —
 *                       `noindex, nofollow` — so a page that never opts in
 *                       (a panel, a form, a success screen, a 404) is out of
 *                       the index whatever it renders.
 *   publicPageMetadata  the six allow-listed routes. Open only on a production
 *                       deployment with a public origin (`resolveSeoSite`) and
 *                       only on the page's clean path: a search, filter,
 *                       pagination or flow-state query makes it a variant that
 *                       is `noindex, follow` with no canonical (see
 *                       seo-routes.ts for why not both). A tracking parameter
 *                       does not.
 *   privatePageMetadata a title for a screen that is out, with the same
 *                       closed robots the layout gives it.
 *
 * Every absolute URL — canonical, `og:url`, images — comes from the resolved
 * origin and from nowhere else. On a closed site none is produced at all: a
 * canonical link to `localhost` is worse than none.
 */

/** The brand as the logo's alt text and most of the interface spell it. */
export const SEO_SITE_NAME = 'TakTick';

/** The root layout's title and description, verbatim as they were. */
export const SEO_DEFAULT_TITLE = 'TakTic — Yerel hizmet teklifleri, adil teklif kredisi';
export const SEO_DEFAULT_DESCRIPTION =
  'TakTic, yerel hizmet pazaryerinde talebinizi hizmet verenlere ulaştırır; gelen teklifleri karşılaştırarak seçim yaparsınız.';

/** The image a page passes when it has none of its own. */
export const SEO_DEFAULT_IMAGE = '/brand/logo.png';

/** Upper bounds a search result actually shows; longer is cut, not hidden. */
export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MAX = 160;

type SearchParams = Record<string, string | string[] | undefined>;

export type PublicPageInput = {
  route: IndexableRoute;
  params: Record<string, string>;
  /** A plain title gets ` · TakTick` appended; `{ absolute }` is used as is. */
  title: string | { absolute: string };
  description: string;
  /** `https://…` or a site-relative `/path`; anything else is dropped. */
  image?: string | null;
  searchParams: SearchParams;
};

export function rootMetadata(site: SeoSite = resolveSeoSite()): Metadata {
  return {
    ...(site.indexable ? { metadataBase: new URL(site.origin) } : {}),
    title: SEO_DEFAULT_TITLE,
    description: SEO_DEFAULT_DESCRIPTION,
    robots: { index: false, follow: false },
  };
}

export function publicPageMetadata(input: PublicPageInput, site: SeoSite = resolveSeoSite()): Metadata {
  const title = typeof input.title === 'string' ? `${input.title} · ${SEO_SITE_NAME}` : input.title.absolute;
  const variant = hasFunctionalQuery(input.route, input.searchParams);
  const canonical = site.indexable && !variant ? `${site.origin}${canonicalPath(input.route, input.params)}` : null;
  const image = seoImageUrl(input.image, site);

  return {
    title,
    description: input.description,
    robots: site.indexable ? { index: !variant, follow: true } : { index: false, follow: false },
    ...(canonical ? { alternates: { canonical } } : {}),
    openGraph: {
      type: 'website',
      locale: 'tr_TR',
      siteName: SEO_SITE_NAME,
      title,
      description: input.description,
      ...(canonical ? { url: canonical } : {}),
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title,
      description: input.description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export function privatePageMetadata(title?: string): Metadata {
  return {
    ...(title ? { title: `${title} · ${SEO_SITE_NAME}` } : {}),
    robots: { index: false, follow: false },
  };
}

/**
 * User-written text — a business's own description, a card's title — made
 * safe for a `<title>`, a description or a JSON-LD string.
 *
 * Markup and control characters go, whitespace collapses, and anything past
 * `max` is cut at a word boundary. A text that carries a way to reach a
 * person — a telephone number, an e-mail address, a web address — is dropped
 * entirely rather than redacted: the caller then uses its fallback, and no
 * contact detail the product keeps behind an accepted offer ends up in a
 * search snippet. Same detector the request forms refuse contact details
 * with, so the two agree on what a phone number looks like.
 */
export function seoText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;

  const plain = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;

  if (detectContactDetails(plain)) return null;

  if (plain.length <= max) return plain;

  // Room for the ellipsis, then back to the last whole word.
  const cut = plain.slice(0, max - 1);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > 0 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

/**
 * An image URL a crawler can fetch, or null. Only an `https://` URL or a
 * site-relative path qualifies, and a site-relative path needs an origin to be
 * joined to — so a closed site, which has none, yields no image at all.
 */
export function seoImageUrl(value: string | null | undefined, site: SeoSite): string | null {
  if (!value || !site.indexable) return null;

  if (value.startsWith('/') && !value.startsWith('//')) {
    return `${site.origin}${value}`;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The origin a page builds its JSON-LD against, or null when it must render
 * none: a closed site, or a variant of the page (see `hasFunctionalQuery`).
 * The same two conditions that make the robots meta say `index`.
 */
export function structuredDataOrigin(
  route: IndexableRoute,
  searchParams: SearchParams,
  site: SeoSite = resolveSeoSite(),
): string | null {
  return site.indexable && !hasFunctionalQuery(route, searchParams) ? site.origin : null;
}
