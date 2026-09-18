import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INDEXABLE_ROUTES,
  NOINDEX_CRAWLABLE_ROUTES,
  ROBOTS_DISALLOW,
  absoluteUrl,
  canonicalPath,
  canonicalUrl,
  hasFunctionalQuery,
} from '../lib/seo-routes';

/**
 * The index allow-list, checked against the app directory the same way
 * `panel-routes.spec.ts` checks the panel list: every `page.tsx` has to be
 * classified — indexable, disallowed for crawlers, or crawlable-but-noindex —
 * and every route the allow-list names has to exist. A screen added without a
 * decision is a failing test, not a page a crawler decides about.
 */
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app');

function listPages(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = resolve(directory, entry);
    if (statSync(full).isDirectory()) found.push(...listPages(full));
    else if (entry === 'page.tsx') found.push(full);
  }
  return found.sort();
}

/** `app/categories/[slug]/page.tsx` → `/categories/:slug`. */
function routeOf(file: string): string {
  const segments = relative(appDir, dirname(file))
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => (segment.startsWith('[') ? `:${segment.slice(1, -1)}` : segment));
  return `/${segments.join('/')}`;
}

/** `/categories/:slug` → `app/categories/[slug]/page.tsx`. */
function fileOf(route: string): string {
  const segments = route
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => (segment.startsWith(':') ? `[${segment.slice(1)}]` : segment));
  return resolve(appDir, ...segments, 'page.tsx');
}

describe('the index allow-list against the app directory', () => {
  const routes = listPages(appDir).map(routeOf);

  it('classifies every page: indexable, disallowed, or crawlable-but-noindex', () => {
    const unclassified = routes.filter(
      (route) =>
        !(INDEXABLE_ROUTES as readonly string[]).includes(route) &&
        !(NOINDEX_CRAWLABLE_ROUTES as readonly string[]).includes(route) &&
        !ROBOTS_DISALLOW.some((prefix) => route === prefix.replace(/\/$/, '') || route.startsWith(prefix)),
    );
    expect(unclassified).toEqual([]);
  });

  it('names only routes that exist', () => {
    for (const route of [...INDEXABLE_ROUTES, ...NOINDEX_CRAWLABLE_ROUTES]) {
      expect(existsSync(fileOf(route)), route).toBe(true);
    }
  });

  it('never lists a panel, auth, request, offer or success screen as indexable', () => {
    for (const route of INDEXABLE_ROUTES) {
      expect(route).not.toMatch(/^\/(login|register|account|providers|requests|mesajlar|destek|admin|api)\b/);
      expect(route).not.toMatch(/success|preview|taslak/);
    }
  });

  it('is exactly the six public surfaces', () => {
    expect([...INDEXABLE_ROUTES].sort()).toEqual(
      ['/', '/categories', '/categories/:slug', '/isletme/:id', '/vitrin', '/vitrin/:cardId'].sort(),
    );
  });

  it('disallows the API routes and every private prefix', () => {
    expect(ROBOTS_DISALLOW).toContain('/api/');
    for (const prefix of ['/account/', '/login', '/register/', '/requests/', '/providers/', '/mesajlar', '/destek']) {
      expect(ROBOTS_DISALLOW).toContain(prefix);
    }
  });
});

describe('hasFunctionalQuery — which query strings make a page a variant', () => {
  it('treats search, filter, pagination and flow-state parameters as variants', () => {
    expect(hasFunctionalQuery('/categories', { q: 'klima' })).toBe(true);
    expect(hasFunctionalQuery('/categories/:slug', { entry: 'klima' })).toBe(true);
    expect(hasFunctionalQuery('/categories/:slug', { r: 'abc' })).toBe(true);
    expect(hasFunctionalQuery('/isletme/:id', { cursor: 'abc' })).toBe(true);
    expect(hasFunctionalQuery('/vitrin', { il: 'İstanbul' })).toBe(true);
    expect(hasFunctionalQuery('/vitrin', { ilce: 'Kadıköy' })).toBe(true);
    for (const name of ['step', 'sent', 'city', 'district', 'neighborhood', 'phone']) {
      expect(hasFunctionalQuery('/vitrin/:cardId', { [name]: 'x' }), name).toBe(true);
    }
  });

  it('ignores tracking and unknown parameters, so a campaign link is the same page', () => {
    expect(hasFunctionalQuery('/', { utm_source: 'x', fbclid: 'y' })).toBe(false);
    expect(hasFunctionalQuery('/categories', { utm_campaign: 'x' })).toBe(false);
    expect(hasFunctionalQuery('/isletme/:id', { gclid: 'x' })).toBe(false);
  });

  it('treats an empty value as absent', () => {
    expect(hasFunctionalQuery('/categories', { q: '' })).toBe(false);
    expect(hasFunctionalQuery('/categories', { q: undefined })).toBe(false);
    expect(hasFunctionalQuery('/vitrin', {})).toBe(false);
  });

  it('counts a repeated parameter as present', () => {
    expect(hasFunctionalQuery('/categories', { q: ['a', 'b'] })).toBe(true);
    expect(hasFunctionalQuery('/categories', { q: [] })).toBe(false);
  });
});

describe('canonicalPath — the clean path a page is indexed under', () => {
  it('escapes dynamic segments and carries no query', () => {
    expect(canonicalPath('/categories/:slug', { slug: 'klima-bakimi' })).toBe('/categories/klima-bakimi');
    expect(canonicalPath('/isletme/:id', { id: 'a b/c?d' })).toBe('/isletme/a%20b%2Fc%3Fd');
    expect(canonicalPath('/', {})).toBe('/');
    expect(canonicalPath('/vitrin', {})).toBe('/vitrin');
  });

  it('refuses a missing segment rather than printing a placeholder', () => {
    expect(() => canonicalPath('/categories/:slug', {})).toThrow(/slug/);
  });
});

describe('absoluteUrl / canonicalUrl — the one URL form every surface prints', () => {
  const ORIGIN = 'https://taktick.example';

  it('prints the root as the bare origin, never with a trailing slash', () => {
    expect(absoluteUrl(ORIGIN, '/')).toBe('https://taktick.example');
    expect(canonicalUrl(ORIGIN, '/', {})).toBe('https://taktick.example');
  });

  it('joins a path onto the origin with no trailing slash', () => {
    expect(absoluteUrl(ORIGIN, '/categories')).toBe('https://taktick.example/categories');
    expect(absoluteUrl(ORIGIN, '/categories/')).toBe('https://taktick.example/categories');
    expect(absoluteUrl(ORIGIN, '/brand/logo.png')).toBe('https://taktick.example/brand/logo.png');
  });

  it('refuses a path that is not rooted or that carries a query or fragment', () => {
    expect(() => absoluteUrl(ORIGIN, 'categories')).toThrow(/rooted/);
    expect(() => absoluteUrl(ORIGIN, '/categories?q=x')).toThrow(/query/);
    expect(() => absoluteUrl(ORIGIN, '/categories#top')).toThrow(/query/);
  });

  it('refuses an origin with a trailing slash or a path, so no double slash can be built', () => {
    expect(() => absoluteUrl('https://taktick.example/', '/categories')).toThrow(/origin/);
    expect(() => absoluteUrl('https://taktick.example/app', '/categories')).toThrow(/origin/);
  });

  it('escapes dynamic segments through canonicalPath', () => {
    expect(canonicalUrl(ORIGIN, '/isletme/:id', { id: 'a b' })).toBe('https://taktick.example/isletme/a%20b');
    expect(canonicalUrl(ORIGIN, '/categories/:slug', { slug: 'klima-bakimi' })).toBe(
      'https://taktick.example/categories/klima-bakimi',
    );
  });
});
