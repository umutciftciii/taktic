import { describe, expect, it } from 'vitest';
import {
  SEO_SITE_NAME,
  privatePageMetadata,
  publicPageMetadata,
  rootMetadata,
  seoImageUrl,
  seoText,
} from '../lib/seo-metadata';
import type { SeoSite } from '../lib/seo-site';

const OPEN: SeoSite = { indexable: true, origin: 'https://taktick.example' };
const CLOSED: SeoSite = { indexable: false, origin: null, reason: 'ENVIRONMENT_NOT_PRODUCTION' };

describe('seoText — user-written text made safe for a <head>', () => {
  it('strips markup, control characters and runs of whitespace', () => {
    expect(seoText('Klima <b>bakımı</b>\n\n ve\t\tmontaj\u0000', 160)).toBe('Klima bakımı ve montaj');
  });

  it('cuts at a word boundary with an ellipsis', () => {
    const long = 'kelime '.repeat(50).trim();
    const cut = seoText(long, 40);
    expect(cut!.length).toBeLessThanOrEqual(40);
    expect(cut).toMatch(/^kelime( kelime)*…$/);
  });

  it('returns null for empty, whitespace-only or markup-only input', () => {
    expect(seoText('', 160)).toBeNull();
    expect(seoText('   ', 160)).toBeNull();
    expect(seoText('<p></p>', 160)).toBeNull();
    expect(seoText(null, 160)).toBeNull();
    expect(seoText(undefined, 160)).toBeNull();
  });

  it('drops the whole text when it carries a phone number, e-mail or URL', () => {
    expect(seoText('Bizi arayın 0532 123 45 67', 160)).toBeNull();
    expect(seoText('Yazın: usta@example.com', 160)).toBeNull();
    expect(seoText('Sitemiz www.usta-klima.com', 160)).toBeNull();
  });
});

describe('seoImageUrl — only an image that can be addressed', () => {
  it('keeps an https image and resolves a site-relative one against the origin', () => {
    expect(seoImageUrl('https://cdn.example/a.png', OPEN)).toBe('https://cdn.example/a.png');
    expect(seoImageUrl('/brand/logo.png', OPEN)).toBe('https://taktick.example/brand/logo.png');
  });

  it('refuses http, data:, protocol-relative and malformed values', () => {
    expect(seoImageUrl('http://cdn.example/a.png', OPEN)).toBeNull();
    expect(seoImageUrl('data:image/png;base64,AAAA', OPEN)).toBeNull();
    expect(seoImageUrl('//cdn.example/a.png', OPEN)).toBeNull();
    expect(seoImageUrl('cat.png', OPEN)).toBeNull();
    expect(seoImageUrl(null, OPEN)).toBeNull();
  });

  it('never produces an absolute image URL on a closed site', () => {
    expect(seoImageUrl('/brand/logo.png', CLOSED)).toBeNull();
    expect(seoImageUrl('https://cdn.example/a.png', CLOSED)).toBeNull();
  });
});

describe('publicPageMetadata — an indexable page', () => {
  const page = {
    route: '/categories/:slug' as const,
    params: { slug: 'klima-bakimi' },
    title: 'Klima bakımı',
    description: 'Klima bakımı için teklif alın.',
    image: '/categories/cat-klima.png',
    // The API's answer for the record behind the page; every case below is
    // about an eligible one unless it says otherwise.
    indexEligible: true,
  };

  it('in production, on the clean path: index, canonical, and OG/Twitter on the same URL', () => {
    const metadata = publicPageMetadata({ ...page, searchParams: {} }, OPEN);
    expect(metadata.title).toBe(`Klima bakımı · ${SEO_SITE_NAME}`);
    expect(metadata.description).toBe('Klima bakımı için teklif alın.');
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates).toEqual({ canonical: 'https://taktick.example/categories/klima-bakimi' });
    expect(metadata.openGraph).toMatchObject({
      type: 'website',
      locale: 'tr_TR',
      siteName: SEO_SITE_NAME,
      url: 'https://taktick.example/categories/klima-bakimi',
      title: `Klima bakımı · ${SEO_SITE_NAME}`,
      description: 'Klima bakımı için teklif alın.',
      images: [{ url: 'https://taktick.example/categories/cat-klima.png' }],
    });
    expect(metadata.twitter).toMatchObject({
      card: 'summary_large_image',
      title: `Klima bakımı · ${SEO_SITE_NAME}`,
      description: 'Klima bakımı için teklif alın.',
      images: ['https://taktick.example/categories/cat-klima.png'],
    });
  });

  it('with a tracking parameter: still indexed, canonical still the clean path', () => {
    const metadata = publicPageMetadata({ ...page, searchParams: { utm_source: 'x', gclid: 'y' } }, OPEN);
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates).toEqual({ canonical: 'https://taktick.example/categories/klima-bakimi' });
  });

  it('with a functional parameter: noindex, follow, and no canonical at all', () => {
    const metadata = publicPageMetadata({ ...page, searchParams: { entry: 'klima' } }, OPEN);
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).not.toHaveProperty('url');
    expect(metadata.title).toBe(`Klima bakımı · ${SEO_SITE_NAME}`);
  });

  it('for a record the API did not vouch for: noindex, follow, and no canonical, og:url or image URL claim', () => {
    // A public page whose record is not index-eligible (SEO-003) reads like a
    // variant: reachable and crawlable, not indexed, and pointing nowhere.
    const metadata = publicPageMetadata({ ...page, searchParams: {}, indexEligible: false }, OPEN);
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).not.toHaveProperty('url');
    expect(metadata.title).toBe(`Klima bakımı · ${SEO_SITE_NAME}`);
    // A tracking parameter does not change that, and a functional one cannot open it.
    expect(publicPageMetadata({ ...page, searchParams: { utm_source: 'x' }, indexEligible: false }, OPEN).robots).toEqual({ index: false, follow: true });
    expect(publicPageMetadata({ ...page, searchParams: { entry: 'x' }, indexEligible: false }, OPEN).alternates).toBeUndefined();
    // Only a literal `true` opens the page: an absent or malformed answer is closed.
    for (const value of [undefined, null, 'true', 1] as unknown[]) {
      const closed = publicPageMetadata({ ...page, searchParams: {}, indexEligible: value as boolean }, OPEN);
      expect(closed.robots, String(value)).toEqual({ index: false, follow: true });
      expect(closed.alternates, String(value)).toBeUndefined();
    }
  });

  it('on a closed site: noindex, nofollow, no canonical, no absolute URL anywhere', () => {
    const metadata = publicPageMetadata({ ...page, searchParams: {} }, CLOSED);
    expect(metadata.robots).toEqual({ index: false, follow: false });
    // Eligibility cannot open a closed site either way.
    expect(publicPageMetadata({ ...page, searchParams: {}, indexEligible: false }, CLOSED).robots).toEqual({ index: false, follow: false });
    expect(metadata.alternates).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toMatch(/https?:\/\//);
    expect(metadata.title).toBe(`Klima bakımı · ${SEO_SITE_NAME}`);
    expect(metadata.openGraph).toMatchObject({ title: `Klima bakımı · ${SEO_SITE_NAME}` });
    expect(metadata.openGraph).not.toHaveProperty('images');
    expect(metadata.twitter).toMatchObject({ card: 'summary' });
  });

  it('with no image: a summary card and no images key', () => {
    const metadata = publicPageMetadata({ ...page, image: null, searchParams: {} }, OPEN);
    expect(metadata.openGraph).not.toHaveProperty('images');
    expect(metadata.twitter).toMatchObject({ card: 'summary' });
  });

  it('takes an absolute title for the home page rather than appending the site name', () => {
    const metadata = publicPageMetadata(
      { route: '/', params: {}, title: { absolute: 'TakTic — ana' }, description: 'd', searchParams: {}, indexEligible: true },
      OPEN,
    );
    expect(metadata.title).toBe('TakTic — ana');
    // The root is the bare origin: the same string the sitemap and the JSON-LD print.
    expect(metadata.alternates).toEqual({ canonical: 'https://taktick.example' });
    expect(metadata.openGraph).toMatchObject({ title: 'TakTic — ana', url: 'https://taktick.example' });
  });

  it('escapes the dynamic segment in the canonical', () => {
    const metadata = publicPageMetadata(
      { route: '/isletme/:id', params: { id: 'a b' }, title: 't', description: 'd', searchParams: {}, indexEligible: true },
      OPEN,
    );
    expect(metadata.alternates).toEqual({ canonical: 'https://taktick.example/isletme/a%20b' });
  });
});

describe('privatePageMetadata — everything that is not on the allow-list', () => {
  it('is noindex, nofollow, whatever the environment', () => {
    expect(privatePageMetadata('Giriş yap')).toEqual({
      title: `Giriş yap · ${SEO_SITE_NAME}`,
      robots: { index: false, follow: false },
    });
    expect(privatePageMetadata()).toEqual({ robots: { index: false, follow: false } });
  });
});

describe('rootMetadata — the layout default every page inherits', () => {
  it('is closed by default, with a metadataBase only on an open site', () => {
    const open = rootMetadata(OPEN);
    expect(open.robots).toEqual({ index: false, follow: false });
    expect(open.metadataBase?.toString()).toBe('https://taktick.example/');

    const closed = rootMetadata(CLOSED);
    expect(closed.robots).toEqual({ index: false, follow: false });
    expect(closed.metadataBase).toBeUndefined();
  });

  it('keeps the existing default title and description verbatim', () => {
    const metadata = rootMetadata(CLOSED);
    expect(metadata.title).toBe('TakTic — Yerel hizmet teklifleri, adil teklif kredisi');
    expect(metadata.description).toBe(
      'TakTic, yerel hizmet pazaryerinde talebinizi hizmet verenlere ulaştırır; gelen teklifleri karşılaştırarak seçim yaparsınız.',
    );
  });
});

describe('structuredDataOrigin — where a page may render JSON-LD', () => {
  it('is the origin only on an open site, a clean path and an index-eligible record', async () => {
    const { structuredDataOrigin } = await import('../lib/seo-metadata');
    expect(structuredDataOrigin('/categories', {}, true, OPEN)).toBe('https://taktick.example');
    expect(structuredDataOrigin('/categories', { utm_source: 'x' }, true, OPEN)).toBe('https://taktick.example');
    expect(structuredDataOrigin('/categories', { q: 'x' }, true, OPEN)).toBeNull();
    expect(structuredDataOrigin('/categories', {}, true, CLOSED)).toBeNull();
    // The same third condition the robots meta and the canonical follow.
    expect(structuredDataOrigin('/isletme/:id', {}, false, OPEN)).toBeNull();
    expect(structuredDataOrigin('/isletme/:id', {}, undefined as unknown as boolean, OPEN)).toBeNull();
  });
});
