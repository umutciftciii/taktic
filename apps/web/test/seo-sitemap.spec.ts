import { describe, expect, it } from 'vitest';
import { buildSitemap, type SitemapFetch } from '../lib/seo-sitemap';
import { canonicalUrl } from '../lib/seo-routes';
import type { SeoSite } from '../lib/seo-site';

const OPEN: SeoSite = { indexable: true, origin: 'https://taktick.example' };
const CLOSED: SeoSite = { indexable: false, origin: null, reason: 'ENVIRONMENT_NOT_PRODUCTION' };

/** A fake API: one path → JSON (or an error), and a log of what was asked. */
function fakeApi(response: unknown) {
  const calls: string[] = [];
  const fetch: SitemapFetch = async (path) => {
    calls.push(path);
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetch, calls };
}

const EMPTY = { categories: [], providers: [], showcaseCards: [] };
const STATIC = ['https://taktick.example', 'https://taktick.example/categories', 'https://taktick.example/vitrin'];

describe('buildSitemap', () => {
  it('is empty on a closed site and asks the API for nothing', async () => {
    const api = fakeApi(EMPTY);
    expect(await buildSitemap(CLOSED, api.fetch)).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it('asks the API exactly once, for the sitemap entries and nothing else', async () => {
    const api = fakeApi(EMPTY);
    await buildSitemap(OPEN, api.fetch);
    expect(api.calls).toEqual(['/sitemap/entries']);
  });

  it('lists the three static surfaces in the canonical form, without a made-up date', async () => {
    const entries = await buildSitemap(OPEN, fakeApi(EMPTY).fetch);
    expect(entries.map((entry) => entry.url)).toEqual(STATIC);
    for (const entry of entries) expect(entry).not.toHaveProperty('lastModified');
  });

  it('lists every row the API names, escaped, with its real updatedAt where one is sent', async () => {
    const entries = await buildSitemap(
      OPEN,
      fakeApi({
        categories: [
          { slug: 'klima-bakimi', updatedAt: '2026-09-01T10:00:00.000Z' },
          { slug: 'weird slug/x', updatedAt: '2026-09-02T10:00:00.000Z' },
          { slug: 'no-date' },
        ],
        providers: [
          { id: 'p1', updatedAt: '2026-09-03T00:00:00.000Z' },
          { id: 'p 2', updatedAt: 'not a date' },
        ],
        showcaseCards: [{ cardId: 'c1' }, { cardId: 'c2' }],
      }).fetch,
    );
    expect(entries.slice(3)).toEqual([
      { url: 'https://taktick.example/categories/klima-bakimi', lastModified: new Date('2026-09-01T10:00:00.000Z') },
      { url: 'https://taktick.example/categories/weird%20slug%2Fx', lastModified: new Date('2026-09-02T10:00:00.000Z') },
      { url: 'https://taktick.example/categories/no-date' },
      { url: 'https://taktick.example/isletme/p1', lastModified: new Date('2026-09-03T00:00:00.000Z') },
      { url: 'https://taktick.example/isletme/p%202' },
      { url: 'https://taktick.example/vitrin/c1' },
      { url: 'https://taktick.example/vitrin/c2' },
    ]);
  });

  it('prints each row in exactly the form the page prints as its canonical', async () => {
    const entries = await buildSitemap(
      OPEN,
      fakeApi({
        categories: [{ slug: 'klima' }],
        providers: [{ id: 'p1' }],
        showcaseCards: [{ cardId: 'c1' }],
      }).fetch,
    );
    expect(entries.map((entry) => entry.url)).toEqual([
      canonicalUrl(OPEN.origin, '/', {}),
      canonicalUrl(OPEN.origin, '/categories', {}),
      canonicalUrl(OPEN.origin, '/vitrin', {}),
      canonicalUrl(OPEN.origin, '/categories/:slug', { slug: 'klima' }),
      canonicalUrl(OPEN.origin, '/isletme/:id', { id: 'p1' }),
      canonicalUrl(OPEN.origin, '/vitrin/:cardId', { cardId: 'c1' }),
    ]);
  });

  it('lists a record once however many times the API repeats it', async () => {
    const entries = await buildSitemap(
      OPEN,
      fakeApi({
        categories: [{ slug: 'a' }, { slug: 'a' }],
        providers: [{ id: 'p' }, { id: 'p' }],
        showcaseCards: [{ cardId: 'c' }, { cardId: 'c' }],
      }).fetch,
    );
    expect(entries.map((entry) => entry.url)).toEqual([
      ...STATIC,
      'https://taktick.example/categories/a',
      'https://taktick.example/isletme/p',
      'https://taktick.example/vitrin/c',
    ]);
  });

  it('fails closed: on an API error only the static surfaces are listed', async () => {
    const entries = await buildSitemap(OPEN, fakeApi(new Error('boom')).fetch);
    expect(entries.map((entry) => entry.url)).toEqual(STATIC);
  });

  it.each([null, 'text', [], { categories: 'x' }, { providers: [{}], showcaseCards: [{ cardId: '' }], categories: [null, { slug: '' }] }])(
    'fails closed on a body it does not recognise (%j): static surfaces only',
    async (body) => {
      const entries = await buildSitemap(OPEN, fakeApi(body).fetch);
      expect(entries.map((entry) => entry.url)).toEqual(STATIC);
    },
  );

  it('never adds a query string, a trailing slash, a panel path or a paginated URL', async () => {
    const entries = await buildSitemap(
      OPEN,
      fakeApi({ categories: [{ slug: 'a' }], providers: [{ id: 'p' }], showcaseCards: [{ cardId: 'c' }] }).fetch,
    );
    for (const { url } of entries) {
      expect(url).not.toMatch(/[?#]/);
      expect(url).not.toMatch(/\/$/);
      expect(url).not.toMatch(/\/(providers|requests|account|login|register|api)\//);
      expect(url.startsWith('https://taktick.example')).toBe(true);
    }
  });
});
