import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getMarketplacePublishPolicy` — the one read of the instant-publish switch
 * every customer surface on the request path shares.
 *
 * `readMarketplacePublishPolicy` decides what a body means; this is the layer
 * around it: the HTTP call, and what a failed or broken call turns into. The
 * rule is the same fail-closed one — anything that is not a clean 200 with the
 * documented body is "off" — proved here against the real `apiFetch`, with only
 * the network and the request cookies stood in for.
 */

vi.mock('next/headers', () => ({
  cookies: async () => ({ toString: () => '' }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
}));

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let fetchStub: FetchStub;

beforeEach(() => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
    fetchStub(input, init),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function policy(): Promise<boolean> {
  const { getMarketplacePublishPolicy } = await import('../lib/api');
  return getMarketplacePublishPolicy();
}

describe('reading the publish policy from the API', () => {
  it('is on for a 200 with the documented body', async () => {
    fetchStub = async (input) => {
      expect(String(input)).toMatch(/\/marketplace-publish-policy$/);
      return Response.json({ autoPublishEnabled: true });
    };
    expect(await policy()).toBe(true);
  });

  it('is off for a 200 that says off', async () => {
    fetchStub = async () => Response.json({ autoPublishEnabled: false });
    expect(await policy()).toBe(false);
  });

  it.each([500, 503, 404, 401])('is off when the API answers %i', async (status) => {
    fetchStub = async () => new Response('down', { status });
    expect(await policy()).toBe(false);
  });

  it('is off when the body is not JSON', async () => {
    fetchStub = async () =>
      new Response('<html>gateway</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    expect(await policy()).toBe(false);
  });

  it('is off when the JSON has the wrong shape', async () => {
    fetchStub = async () => Response.json({ autoPublishEnabled: 'true' });
    expect(await policy()).toBe(false);
  });

  it('is off when the network call throws', async () => {
    fetchStub = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await policy()).toBe(false);
  });
});
