import { describe, expect, it } from 'vitest';
import { buildSitemap, type SitemapFetch } from '../lib/seo-sitemap';
import type { SeoSite } from '../lib/seo-site';

const OPEN: SeoSite = { indexable: true, origin: 'https://taktick.example' };
const CLOSED: SeoSite = { indexable: false, origin: null, reason: 'ENVIRONMENT_NOT_PRODUCTION' };

/** A fake API: paths → JSON, and a log of what was asked. */
function fakeApi(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const fetch: SitemapFetch = async (path) => {
    calls.push(path);
    if (!(path in responses)) throw new Error(`unexpected ${path}`);
    const value = responses[path];
    if (value instanceof Error) throw value;
    return value;
  };
  return { fetch, calls };
}

const STATIC = ['https://taktick.example/', 'https://taktick.example/categories', 'https://taktick.example/vitrin'];

describe('buildSitemap', () => {
  it('is empty on a closed site and asks the API for nothing', async () => {
    const api = fakeApi({});
    expect(await buildSitemap(CLOSED, api.fetch)).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it('lists the three static surfaces without a made-up date', async () => {
    const api = fakeApi({
      '/categories': [],
      '/providers/public-directory': { providers: [] },
      '/showcase/feed?limit=48': { cards: [], nextCursor: null },
    });
    const entries = await buildSitemap(OPEN, api.fetch);
    expect(entries.map((entry) => entry.url)).toEqual(STATIC);
    for (const entry of entries) expect(entry).not.toHaveProperty('lastModified');
  });

  it('lists every public category with its real updatedAt, slug escaped', async () => {
    const api = fakeApi({
      '/categories': [
        { slug: 'klima-bakimi', updatedAt: '2026-09-01T10:00:00.000Z' },
        { slug: 'weird slug/x', updatedAt: '2026-09-02T10:00:00.000Z' },
        { slug: 'no-date' },
      ],
      '/providers/public-directory': { providers: [] },
      '/showcase/feed?limit=48': { cards: [], nextCursor: null },
    });
    const entries = await buildSitemap(OPEN, api.fetch);
    expect(entries.slice(3)).toEqual([
      { url: 'https://taktick.example/categories/klima-bakimi', lastModified: new Date('2026-09-01T10:00:00.000Z') },
      { url: 'https://taktick.example/categories/weird%20slug%2Fx', lastModified: new Date('2026-09-02T10:00:00.000Z') },
      { url: 'https://taktick.example/categories/no-date' },
    ]);
  });

  it('lists the approved providers the directory names, and nothing about them but the id', async () => {
    const api = fakeApi({
      '/categories': [],
      '/providers/public-directory': {
        providers: [
          { id: 'p1', updatedAt: '2026-09-03T00:00:00.000Z' },
          { id: 'p 2', updatedAt: 'not a date' },
        ],
      },
      '/showcase/feed?limit=48': { cards: [], nextCursor: null },
    });
    const entries = await buildSitemap(OPEN, api.fetch);
    expect(entries.slice(3)).toEqual([
      { url: 'https://taktick.example/isletme/p1', lastModified: new Date('2026-09-03T00:00:00.000Z') },
      { url: 'https://taktick.example/isletme/p%202' },
    ]);
  });

  it('walks the whole vitrin feed by cursor and lists each live card without a date', async () => {
    const api = fakeApi({
      '/categories': [],
      '/providers/public-directory': { providers: [] },
      '/showcase/feed?limit=48': { cards: [{ cardId: 'c1' }, { cardId: 'c2' }], nextCursor: 'abc/=' },
      '/showcase/feed?limit=48&cursor=abc%2F%3D': { cards: [{ cardId: 'c3' }], nextCursor: null },
    });
    const entries = await buildSitemap(OPEN, api.fetch);
    expect(entries.slice(3)).toEqual([
      { url: 'https://taktick.example/vitrin/c1' },
      { url: 'https://taktick.example/vitrin/c2' },
      { url: 'https://taktick.example/vitrin/c3' },
    ]);
    expect(api.calls).toContain('/showcase/feed?limit=48&cursor=abc%2F%3D');
  });

  it('stops a feed that repeats its cursor rather than looping forever', async () => {
    const api = fakeApi({
      '/categories': [],
      '/providers/public-directory': { providers: [] },
      '/showcase/feed?limit=48': { cards: [{ cardId: 'c1' }], nextCursor: 'same' },
      '/showcase/feed?limit=48&cursor=same': { cards: [{ cardId: 'c1' }], nextCursor: 'same' },
    });
    const entries = await buildSitemap(OPEN, api.fetch);
    expect(entries.filter((entry) => entry.url.endsWith('/vitrin/c1'))).toHaveLength(1);
  });

  it('keeps the static rows and the sources that answered when one source fails', async () => {
    const api = fakeApi({
      '/categories': [{ slug: 'ok' }],
      '/providers/public-directory': new Error('boom'),
      '/showcase/feed?limit=48': { cards: [], nextCursor: null },
    });
    const entries = await buildSitemap(OPEN, api.fetch);
    expect(entries.map((entry) => entry.url)).toEqual([...STATIC, 'https://taktick.example/categories/ok']);
  });

  it('skips rows without the field it needs rather than printing a placeholder', async () => {
    const api = fakeApi({
      '/categories': [{ slug: '' }, { name: 'no slug' }, null],
      '/providers/public-directory': { providers: [{ id: '' }, {}] },
      '/showcase/feed?limit=48': { cards: [{}], nextCursor: null },
    });
    const entries = await buildSitemap(OPEN, api.fetch);
    expect(entries.map((entry) => entry.url)).toEqual(STATIC);
  });

  it('never adds a query string, a panel path or a paginated URL', async () => {
    const api = fakeApi({
      '/categories': [{ slug: 'a' }],
      '/providers/public-directory': { providers: [{ id: 'p' }] },
      '/showcase/feed?limit=48': { cards: [{ cardId: 'c' }], nextCursor: null },
    });
    const entries = await buildSitemap(OPEN, api.fetch);
    for (const { url } of entries) {
      expect(url).not.toMatch(/[?#]/);
      expect(url).not.toMatch(/\/(providers|requests|account|login|register|api)\//);
      expect(url.startsWith('https://taktick.example/')).toBe(true);
    }
  });
});
