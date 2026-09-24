import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BUG-OPS-002 — the provider's package purchase detail, for a purchase the
 * viewer may not see.
 *
 * The API answers 404 for a purchase that is not this provider's or does not
 * exist, 403 for another provider's panel, and 400 for an id it will not
 * parse. The page used to call `apiFetch` bare, so each of those became an
 * unhandled rejection — the error boundary and an HTTP 500. It now goes
 * through `fetchOrNotFound`: all of them end in `notFound()`, the one 404 the
 * framework serves with the shared not-found screen. A genuine failure (500)
 * is not dressed up as a 404.
 *
 * The page runs here through the real `apiFetch` and `fetchOrNotFound`; only
 * the network, the cookies and Next's navigation signals are stood in for.
 */

vi.mock('next/headers', () => ({
  cookies: async () => ({ toString: () => 'taktic_session=stub' }),
}));

class NotFoundSignal extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}
class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSignal();
  },
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

const PROVIDER_ID = 'cmfproviderproviderprovid';
const PURCHASE_ID = 'cmfpurchasepurchasepurcha';
const USER = { id: 'cmfuseruseruseruseruseruse', role: 'PROVIDER', name: 'Usta', email: 'u@example.test', phone: '+905000000002' };

type Route = () => Response;
let routes: Record<string, Route>;
let calls: string[];

beforeEach(() => {
  routes = {
    '/auth/me': () => Response.json(USER),
    [`/support/package-refund/purchases/${PURCHASE_ID}/availability`]: () => new Response('Not Found', { status: 404 }),
  };
  calls = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected call to ${url.pathname}`);
    return route();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderPage() {
  const { default: Page } = await import('../app/providers/[id]/package-purchases/[purchaseId]/page');
  return Page({
    params: Promise.resolve({ id: PROVIDER_ID, purchaseId: PURCHASE_ID }),
    searchParams: Promise.resolve({}),
  });
}

function purchaseAnswers(status: number, body: unknown) {
  routes[`/providers/${PROVIDER_ID}/package-purchases/${PURCHASE_ID}`] = () =>
    Response.json(body, { status });
}

describe('package purchase detail refusals', () => {
  it.each([
    ['a purchase that is not this provider’s, or does not exist (API 404)', 404, { statusCode: 404, message: 'Package purchase not found', error: 'Not Found' }],
    ['another provider’s panel (API 403)', 403, { statusCode: 403, message: 'Provider access denied', error: 'Forbidden' }],
    ['an id the API will not parse (API 400)', 400, { statusCode: 400, message: 'Bad Request' }],
  ])('%s → notFound(), not the error boundary', async (_label, status, body) => {
    purchaseAnswers(status, body);
    await expect(renderPage()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(calls).toContain(`/providers/${PROVIDER_ID}/package-purchases/${PURCHASE_ID}`);
  });

  it('a genuine API failure (500) is not masked as a 404', async () => {
    purchaseAnswers(500, { statusCode: 500, message: 'Internal server error' });
    const failure = await renderPage().catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(NotFoundSignal);
    expect(failure).toMatchObject({ status: 500 });
  });

  it('no session still goes to sign-in before any purchase is read', async () => {
    routes['/auth/me'] = () => new Response('Unauthorized', { status: 401 });
    await expect(renderPage()).rejects.toBeInstanceOf(RedirectSignal);
    expect(calls).toEqual(['/auth/me']);
  });
});
