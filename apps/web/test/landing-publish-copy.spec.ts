import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { landingPublishCopy } from '../lib/request-next-steps';

/**
 * The two static "an operator reads every request" claims on the home page
 * (REQ-UX-011): the "Admin ön inceleme" trust card and the hero's
 * "Ön inceleme · Her talep" floating card.
 *
 * They follow the same instant-publish switch as the request form, read the
 * same fail-closed way (`GET /marketplace-publish-policy`, REQ-UX-008/009):
 * with the switch on, the page says the request reaches approved providers
 * and collects offers, and names no review; with it off — or unreadable — the
 * review wording stays exactly as it was. Nothing else on the page changes:
 * the provider-side value proposition and the FAQ about the provider
 * application are about other processes and keep their words.
 *
 * The page is rendered here through the real `apiFetch`; only the network
 * and the request cookies are stood in for.
 */

vi.mock('next/headers', () => ({
  cookies: async () => ({ toString: () => '' }),
}));

// The hero is a client component that asks for the app router on mount;
// there is no router in a static render, and nothing here navigates.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

// The vitrin shelf is an async server component of its own, with its own
// read and its own tests; a static render cannot await a nested one, and it
// carries none of the wording under test.
vi.mock('../app/showcase-shelf', () => ({
  ShowcaseShelf: () => null,
}));

type Route = (path: string) => Response | Promise<Response>;
let routes: Record<string, Route>;
let calls: string[];

beforeEach(() => {
  routes = {
    '/categories': () => Response.json([]),
    '/auth/me': () => new Response('Unauthorized', { status: 401 }),
    '/refund-policy': () => Response.json({ unviewedOfferRefundWindowHours: 48 }),
  };
  calls = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected call to ${url.pathname}`);
    return route(url.pathname);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function publishPolicy(state: boolean | 'unreadable' | 'malformed') {
  routes['/marketplace-publish-policy'] = () =>
    state === 'unreadable'
      ? new Response('down', { status: 503 })
      : state === 'malformed'
        ? Response.json({ autoPublishEnabled: 'true' })
        : Response.json({ autoPublishEnabled: state });
}

async function renderHome(): Promise<string> {
  const { default: HomePage } = await import('../app/page');
  return renderToStaticMarkup(await HomePage());
}

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const REVIEW = landingPublishCopy(false);
const INSTANT = landingPublishCopy(true);

describe('the copy pair', () => {
  it('keeps the review wording, word for word, while the switch is off', () => {
    expect(REVIEW.trustCard).toEqual({
      title: 'Admin ön inceleme',
      desc: 'Talepler yayına alınmadan önce inceleme süreçlerinden geçer.',
    });
    expect(REVIEW.heroCard).toEqual({ label: 'Ön inceleme', value: 'Her talep' });
  });

  it('names no review or admin while the switch is on', () => {
    for (const sentence of [
      INSTANT.trustCard.title,
      INSTANT.trustCard.desc,
      INSTANT.heroCard.label,
      INSTANT.heroCard.value,
    ]) {
      const lower = sentence.toLowerCase();
      expect(lower, sentence).not.toContain('incele');
      expect(lower, sentence).not.toContain('admin');
      expect(lower, sentence).not.toContain('onay sonras');
    }
    expect(INSTANT.trustCard.desc.toLowerCase()).toContain('hizmet veren');
    expect(INSTANT.trustCard.desc.toLowerCase()).toContain('teklif');
  });
});

describe('the home page', () => {
  it('shows the instant wording with the switch on', async () => {
    publishPolicy(true);
    const markup = await renderHome();
    const text = textOf(markup);
    expect(markup).toContain('data-auto-publish="on"');
    expect(text).toContain(INSTANT.trustCard.title);
    expect(text).toContain(INSTANT.trustCard.desc);
    expect(text).toContain(`${INSTANT.heroCard.label} ${INSTANT.heroCard.value}`);
    expect(text).not.toContain(REVIEW.trustCard.title);
    expect(text).not.toContain(REVIEW.trustCard.desc);
    expect(text).not.toContain('Ön inceleme Her talep');
    expect(calls.filter((path) => path === '/marketplace-publish-policy')).toHaveLength(1);
  });

  it('shows the review wording with the switch off', async () => {
    publishPolicy(false);
    const text = textOf(await renderHome());
    expect(text).toContain(REVIEW.trustCard.title);
    expect(text).toContain(REVIEW.trustCard.desc);
    expect(text).toContain('Ön inceleme Her talep');
    expect(text).not.toContain(INSTANT.trustCard.title);
  });

  it.each([
    ['unreadable', 'unreadable'],
    ['malformed', 'malformed'],
  ] as const)('falls back to the review wording when the policy is %s', async (_label, state) => {
    publishPolicy(state);
    const markup = await renderHome();
    const text = textOf(markup);
    expect(markup).toContain('data-auto-publish="off"');
    expect(text).toContain(REVIEW.trustCard.title);
    expect(text).toContain('Ön inceleme Her talep');
    expect(text).not.toContain(INSTANT.trustCard.title);
  });

  it('leaves the provider-side and FAQ wording alone in both states', async () => {
    for (const state of [true, false]) {
      publishPolicy(state);
      const text = textOf(await renderHome());
      // The provider value proposition: about what a provider sees.
      expect(text, String(state)).toContain('İncelenmiş talepler.');
      // The FAQ about the provider application: a real operator process.
      expect(text, String(state)).toContain('ekibimiz başvurunu inceler');
    }
  });
});
