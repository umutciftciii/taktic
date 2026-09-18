import { describe, expect, it } from 'vitest';
import {
  breadcrumbSchema,
  categoryServiceSchema,
  organizationSchema,
  providerLocalBusinessSchema,
  serializeJsonLd,
  showcaseServiceSchema,
  webSiteSchema,
} from '../lib/seo-json-ld';

const ORIGIN = 'https://taktick.example';

/** Every key that would state something this product does not guarantee. */
const FORBIDDEN_KEYS = [
  'aggregateRating',
  'review',
  'reviews',
  'ratingValue',
  'reviewCount',
  'offers',
  'price',
  'priceRange',
  'priceCurrency',
  'availability',
  'areaServed',
  'telephone',
  'email',
  'faxNumber',
  'openingHours',
  'geo',
];

function keysOf(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      found.push(key);
      keysOf(inner, found);
    }
  }
  return found;
}

describe('serializeJsonLd — safe inside a <script>', () => {
  it('escapes the characters that could close the script or start a tag', () => {
    const out = serializeJsonLd({ name: '</script><img src=x onerror=alert(1)>&\u2028\u2029' });
    expect(out).not.toContain('</script');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('&');
    expect(out).not.toContain('\u2028');
    expect(out).not.toContain('\u2029');
    expect(JSON.parse(out)).toEqual({ name: '</script><img src=x onerror=alert(1)>&\u2028\u2029' });
  });

  it('round-trips a plain object and pretty-prints nothing', () => {
    expect(serializeJsonLd({ '@type': 'Thing', name: 'a' })).toBe('{"@type":"Thing","name":"a"}');
  });
});

describe('the schemas carry only what the repository can vouch for', () => {
  it('Organization: name, url and logo — no contact point, no address', () => {
    const schema = organizationSchema(ORIGIN);
    expect(schema).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'TakTick',
      url: `${ORIGIN}/`,
      logo: `${ORIGIN}/brand/logo.png`,
    });
  });

  it('WebSite: name and url, no SearchAction (the search page is noindex)', () => {
    expect(webSiteSchema(ORIGIN)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'TakTick',
      url: `${ORIGIN}/`,
    });
  });

  it('BreadcrumbList: positions and absolute urls', () => {
    expect(breadcrumbSchema(ORIGIN, [{ name: 'Ana sayfa', path: '/' }, { name: 'Kategoriler', path: '/categories' }, { name: 'Klima' }])).toEqual({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Ana sayfa', item: `${ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: 'Kategoriler', item: `${ORIGIN}/categories` },
        { '@type': 'ListItem', position: 3, name: 'Klima' },
      ],
    });
  });

  it('Service for a category: name, url, provider organization; description only when there is one', () => {
    const withText = categoryServiceSchema(ORIGIN, { name: 'Klima bakımı', slug: 'klima', description: 'Yıllık bakım.' });
    expect(withText).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Service',
      name: 'Klima bakımı',
      serviceType: 'Klima bakımı',
      url: `${ORIGIN}/categories/klima`,
      description: 'Yıllık bakım.',
      provider: { '@type': 'Organization', name: 'TakTick', url: `${ORIGIN}/` },
    });
    const without = categoryServiceSchema(ORIGIN, { name: 'Klima bakımı', slug: 'klima', description: null });
    expect(without).not.toHaveProperty('description');
  });

  it('LocalBusiness for an approved provider: name, url, base address — nothing that reaches a person', () => {
    const schema = providerLocalBusinessSchema(ORIGIN, {
      id: 'p1',
      businessName: 'Usta <b>Klima</b>',
      city: 'İstanbul',
      district: 'Kadıköy',
      description: 'Arayın 0532 123 45 67',
    });
    expect(schema).toEqual({
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: 'Usta Klima',
      url: `${ORIGIN}/isletme/p1`,
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'Kadıköy',
        addressRegion: 'İstanbul',
        addressCountry: 'TR',
      },
    });
    // The description carried a phone number, so it is absent rather than redacted.
    expect(schema).not.toHaveProperty('description');
    expect(keysOf(schema)).not.toEqual(expect.arrayContaining(FORBIDDEN_KEYS));
  });

  it('LocalBusiness with an empty district names only the province', () => {
    const schema = providerLocalBusinessSchema(ORIGIN, {
      id: 'p1',
      businessName: 'Usta',
      city: 'İstanbul',
      district: '',
      description: null,
    });
    expect(schema.address).toEqual({ '@type': 'PostalAddress', addressRegion: 'İstanbul', addressCountry: 'TR' });
  });

  it('Service for a vitrin card: title, summary, the business behind it — no price, no area', () => {
    // The feed card carries a price and an area label too; both must be ignored.
    const card = {
      cardId: 'c1',
      title: 'Klima montajı 1.500 ₺',
      summary: 'Split klima montajı.',
      category: { name: 'Klima' },
      provider: { id: 'p1', businessName: 'Usta Klima', city: 'İstanbul', district: 'Kadıköy' },
      listedServicePriceAmount: 1500,
      areaLabel: 'Kadıköy, İstanbul',
    };
    const schema = showcaseServiceSchema(ORIGIN, card);
    expect(schema).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Service',
      name: 'Klima montajı 1.500 ₺',
      serviceType: 'Klima',
      url: `${ORIGIN}/vitrin/c1`,
      description: 'Split klima montajı.',
      provider: {
        '@type': 'LocalBusiness',
        name: 'Usta Klima',
        url: `${ORIGIN}/isletme/p1`,
        address: { '@type': 'PostalAddress', addressLocality: 'Kadıköy', addressRegion: 'İstanbul', addressCountry: 'TR' },
      },
    });
    const keys = keysOf(schema);
    for (const key of FORBIDDEN_KEYS) expect(keys, key).not.toContain(key);
  });

  it('no schema ever carries a forbidden key', () => {
    const all = [
      organizationSchema(ORIGIN),
      webSiteSchema(ORIGIN),
      categoryServiceSchema(ORIGIN, { name: 'a', slug: 'a', description: 'b' }),
      providerLocalBusinessSchema(ORIGIN, { id: 'p', businessName: 'b', city: 'c', district: 'd', description: 'e' }),
      showcaseServiceSchema(ORIGIN, {
        cardId: 'c',
        title: 't',
        summary: 's',
        category: { name: 'k' },
        provider: { id: 'p', businessName: 'b', city: 'c', district: 'd' },
      }),
    ];
    const keys = keysOf(all);
    for (const key of FORBIDDEN_KEYS) expect(keys, key).not.toContain(key);
  });
});
