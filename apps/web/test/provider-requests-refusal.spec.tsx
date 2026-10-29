import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import {
  describeRequestListRefusal,
  REQUEST_LIST_REFUSAL_MESSAGES,
  RequestListRefusalNotice,
} from '../app/providers/request-list-refusal';

/**
 * PROVIDER-STATUS-UX-001 — the provider's matching-request list when the API
 * refuses it.
 *
 * A suspended provider opening `/providers/:id/requests` used to read the
 * API's raw 403 body on the screen. The page now turns the refusal into a
 * word and the word into one neutral sentence with the support route; the
 * API's 403 rule itself is untouched. An approved provider's list, the
 * signed-out redirect and another account's panel (404) behave as before.
 *
 * The page runs through the real `apiFetch` and `fetchOrNotFound`; only the
 * network, the cookies and Next's navigation signals are stood in for. The
 * shell is an async server component, so the returned element tree is read
 * directly instead of being rendered.
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
const USER = { id: 'cmfuseruseruseruseruseruse', role: 'PROVIDER', name: 'Usta', email: 'u@example.test', phone: '+905000000002' };
const RAW_403 = { message: 'Provider must be approved to view matching requests', error: 'Forbidden', statusCode: 403 };
const SECRET = 'GIZLI-ASKI-GEREKCESI';

function providerBody(status: string) {
  return {
    id: PROVIDER_ID,
    businessName: 'Test Elektrik',
    city: 'İstanbul',
    district: 'Kadıköy',
    description: null,
    status,
    serviceCategories: [],
    serviceAreas: [],
    visibility: 'owner',
    // Defense in depth: even if a moderation field ever reached the owner
    // projection, the page must not print it.
    suspensionReason: SECRET,
    moderationNote: SECRET,
  };
}

const REQUEST = {
  id: 'cmfrequestrequestrequestre',
  requestNumber: 'REQ-1',
  status: 'APPROVED',
  category: { id: 'c1', name: 'Elektrikci', slug: 'elektrikci', illustrationKey: null },
  city: 'İstanbul',
  district: 'Kadıköy',
  neighborhood: null,
  deliveryMode: 'ON_SITE',
  description: 'Priz arızası',
  budgetMin: null,
  budgetMax: null,
  urgency: null,
  qualityLabel: 'HIGH',
  submittedAt: '2026-10-29T10:00:00.000Z',
  offerCreditCost: 2,
  offerBlockedReason: null,
  offersCount: 0,
};

type Route = () => Response;
let routes: Record<string, Route>;
let calls: string[];

beforeEach(() => {
  routes = {
    '/auth/me': () => Response.json(USER),
    [`/providers/${PROVIDER_ID}`]: () => Response.json(providerBody('APPROVED')),
    '/categories': () => Response.json([]),
    [`/providers/${PROVIDER_ID}/credits`]: () => Response.json({ balance: 4 }),
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
  const { default: Page } = await import('../app/providers/[id]/requests/page');
  return Page({ params: Promise.resolve({ id: PROVIDER_ID }), searchParams: Promise.resolve({}) });
}

function listAnswers(status: number, body: unknown) {
  routes[`/providers/${PROVIDER_ID}/requests`] = () => Response.json(body, { status });
}

/** Every element of the tree the page returned, without rendering the async shell. */
function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    elements((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

/** All literal text the page itself put in the tree. */
function texts(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(texts).join(' ');
  if (isValidElement(node)) return texts((node.props as { children?: ReactNode }).children);
  return '';
}

function refusalOf(tree: ReactNode) {
  const notice = elements(tree).find((element) => element.type === RequestListRefusalNotice);
  expect(notice, 'the page always places the refusal notice').toBeDefined();
  return (notice!.props as { refusal: string | null }).refusal;
}

function noticeMarkup(tree: ReactNode) {
  const notice = elements(tree).find((element) => element.type === RequestListRefusalNotice)!;
  return renderToStaticMarkup(notice);
}

describe('describeRequestListRefusal', () => {
  const forbidden = new ApiError(403, JSON.stringify(RAW_403));

  it('a 403 for a SUSPENDED provider is restricted', () => {
    expect(describeRequestListRefusal(forbidden, 'SUSPENDED')).toBe('restricted');
  });

  it.each(['PENDING_REVIEW', 'DRAFT', 'REJECTED'] as const)('a 403 for %s is notApproved', (status) => {
    expect(describeRequestListRefusal(forbidden, status)).toBe('notApproved');
  });

  it('a 403 for an APPROVED provider, a 5xx, a network error: failed', () => {
    expect(describeRequestListRefusal(forbidden, 'APPROVED')).toBe('failed');
    expect(describeRequestListRefusal(new ApiError(500, 'boom'), 'SUSPENDED')).toBe('failed');
    expect(describeRequestListRefusal(new TypeError('fetch failed'), 'SUSPENDED')).toBe('failed');
  });

  it('a 401 is signedOut', () => {
    expect(describeRequestListRefusal(new ApiError(401, 'Unauthorized'), 'APPROVED')).toBe('signedOut');
  });
});

describe('RequestListRefusalNotice', () => {
  it('restricted: the neutral sentence and the support route, nothing technical', () => {
    const html = renderToStaticMarkup(<RequestListRefusalNotice refusal="restricted" />);
    expect(html).toContain('Hesabınız geçici olarak sınırlandırılmıştır. Yeni taleplere şu anda erişemiyorsunuz.');
    expect(html).toContain('href="/destek"');
    expect(html).not.toMatch(/statusCode|Forbidden|approved|\{"/);
  });

  it('nothing for no refusal', () => {
    expect(renderToStaticMarkup(<RequestListRefusalNotice refusal={null} />)).toBe('');
  });
});

describe('the requests page', () => {
  it('SUSPENDED: the API’s 403 becomes the neutral notice — no raw JSON, no reason, no empty state', async () => {
    routes[`/providers/${PROVIDER_ID}`] = () => Response.json(providerBody('SUSPENDED'));
    listAnswers(403, RAW_403);

    const tree = await renderPage();
    expect(refusalOf(tree)).toBe('restricted');
    const html = noticeMarkup(tree);
    expect(html).toContain(REQUEST_LIST_REFUSAL_MESSAGES.restricted);
    expect(html).toContain('href="/destek"');

    const pageText = texts(tree) + JSON.stringify(elements(tree).map((element) => element.props), (key, value) =>
      key === 'children' ? undefined : value,
    );
    expect(pageText).not.toContain('Provider must be approved');
    expect(pageText).not.toContain('statusCode');
    expect(pageText).not.toContain(SECRET);
    expect(texts(tree)).not.toContain('Şu an uygun talep yok');
    // The API was still asked: its 403 is the rule, the page only words it.
    expect(calls).toContain(`/providers/${PROVIDER_ID}/requests`);
  });

  it('PENDING_REVIEW: the not-yet-approved sentence', async () => {
    routes[`/providers/${PROVIDER_ID}`] = () => Response.json(providerBody('PENDING_REVIEW'));
    listAnswers(403, RAW_403);
    const tree = await renderPage();
    expect(refusalOf(tree)).toBe('notApproved');
    expect(noticeMarkup(tree)).toContain(REQUEST_LIST_REFUSAL_MESSAGES.notApproved);
  });

  it('APPROVED: the list as before, no notice', async () => {
    listAnswers(200, [REQUEST]);
    const tree = await renderPage();
    expect(refusalOf(tree)).toBeNull();
    expect(noticeMarkup(tree)).toBe('');
    const count = elements(tree).find(
      (element) => (element.props as { 'data-testid'?: string })['data-testid'] === 'matching-request-count',
    );
    expect(texts(count)).toBe('1');
  });

  it('APPROVED with an empty list: the empty state, no notice', async () => {
    listAnswers(200, []);
    const tree = await renderPage();
    expect(refusalOf(tree)).toBeNull();
    expect(texts(tree)).toContain('Şu an uygun talep yok');
  });

  it('a genuine failure (500) is the generic sentence, not the API body', async () => {
    listAnswers(500, { statusCode: 500, message: 'Internal server error' });
    const tree = await renderPage();
    expect(refusalOf(tree)).toBe('failed');
    const html = noticeMarkup(tree);
    expect(html).toContain(REQUEST_LIST_REFUSAL_MESSAGES.failed);
    expect(html).not.toContain('Internal server error');
  });

  it('signed out: sign-in first, before any provider data is read', async () => {
    routes['/auth/me'] = () => new Response('Unauthorized', { status: 401 });
    await expect(renderPage()).rejects.toBeInstanceOf(RedirectSignal);
    expect(calls).toEqual(['/auth/me']);
  });

  it('a session that ended before the list read goes to sign-in too', async () => {
    listAnswers(401, { statusCode: 401, message: 'Unauthorized' });
    const failure = await renderPage().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RedirectSignal);
    expect((failure as RedirectSignal).to).toBe(`/login?redirectTo=/providers/${PROVIDER_ID}/requests`);
  });

  it('another account’s panel (API 403 on the profile) is still the 404, and the list is never read', async () => {
    routes[`/providers/${PROVIDER_ID}`] = () =>
      Response.json({ statusCode: 403, message: 'Provider access denied', error: 'Forbidden' }, { status: 403 });
    await expect(renderPage()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(calls).not.toContain(`/providers/${PROVIDER_ID}/requests`);
  });
});
