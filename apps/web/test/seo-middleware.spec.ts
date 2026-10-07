import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SEO-004 — the middleware end to end over a fake API: real 301 and 302
 * responses, pass-through for everything else, and fail-closed on an outage.
 * The module is loaded fresh per case so its snapshot cache starts empty.
 */

const SNAPSHOT = {
  generatedAt: '2026-10-07T00:00:00.000Z',
  redirects: [
    { source: '/categories/eski', target: '/categories/yeni', status: 301 },
    { source: '/eski/kampanya', target: '/vitrin', status: 302 },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
const savedEnv = { ...process.env };

async function loadMiddleware() {
  vi.resetModules();
  return (await import('../middleware')).middleware;
}

function get(path: string, method = 'GET') {
  return new NextRequest(new URL(path, 'http://evil-host.example'), { method });
}

const passedThrough = (response: Response) => response.headers.get('x-middleware-next') === '1';

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(SNAPSHOT), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  process.env.WEB_APP_URL = 'https://taktick.example';
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...savedEnv };
});

describe('middleware', () => {
  it('answers a permanent redirect with a real 301 to the canonical target, query dropped', async () => {
    const middleware = await loadMiddleware();
    const response = await middleware(get('/categories/eski?utm_source=x#frag'));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://taktick.example/categories/yeni');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/seo\/redirects\/active$/);
  });

  it('answers a temporary redirect with a real 302, never cached', async () => {
    const middleware = await loadMiddleware();
    const response = await middleware(get('/Eski/Kampanya/'));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://taktick.example/vitrin');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('builds Location from the configured origin, never from the Host the caller sent', async () => {
    const middleware = await loadMiddleware();
    const response = await middleware(get('/categories/eski'));
    expect(response.headers.get('location')).not.toContain('evil-host');
    delete process.env.WEB_APP_URL;
    const relative = await middleware(get('/categories/eski'));
    expect(relative.headers.get('location')).toBe('/categories/yeni');
  });

  it('passes through a path it does not list, a write, the root and a malformed path', async () => {
    const middleware = await loadMiddleware();
    expect(passedThrough(await middleware(get('/categories/baska')))).toBe(true);
    expect(passedThrough(await middleware(get('/categories/eski', 'POST')))).toBe(true);
    expect(passedThrough(await middleware(get('/')))).toBe(true);
    expect(passedThrough(await middleware(get('/categories/%2e%2e/eski')))).toBe(true);
  });

  it('redirects nothing while the API is unreachable', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    const middleware = await loadMiddleware();
    expect(passedThrough(await middleware(get('/categories/eski')))).toBe(true);
    fetchMock.mockImplementation(async () => new Response('oops', { status: 500 }));
    const again = await loadMiddleware();
    expect(passedThrough(await again(get('/categories/eski')))).toBe(true);
  });

  it('never runs on /api, /_next or a file', async () => {
    const { config } = await import('../middleware');
    expect(config.runtime).toBe('nodejs');
    const pattern = new RegExp(`^${config.matcher[0]!}$`);
    for (const path of ['/categories/eski', '/eski/kampanya', '/kategori/ev-temizligi']) expect(pattern.test(path), path).toBe(true);
    for (const path of ['/api/x', '/_next/static/a.js', '/robots.txt', '/categories/cat-klima.png']) {
      expect(pattern.test(path), path).toBe(false);
    }
  });
});
