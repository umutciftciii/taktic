import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The screen after a request is sent, worded from the request's real status.
 *
 * The contract, reader by reader:
 *
 * - The owning customer, signed in, whose request the API reports `APPROVED`
 *   — a request born live under instant publish — is told it is published,
 *   and hears nothing about a review or an approval to come.
 * - The same customer with a request still `SUBMITTED` — the switch off, an
 *   operator ahead — is told it went to review. The wording comes from the
 *   status the API returns, never from the switch, the URL or a guess.
 * - A visitor with no session gets a neutral receipt: a reference derived
 *   from the id, and no claim about status, business or offers.
 * - Any other customer holding the id, a provider, an operator, a stale id —
 *   all meet the not-found screen, and the page makes no call that could
 *   tell one customer about another's request.
 *
 * The page is rendered here through the real `apiFetch` and
 * `fetchOrNotFound`; only the network and the request cookies are stood in
 * for, so what is proved is the page's reading of real API answers.
 */

vi.mock('next/headers', () => ({
  cookies: async () => ({ toString: () => 'taktic_session=stub' }),
}));

class NotFoundSignal extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSignal();
  },
}));

const REQUEST_ID = 'cmfabcdefghijklmnopqrstuv';
const OWNER = { id: 'cmfownerownerownerownerow', role: 'CUSTOMER', name: 'Ayşe', email: 'a@example.test', phone: '+905000000001' };

type Route = (path: string) => Response | Promise<Response>;

let routes: Record<string, Route>;

beforeEach(() => {
  routes = {};
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected call to ${url.pathname}`);
    return route(url.pathname);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function signedIn(user: Record<string, unknown> | null) {
  routes['/auth/me'] = () =>
    user ? Response.json(user) : new Response('Unauthorized', { status: 401 });
}

function myRequest(status: string, extra: Record<string, unknown> = {}) {
  routes[`/service-requests/my/${REQUEST_ID}`] = () =>
    Response.json({
      id: REQUEST_ID,
      requestNumber: 'TR-2026-000123',
      status,
      customerName: OWNER.name,
      customerPhone: OWNER.phone,
      customerEmail: OWNER.email,
      city: 'İstanbul',
      district: 'Kadıköy',
      preferredDate: null,
      preferredDateEnd: null,
      urgency: null,
      qualityScore: 70,
      qualityLabel: 'GOOD',
      phoneVerifiedAt: null,
      expiredAt: null,
      submittedAt: '2026-09-17T10:00:00.000Z',
      offersCount: 0,
      category: { id: 'cat', name: 'Klima', slug: 'klima' },
      showcaseLead: null,
      ...extra,
    });
}

function noSuchRequest() {
  routes[`/service-requests/my/${REQUEST_ID}`] = () =>
    new Response('{"statusCode":404,"message":"Service request not found"}', { status: 404 });
}

/** Renders the page for `?id=<id>`; `null` renders it with no `id` at all. */
async function render(id: string | null = REQUEST_ID): Promise<string> {
  const { default: RequestSuccessPage } = await import('../app/requests/success/page');
  const element = await RequestSuccessPage({ searchParams: Promise.resolve(id ? { id } : {}) });
  return renderToStaticMarkup(element);
}

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function variantOf(markup: string): string | undefined {
  return markup.match(/data-testid="request-success" data-variant="([^"]+)"/)?.[1];
}

function titleOf(markup: string): string | undefined {
  return markup.match(/data-testid="request-success-title"[^>]*>([^<]*)</)?.[1]?.replace(/\s+/g, ' ').trim();
}

describe('the owning customer, signed in', () => {
  it('is told an APPROVED request is published, with no review or approval to come', async () => {
    signedIn(OWNER);
    myRequest('APPROVED', { approvedAt: '2026-09-17T10:00:00.000Z' });

    const markup = await render();
    expect(variantOf(markup)).toBe('published');
    expect(titleOf(markup)).toBe('Talebiniz yayınlandı');
    const text = textOf(markup);
    expect(text).toContain('talebiniz yayınlandı');
    expect(text).not.toContain('ön incele');
    expect(text).not.toContain('onay');
    expect(markup).toContain('TR-2026-000123');
    expect(markup).toContain(`href="/requests/${REQUEST_ID}/offers"`);
  });

  it('is told a SUBMITTED request went to review', async () => {
    signedIn(OWNER);
    myRequest('SUBMITTED');

    const markup = await render();
    expect(variantOf(markup)).toBe('review');
    expect(titleOf(markup)).toBe('Talebiniz ön incelemeye gönderildi');
    expect(textOf(markup)).not.toContain('yayınlandı');
  });

  it('reads the status from the API alone: the URL cannot promote a waiting request', async () => {
    signedIn(OWNER);
    myRequest('SUBMITTED');

    // `published=1` was the flag the old form set; the page carries only `id`
    // through its props and ignores anything else in the query.
    const { default: RequestSuccessPage } = await import('../app/requests/success/page');
    const element = await RequestSuccessPage({
      searchParams: Promise.resolve({ id: REQUEST_ID, published: '1' } as { id: string }),
    });
    expect(variantOf(renderToStaticMarkup(element))).toBe('review');
  });

  it('is told a vitrin lead went to one business, never to the market', async () => {
    signedIn(OWNER);
    myRequest('SUBMITTED', {
      showcaseLead: {
        id: 'lead',
        status: 'OPEN',
        slaHours: 24,
        slaDueAt: '2026-09-18T10:00:00.000Z',
        releasedAt: null,
        provider: { id: 'prov', businessName: 'Usta Klima' },
      },
    });

    const markup = await render();
    expect(variantOf(markup)).toBe('targeted');
    expect(titleOf(markup)).toBe('Talebiniz Usta Klima işletmesine iletildi');
    const text = textOf(markup);
    expect(text).not.toContain('yayınlandı');
    expect(text).not.toContain('ön incele');
  });
});

describe('a visitor with no session', () => {
  it('gets a neutral receipt with no status claim and no call for the request', async () => {
    signedIn(null);
    // No `/service-requests/my/:id` route: a call to it would throw.

    const markup = await render();
    expect(variantOf(markup)).toBe('guest');
    expect(titleOf(markup)).toBe('Talebiniz alındı');
    expect(markup).toContain(`data-testid="request-success-reference">#${REQUEST_ID.slice(-6).toUpperCase()}<`);
    const text = textOf(markup);
    for (const claim of ['yayınlandı', 'yayında', 'ön incele', 'onay', 'teklif', 'işletme']) {
      expect(text, `the guest receipt must not say "${claim}"`).not.toContain(claim);
    }
    expect(markup).not.toContain('/offers');
  });
});

describe('anybody who is not the owner', () => {
  it('another customer meets the not-found screen when the API answers 404', async () => {
    signedIn({ ...OWNER, id: 'cmfotherotherotherotherot' });
    noSuchRequest();

    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('a provider or an operator meets the not-found screen without any request call', async () => {
    for (const role of ['PROVIDER', 'ADMIN', 'SUPER_ADMIN']) {
      signedIn({ ...OWNER, role });
      await expect(render(), role).rejects.toBeInstanceOf(NotFoundSignal);
    }
  });

  it.each([
    ['no id', null],
    ['a truncated id', 'cmfabc'],
    ['a hand-edited id', 'not-an-id'],
  ])('%s is not found before any call is made', async (_label, id) => {
    // No routes at all: any fetch would throw something other than not-found.
    await expect(render(id)).rejects.toBeInstanceOf(NotFoundSignal);
  });
});
