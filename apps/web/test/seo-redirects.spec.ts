import { describe, expect, it } from 'vitest';
import seoPaths from '../../../packages/shared/seo-paths.json';
import siteGateCases from '../../../packages/shared/seo-site-gate-cases.json';
import { categoryIllustration, categoryImageSrc } from '../app/category-art';
import { normalizeSeoPath } from '../lib/seo-paths';
import {
  REDIRECT_SNAPSHOT_MAX_STALE_MS,
  REDIRECT_SNAPSHOT_TTL_MS,
  RETRY_AFTER_FAILURE_MS,
  configuredWebOrigin,
  createRedirectResolver,
  parseRedirectSnapshot,
  redirectLocation,
} from '../lib/seo-redirects';
import { resolveSeoSite } from '../lib/seo-site';

/**
 * SEO-004 — the web half of the redirect contract: the same path rule as the
 * API (shared cases), the snapshot cache and its failure modes, and the
 * Location header.
 */

describe('normalizeSeoPath — the shared address cases', () => {
  for (const testCase of seoPaths.normalizeCases) {
    const label = JSON.stringify(testCase.input).slice(0, 60);
    it(`${label} → ${'path' in testCase ? testCase.path : testCase.refusal}`, () => {
      expect(normalizeSeoPath(testCase.input)).toEqual(
        'path' in testCase ? { ok: true, path: testCase.path } : { ok: false, refusal: testCase.refusal },
      );
    });
  }
});

describe('resolveSeoSite — the shared site-gate cases (the API reports the same answer)', () => {
  for (const testCase of siteGateCases.cases) {
    it(`${JSON.stringify(testCase.env)}`, () => {
      const site = resolveSeoSite(testCase.env as unknown as NodeJS.ProcessEnv);
      expect(site.indexable).toBe(testCase.open);
      if (site.indexable) expect(site.origin).toBe(testCase.origin);
      else expect(site.reason).toBe(testCase.reason);
    });
  }
});

describe('parseRedirectSnapshot', () => {
  it('keeps well-formed 301/302 rows and drops anything else, never repairing', () => {
    const table = parseRedirectSnapshot({
      redirects: [
        { source: '/categories/eski', target: '/categories/yeni', status: 301 },
        { source: '/eski/kampanya', target: '/vitrin', status: 302 },
        { source: '/eski/a', target: 'https://evil.com', status: 301 },
        { source: '/eski/b', target: '//evil.com', status: 301 },
        { source: '/eski/c', target: '/login', status: 301 },
        { source: '/eski/d', target: '/categories/x', status: 307 },
        { source: '/Eski/E', target: '/categories/x', status: 301 },
        { source: '/', target: '/categories/x', status: 301 },
        { source: '/eski/f', target: '/eski/f', status: 301 },
        'junk',
      ],
    });
    expect(table && [...table.entries()]).toEqual([
      ['/categories/eski', { target: '/categories/yeni', status: 301 }],
      ['/eski/kampanya', { target: '/vitrin', status: 302 }],
    ]);
    expect(parseRedirectSnapshot(null)).toBeNull();
    expect(parseRedirectSnapshot({ redirects: 'x' })).toBeNull();
  });
});

function harness(initial: unknown) {
  let clock = 1_000_000;
  let body: unknown = initial;
  let calls = 0;
  const resolver = createRedirectResolver({
    now: () => clock,
    fetchSnapshot: async () => {
      calls += 1;
      if (body instanceof Error) throw body;
      return body;
    },
  });
  return {
    resolver,
    advance: (ms: number) => {
      clock += ms;
    },
    setBody: (next: unknown) => {
      body = next;
    },
    calls: () => calls,
  };
}

const ONE = { redirects: [{ source: '/categories/eski', target: '/categories/yeni', status: 301 }] };
const TWO = { redirects: [{ source: '/categories/eski', target: '/categories/baska', status: 302 }] };

describe('createRedirectResolver', () => {
  it('answers a match, and null for a path it does not list', async () => {
    const h = harness(ONE);
    expect(await h.resolver.resolve('/categories/eski')).toEqual({ target: '/categories/yeni', status: 301 });
    expect(await h.resolver.resolve('/categories/yok')).toBeNull();
    expect(h.calls()).toBe(1);
  });

  it('serves the snapshot for the TTL without asking again, then refreshes behind a stale answer', async () => {
    const h = harness(ONE);
    await h.resolver.resolve('/categories/eski');
    h.advance(REDIRECT_SNAPSHOT_TTL_MS - 1);
    await h.resolver.resolve('/categories/eski');
    expect(h.calls()).toBe(1);

    h.setBody(TWO);
    h.advance(2);
    // Stale: the old answer now, the refresh behind it.
    expect(await h.resolver.resolve('/categories/eski')).toEqual({ target: '/categories/yeni', status: 301 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await h.resolver.resolve('/categories/eski')).toEqual({ target: '/categories/baska', status: 302 });
    expect(h.calls()).toBe(2);
  });

  it('keeps the last good list through an API outage — but never past ten minutes', async () => {
    const h = harness(ONE);
    await h.resolver.resolve('/categories/eski');
    h.setBody(new Error('API down'));
    h.advance(REDIRECT_SNAPSHOT_TTL_MS + 1);
    expect(await h.resolver.resolve('/categories/eski')).toEqual({ target: '/categories/yeni', status: 301 });
    await new Promise((resolve) => setImmediate(resolve));

    // Not retried on every request during the outage.
    const afterFailure = h.calls();
    await h.resolver.resolve('/categories/eski');
    expect(h.calls()).toBe(afterFailure);

    h.advance(REDIRECT_SNAPSHOT_MAX_STALE_MS);
    expect(await h.resolver.resolve('/categories/eski')).toBeNull();
  });

  it('redirects nothing when the very first fetch fails, and retries only after the back-off', async () => {
    const h = harness(new Error('API down'));
    expect(await h.resolver.resolve('/categories/eski')).toBeNull();
    expect(await h.resolver.resolve('/categories/eski')).toBeNull();
    expect(h.calls()).toBe(1);
    h.setBody(ONE);
    h.advance(RETRY_AFTER_FAILURE_MS);
    expect(await h.resolver.resolve('/categories/eski')).toEqual({ target: '/categories/yeni', status: 301 });
  });

  it('treats a body of the wrong shape as a failure', async () => {
    const h = harness({ unexpected: true });
    expect(await h.resolver.resolve('/categories/eski')).toBeNull();
  });
});

describe('redirectLocation', () => {
  it('joins the configured origin and checks the result is still that origin', () => {
    expect(redirectLocation('/categories/yeni', 'https://taktick.example')).toBe('https://taktick.example/categories/yeni');
    expect(redirectLocation('/', 'https://taktick.example')).toBe('https://taktick.example/');
    expect(redirectLocation('/kategori/ev-temizliği', 'https://taktick.example')).toBe(
      'https://taktick.example/kategori/ev-temizli%C4%9Fi',
    );
  });

  it('falls back to a relative Location without a configured origin — never the request Host', () => {
    expect(redirectLocation('/categories/yeni', null)).toBe('/categories/yeni');
  });

  it('refuses anything that would leave the origin', () => {
    expect(redirectLocation('//evil.com/x', 'https://taktick.example')).toBeNull();
    expect(redirectLocation('//evil.com/x', null)).toBeNull();
  });

  it('reads the deployment origin the way the rest of the web does, http allowed for a local stack', () => {
    expect(configuredWebOrigin({ WEB_APP_URL: 'https://taktick.example/' } as unknown as NodeJS.ProcessEnv)).toBe('https://taktick.example');
    expect(configuredWebOrigin({ WEB_ORIGIN: 'http://localhost:3000' } as unknown as NodeJS.ProcessEnv)).toBe('http://localhost:3000');
    expect(configuredWebOrigin({ WEB_APP_URL: 'https://taktick.example/app' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(configuredWebOrigin({ WEB_APP_URL: 'ftp://x' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(configuredWebOrigin({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('category art follows the illustration key, not the slug', () => {
  it('draws the packaged illustration by key, the API image first, and nothing for an unknown key', () => {
    expect(categoryIllustration('kombi-servisi')).toBe('/categories/cat-kombi-servisi.png');
    expect(categoryImageSrc(null, 'kombi-servisi')).toBe('/categories/cat-kombi-servisi.png');
    expect(categoryImageSrc('https://cdn.example/x.png', 'kombi-servisi')).toBe('https://cdn.example/x.png');
    // A renamed category keeps its key, so its slug is irrelevant here.
    expect(categoryImageSrc(null, null)).toBeNull();
    expect(categoryIllustration('kombi-bakim-servisi')).toBeNull();
    expect(categoryIllustration('constructor')).toBeNull();
  });
});
