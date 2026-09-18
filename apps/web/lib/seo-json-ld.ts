import { SEO_DESCRIPTION_MAX, SEO_SITE_NAME, SEO_TITLE_MAX, seoText } from './seo-metadata';
import { absoluteUrl, canonicalUrl } from './seo-routes';

/**
 * The structured data the indexable pages carry, and how it is put into a
 * `<script>` without becoming one.
 *
 * ## Only what the repository can vouch for
 *
 * Every schema here states facts a row in this database actually holds: a
 * business's name and the province and district it is based in, a category's
 * name, a card's title and summary. What none of them states, on purpose:
 *
 *   aggregateRating / review   the public rating is gated behind a minimum
 *                              count and a feature switch (provider-reviews),
 *                              and a rating a crawler caches is a rating the
 *                              product can no longer withdraw
 *   offers / price             a card's listed price is the business's own
 *                              figure, uncollected and unverified by the
 *                              platform
 *   areaServed                 a service area is a promise the server checks
 *                              per lead, not a fact a crawler should repeat
 *   telephone / email          contact opens through an accepted offer and
 *                              nowhere else
 *
 * `test/seo-json-ld.spec.ts` walks every schema for those keys.
 *
 * ## The serializer
 *
 * `JSON.stringify` alone is not safe inside `<script>`: a string containing
 * `</script>` closes the element, and the parser does not care that it was
 * inside a JSON string. The characters that can start or end markup are
 * written as JSON `\u` escapes, which the JSON parser turns back into the same
 * characters and the HTML parser never sees. U+2028/2029 are escaped because
 * they are line terminators in JavaScript source but not in JSON.
 */

export type JsonLd = Record<string, unknown>;

export function serializeJsonLd(data: JsonLd): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const CONTEXT = 'https://schema.org';

/** Every URL below goes through `absoluteUrl`, so it is the canonical's bytes. */
function organizationRef(origin: string) {
  return { '@type': 'Organization', name: SEO_SITE_NAME, url: absoluteUrl(origin, '/') };
}

export function organizationSchema(origin: string): JsonLd {
  return {
    '@context': CONTEXT,
    ...organizationRef(origin),
    logo: absoluteUrl(origin, '/brand/logo.png'),
  };
}

export function webSiteSchema(origin: string): JsonLd {
  return { '@context': CONTEXT, '@type': 'WebSite', name: SEO_SITE_NAME, url: absoluteUrl(origin, '/') };
}

export type BreadcrumbItem = { name: string; path?: string };

export function breadcrumbSchema(origin: string, items: BreadcrumbItem[]): JsonLd {
  return {
    '@context': CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      ...(item.path ? { item: absoluteUrl(origin, item.path) } : {}),
    })),
  };
}

export function categoryServiceSchema(
  origin: string,
  category: { name: string; slug: string; description: string | null | undefined },
): JsonLd {
  const description = seoText(category.description, SEO_DESCRIPTION_MAX);
  return {
    '@context': CONTEXT,
    '@type': 'Service',
    name: category.name,
    serviceType: category.name,
    url: canonicalUrl(origin, '/categories/:slug', { slug: category.slug }),
    ...(description ? { description } : {}),
    provider: organizationRef(origin),
  };
}

type ProviderFacts = {
  id: string;
  businessName: string;
  city: string;
  district: string;
};

/** The business's base: province and, when it names one, district. Turkey throughout. */
function postalAddress(provider: Pick<ProviderFacts, 'city' | 'district'>) {
  const district = seoText(provider.district, SEO_TITLE_MAX);
  return {
    '@type': 'PostalAddress',
    ...(district ? { addressLocality: district } : {}),
    addressRegion: seoText(provider.city, SEO_TITLE_MAX) ?? provider.city,
    addressCountry: 'TR',
  };
}

function localBusinessRef(origin: string, provider: ProviderFacts) {
  return {
    '@type': 'LocalBusiness',
    name: seoText(provider.businessName, SEO_TITLE_MAX) ?? provider.businessName,
    url: canonicalUrl(origin, '/isletme/:id', { id: provider.id }),
    address: postalAddress(provider),
  };
}

export function providerLocalBusinessSchema(
  origin: string,
  provider: ProviderFacts & { description: string | null | undefined },
): JsonLd & { address: unknown } {
  const description = seoText(provider.description, SEO_DESCRIPTION_MAX);
  return {
    '@context': CONTEXT,
    ...localBusinessRef(origin, provider),
    ...(description ? { description } : {}),
  };
}

/**
 * Takes the feed card as the API hands it; the price, the area label and the
 * review summary it may also carry are deliberately never read.
 */
export function showcaseServiceSchema(
  origin: string,
  card: {
    cardId: string;
    title: string;
    summary: string;
    category: { name: string };
    provider: ProviderFacts;
  },
): JsonLd {
  const description = seoText(card.summary, SEO_DESCRIPTION_MAX);
  return {
    '@context': CONTEXT,
    '@type': 'Service',
    name: seoText(card.title, SEO_TITLE_MAX) ?? card.provider.businessName,
    serviceType: card.category.name,
    url: canonicalUrl(origin, '/vitrin/:cardId', { cardId: card.cardId }),
    ...(description ? { description } : {}),
    provider: localBusinessRef(origin, card.provider),
  };
}
