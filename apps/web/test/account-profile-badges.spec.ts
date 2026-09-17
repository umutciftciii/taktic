import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "Doğrulandı" / "Doğrulanmadı" badges on the customer's own settings
 * screen. Their only source is the account's two canonical columns as the
 * profile read (or, failing that, the session) carries them; a null is
 * "Doğrulanmadı", worded as a fact and never as a failure. No button is
 * added for the unverified state — the screen has no verification flow of
 * its own to send anybody to.
 *
 * Rendered through the real `apiFetch`; only the network and the cookies are
 * stood in for.
 */

vi.mock('next/headers', () => ({
  cookies: async () => ({ toString: () => 'taktic_session=stub' }),
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

// The panel shell is an async server component with reads of its own (the
// nav counts); a static render cannot await a nested one and it carries no
// badge. Its children — the page — are what is rendered.
vi.mock('../app/requests/customer-shell', () => ({
  CustomerShell: ({ children }: { children: unknown }) => children,
}));

type Route = (path: string) => Response | Promise<Response>;
let routes: Record<string, Route>;

const CUSTOMER = {
  id: 'cmfownerownerownerownerow',
  role: 'CUSTOMER',
  name: 'Ayşe',
  email: 'ayse@example.test',
  phone: '+905000000001',
  isActive: true,
};

beforeEach(() => {
  routes = {
    '/auth/me': () => Response.json(CUSTOMER),
    '/locations/provinces': () => Response.json([]),
  };
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

function profile(extra: Record<string, unknown>) {
  routes['/account/profile'] = () =>
    Response.json({
      id: CUSTOMER.id,
      name: CUSTOMER.name,
      email: CUSTOMER.email,
      phone: CUSTOMER.phone,
      city: null,
      role: 'CUSTOMER',
      hasPassword: true,
      ...extra,
    });
}

async function render(): Promise<string> {
  const { default: AccountProfilePage } = await import('../app/account/profile/page');
  return renderToStaticMarkup(await AccountProfilePage({ searchParams: Promise.resolve({}) }));
}

/** The badge element for a channel: its attributes and its text. */
function badge(markup: string, channel: 'email' | 'phone') {
  const match = markup.match(
    new RegExp(`<span[^>]*data-testid="account-${channel}-verification"[^>]*>([^<]*)</span>`),
  );
  expect(match, `the ${channel} badge is on the page`).not.toBeNull();
  const tag = match?.[0] ?? '';
  return {
    text: match?.[1] ?? '',
    verified: /data-verified="true"/.test(tag),
    classes: (tag.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/),
    ariaLabel: tag.match(/aria-label="([^"]*)"/)?.[1] ?? '',
  };
}

describe('both channels proven', () => {
  it('shows two "Doğrulandı" badges, each with an accessible name', async () => {
    profile({
      emailVerifiedAt: '2026-09-10T08:00:00.000Z',
      phoneVerifiedAt: '2026-09-12T09:30:00.000Z',
    });
    const markup = await render();
    const email = badge(markup, 'email');
    const phone = badge(markup, 'phone');
    expect(email).toMatchObject({ text: 'Doğrulandı', verified: true, ariaLabel: 'E-posta doğrulandı' });
    expect(phone).toMatchObject({ text: 'Doğrulandı', verified: true, ariaLabel: 'Telefon doğrulandı' });
    expect(email.classes).toContain('tag-ink');
    expect(phone.classes).toContain('tag-ink');
  });
});

describe('one channel proven', () => {
  it('shows "Doğrulanmadı" for the other, in neutral grey and without a button', async () => {
    profile({ emailVerifiedAt: '2026-09-10T08:00:00.000Z', phoneVerifiedAt: null });
    const markup = await render();
    expect(badge(markup, 'email')).toMatchObject({ text: 'Doğrulandı', verified: true });
    const phone = badge(markup, 'phone');
    expect(phone).toMatchObject({ text: 'Doğrulanmadı', verified: false, ariaLabel: 'Telefon doğrulanmadı' });
    expect(phone.classes).toContain('tag-neutral');
    expect(phone.classes).not.toContain('tag-ink');
    expect(markup).not.toContain('Telefonu doğrula');
    expect(markup).not.toContain('Doğrulama kodu gönder');
    expect(markup.toLowerCase()).not.toContain('başarısız');
  });
});

describe('a legacy account', () => {
  it('reads null and a missing column alike as "Doğrulanmadı"', async () => {
    profile({});
    const markup = await render();
    expect(badge(markup, 'email')).toMatchObject({ text: 'Doğrulanmadı', verified: false });
    expect(badge(markup, 'phone')).toMatchObject({ text: 'Doğrulanmadı', verified: false });
  });

  it('never reads a request-level proof: only the account columns are looked at', async () => {
    // A profile answer carrying a stray request-style field is not proof.
    profile({ phoneVerifiedAt: null, requestPhoneVerifiedAt: '2026-09-12T09:30:00.000Z' });
    const markup = await render();
    expect(badge(markup, 'phone')).toMatchObject({ text: 'Doğrulanmadı', verified: false });
  });
});

describe('the profile read failing', () => {
  it('falls back to the session\'s own timestamps', async () => {
    routes['/account/profile'] = () => new Response('down', { status: 503 });
    routes['/auth/me'] = () =>
      Response.json({ ...CUSTOMER, emailVerifiedAt: null, phoneVerifiedAt: '2026-09-12T09:30:00.000Z' });
    const markup = await render();
    expect(badge(markup, 'email')).toMatchObject({ text: 'Doğrulanmadı', verified: false });
    expect(badge(markup, 'phone')).toMatchObject({ text: 'Doğrulandı', verified: true });
  });
});
