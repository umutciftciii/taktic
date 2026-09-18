import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The customer's own request page: the "Talep içeriği" block and the
 * one-time-code row.
 *
 * The block is read from `GET /service-requests/my/:id` — the owner's read,
 * 404 for everybody else — and shows a row per value the customer gave, no
 * row for an empty field, and nothing about who to call. The code row keeps
 * its two actions and its every state (nothing sent, sent, wrong code,
 * verified, refused, sending) while sharing one height class across the
 * three controls; that they line up in a browser at 320px and 1440px is the
 * end-to-end suite's claim.
 *
 * Rendered through the real `apiFetch` and `fetchOrNotFound`; only the
 * network, the cookies and the panel shell are stood in for.
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

vi.mock('../app/requests/customer-shell', () => ({
  CustomerShell: ({ children }: { children: unknown }) => children,
}));

const REQUEST_ID = 'cmfabcdefghijklmnopqrstuv';
const OWNER = {
  id: 'cmfownerownerownerownerow',
  role: 'CUSTOMER',
  name: 'Ayşe Yılmaz',
  email: 'ayse@example.test',
  phone: '+905000000001',
  isActive: true,
};

type Route = (path: string) => Response | Promise<Response>;
let routes: Record<string, Route>;
let calls: string[];

beforeEach(() => {
  calls = [];
  routes = {
    '/auth/me': () => Response.json(OWNER),
    [`/service-requests/${REQUEST_ID}/offers`]: () => Response.json([]),
    [`/service-requests/${REQUEST_ID}/matched-contact`]: () =>
      new Response('{"statusCode":403}', { status: 403 }),
    [`/service-requests/${REQUEST_ID}/review`]: () => new Response('down', { status: 503 }),
  };
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

function myRequest(extra: Record<string, unknown> = {}) {
  routes[`/service-requests/my/${REQUEST_ID}`] = () =>
    Response.json({
      id: REQUEST_ID,
      requestNumber: 'TR-2026-000123',
      status: 'APPROVED',
      customerName: OWNER.name,
      customerPhone: OWNER.phone,
      customerEmail: OWNER.email,
      city: 'İstanbul',
      district: 'Kadıköy',
      neighborhood: null,
      addressNote: null,
      budgetMin: null,
      budgetMax: null,
      description: null,
      preferredDate: null,
      preferredDateEnd: null,
      urgency: null,
      qualityScore: 70,
      qualityLabel: 'GOOD',
      phoneVerifiedAt: '2026-09-17T10:00:00.000Z',
      approvedAt: '2026-09-17T10:00:00.000Z',
      moderatedAt: null,
      expiredAt: null,
      submittedAt: '2026-09-17T10:00:00.000Z',
      offersCount: 0,
      category: { id: 'cat', name: 'Klima', slug: 'klima' },
      showcaseLead: null,
      answers: [],
      ...extra,
    });
}

async function render(verification: string | null = null): Promise<string> {
  const { default: RequestOffersPage } = await import('../app/requests/[id]/offers/page');
  const element = await RequestOffersPage({
    params: Promise.resolve({ id: REQUEST_ID }),
    searchParams: Promise.resolve(verification ? { verification } : {}),
  });
  return renderToStaticMarkup(element);
}

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `<div data-testid="request-content-<key>">…</div>` → its "label value" text, or null. */
function row(markup: string, key: string): string | null {
  const match = markup.match(
    new RegExp(`<div[^>]*data-testid="request-content-${key}"[^>]*>([\\s\\S]*?)</div>`),
  );
  return match ? textOf(match[1] ?? '') : null;
}

describe('a request with every field given', () => {
  it('lists each value under "Talep içeriği", the answers in words', async () => {
    myRequest({
      description: 'Salon kliması soğutmuyor.\nÖğleden sonra uygunum.',
      neighborhood: 'Caferağa Mah',
      addressNote: 'Kapıcıya haber verin',
      budgetMin: 150000,
      budgetMax: 250000,
      preferredDate: '2026-10-01T00:00:00.000Z',
      preferredDateEnd: '2026-10-05T00:00:00.000Z',
      urgency: 'FLEXIBLE',
      answers: [
        { questionKey: 'klima_tipi', questionLabel: 'Klima tipi', questionType: 'SELECT', value: 'salon', displayValue: 'Salon tipi' },
        { questionKey: 'ek_hizmet', questionLabel: 'Ek hizmetler', questionType: 'MULTI_SELECT', value: ['gaz', 'temizlik'], displayValue: 'Gaz dolumu, İç ünite temizliği' },
      ],
    });
    const markup = await render();
    expect(markup).toContain('data-testid="request-content"');
    expect(textOf(markup)).toContain('Talep içeriği');
    expect(row(markup, 'description')).toBe('Açıklama Salon kliması soğutmuyor. Öğleden sonra uygunum.');
    expect(row(markup, 'answer-klima_tipi')).toBe('Klima tipi Salon tipi');
    expect(row(markup, 'answer-ek_hizmet')).toBe('Ek hizmetler Gaz dolumu, İç ünite temizliği');
    expect(row(markup, 'location')).toBe('Konum İstanbul, Kadıköy, Caferağa Mah');
    expect(row(markup, 'address-note')).toBe('Adres notu Kapıcıya haber verin');
    expect(row(markup, 'preferred-date')).toMatch(/^Tercih edilen tarih 0?1 Eki 2026 – 0?5 Eki 2026$/);
    expect(row(markup, 'budget')).toBe('Bütçe ₺1.500,00 - ₺2.500,00');
    expect(row(markup, 'urgency')).toBe('Aciliyet Esnek');
    // The option key never reaches the screen.
    expect(markup).not.toMatch(/>salon</);
    // Read from the owner's own detail, not from the list.
    expect(calls).toContain(`/service-requests/my/${REQUEST_ID}`);
    expect(calls).not.toContain('/service-requests/my');
  });

  it('keeps the phone, the e-mail and the contact name out of the block', async () => {
    myRequest({ description: 'Açıklama', customerName: 'Mehmet Alternatif', customerEmail: 'alt@example.test' });
    const markup = await render();
    const block = markup.match(/<section[^>]*data-testid="request-content"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '';
    expect(block).not.toBe('');
    expect(block).not.toContain(OWNER.phone);
    expect(block).not.toContain('5000000001');
    expect(block).not.toContain('alt@example.test');
    expect(block).not.toContain('Mehmet Alternatif');
  });
});

describe('a request with the optional fields empty', () => {
  it('shows the location and nothing invented for the rest', async () => {
    myRequest();
    const markup = await render();
    expect(row(markup, 'location')).toBe('Konum İstanbul, Kadıköy');
    for (const key of ['description', 'address-note', 'preferred-date', 'budget', 'urgency']) {
      expect(row(markup, key), key).toBeNull();
    }
    expect(markup).not.toContain('data-testid="request-content-answer-');
    const text = textOf(markup);
    expect(text).not.toContain('Belirtilmedi');
    expect(text).not.toContain('Açıklama -');
  });
});

describe('the summary read failing', () => {
  it('renders the page without the block rather than as an error', async () => {
    routes[`/service-requests/my/${REQUEST_ID}`] = () => new Response('down', { status: 503 });
    const markup = await render();
    expect(markup).not.toContain('data-testid="request-content"');
    expect(markup).toContain('data-testid="request-summary-body"');
  });
});

describe('somebody else\'s request', () => {
  it('is the not-found screen, and the detail is never asked for', async () => {
    routes[`/service-requests/${REQUEST_ID}/offers`] = () =>
      new Response('{"statusCode":403}', { status: 403 });
    routes[`/service-requests/my/${REQUEST_ID}`] = () =>
      new Response('{"statusCode":404}', { status: 404 });
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('sends a provider to sign in as a customer instead', async () => {
    routes['/auth/me'] = () => Response.json({ ...OWNER, role: 'PROVIDER' });
    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);
    expect(calls).not.toContain(`/service-requests/my/${REQUEST_ID}`);
  });
});

/** The controls row: its two buttons, the field, and the height class they share. */
function controls(markup: string) {
  const rowMarkup =
    markup.match(/<div[^>]*data-testid="phone-verification-controls"[^>]*>(.*?)<\/div>/)?.[1] ?? '';
  const buttons = [...rowMarkup.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((match) => ({
    attrs: match[1],
    text: match[2],
  }));
  const input = rowMarkup.match(/<input[^>]*name="code"[^>]*>/)?.[0] ?? '';
  return { rowMarkup, buttons, input };
}

describe('the one-time-code row', () => {
  it('has the send button, the code field and the verify button in one height class', async () => {
    myRequest({ phoneVerifiedAt: null, awaitingPhoneVerification: false });
    const markup = await render();
    const { buttons, input } = controls(markup);
    expect(buttons.map((button) => button.text)).toEqual(['Doğrulama kodu gönder', 'Doğrula']);
    for (const button of buttons) {
      expect(button.attrs, button.text).toMatch(/class="[^"]*\botp-control\b/);
    }
    expect(input).toMatch(/class="[^"]*\botp-control\b/);
    expect(input).toContain('inputMode="numeric"');
    expect(input).toContain('autoComplete="one-time-code"');
    expect(input).toContain('maxLength="6"');
    expect(input).not.toContain('style=');
    expect(markup).toContain('<label class="cdash-visually-hidden" for="phone-code">');
  });

  it.each([
    ['nothing sent yet', null, null],
    ['a code sent', 'ok', 'Kod gönderildiyse birkaç dakika içinde ulaşır'],
    ['a wrong code', 'invalid', 'Kod geçersiz veya süresi dolmuş'],
    ['too many codes', 'rate-limited', 'Çok fazla kod istendi'],
    ['already verified', 'already-verified', 'zaten doğrulanmış'],
    ['the challenge refused', 'challenge-failed', 'Güvenlik doğrulaması başarısız'],
  ])('keeps both actions with %s', async (_label, state, message) => {
    myRequest({ phoneVerifiedAt: null });
    const markup = await render(state);
    const { buttons } = controls(markup);
    expect(buttons.map((button) => button.text)).toEqual(['Doğrulama kodu gönder', 'Doğrula']);
    if (message) {
      expect(textOf(markup)).toContain(message);
    } else {
      expect(markup).not.toContain('data-testid="phone-verification-message"');
    }
  });

  it('marks the field invalid after a wrong code, and only then', async () => {
    myRequest({ phoneVerifiedAt: null });
    expect(controls(await render('invalid')).input).toContain('aria-invalid="true"');
    expect(controls(await render('ok')).input).not.toContain('aria-invalid');
    expect(controls(await render()).input).not.toContain('aria-invalid');
  });

  it('is disabled for sending while the challenge is unconfigured, and absent once verified', async () => {
    myRequest({ phoneVerifiedAt: null });
    // No APP_ENVIRONMENT / TURNSTILE_MODE in a unit test: the widget is
    // unconfigured, so the send is disabled — the state the card must survive.
    const { buttons } = controls(await render());
    expect(buttons[0]?.attrs).toContain('disabled=""');
    expect(buttons[1]?.attrs).not.toContain('disabled');

    myRequest({ phoneVerifiedAt: '2026-09-17T10:00:00.000Z' });
    expect(await render()).not.toContain('data-testid="phone-verification-controls"');
  });
});
