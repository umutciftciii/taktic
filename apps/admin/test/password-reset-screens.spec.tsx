import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { middleware } from '../middleware';
import LoginPage from '../app/login/page';
import ForgotPasswordPage from '../app/sifre-unuttum/page';
import { requestPasswordReset } from '../app/sifre-unuttum/request-reset';
import ResetPasswordPage from '../app/sifre-sifirla/page';
import { confirmPasswordReset } from '../app/sifre-sifirla/confirm-reset';

/**
 * ADMIN-AUTH-001 — the panel's "Şifremi Unuttum" flow.
 *
 * The API owns the security properties (token hash, expiry, single use,
 * per-account budget, session revocation; apps/api/test/password-reset.spec.ts).
 * What is pinned here is what the panel adds on top: the screens are reachable
 * without a session, the request screen is not an enumeration oracle, and the
 * confirmation hands back no session.
 */

const ADMIN = 'http://admin.test';

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the reset screens are outside the session wall', () => {
  it('lets each screen and its form target through without a cookie', () => {
    for (const path of ['/sifre-unuttum', '/sifre-unuttum/submit', '/sifre-sifirla', '/sifre-sifirla/submit']) {
      expect(middleware(new NextRequest(`${ADMIN}${path}`)).headers.get('location'), path).toBeNull();
    }
  });

  it('opens nothing else under those paths', () => {
    for (const path of ['/sifre-unuttum/other', '/sifre-sifirla/submit/x', '/sifre']) {
      expect(middleware(new NextRequest(`${ADMIN}${path}`)).headers.get('location'), path).toBe(
        `${ADMIN}/login`,
      );
    }
  });
});

describe('the sign-in card', () => {
  it('links to the forgot-password screen', async () => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('href="/sifre-unuttum"');
    expect(html).toContain('Şifremi Unuttum');
  });
});

describe('asking for a link', () => {
  it('lands on the same confirmation whatever the API answers', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockResolvedValueOnce(jsonResponse(201, { status: 'accepted' }));
    expect(await requestPasswordReset(form({ email: 'ops@example.test' }))).toBe('/sifre-unuttum?sent=1');

    fetchMock.mockResolvedValueOnce(jsonResponse(429, { message: 'Too Many Requests' }));
    expect(await requestPasswordReset(form({ email: 'ops@example.test' }))).toBe('/sifre-unuttum?sent=1');

    fetchMock.mockRejectedValueOnce(new Error('connection refused'));
    expect(await requestPasswordReset(form({ email: 'ops@example.test' }))).toBe('/sifre-unuttum?sent=1');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/auth\/password-reset$/);
    expect(JSON.parse(String(init.body))).toEqual({ email: 'ops@example.test' });
  });

  it('does not call the API for an empty address, and never echoes the address', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await requestPasswordReset(form({ email: '   ' }))).toBe('/sifre-unuttum?sent=1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('words the confirmation so it is true for any address', async () => {
    const html = renderToStaticMarkup(
      await ForgotPasswordPage({ searchParams: Promise.resolve({ sent: '1' }) }),
    );
    expect(html).toContain('Bağlantı gönderildi');
    expect(html).toContain('aitse');
    expect(html).toContain('30 dakika');
  });

  it('renders the request form against its fixed route', async () => {
    const html = renderToStaticMarkup(await ForgotPasswordPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('action="/sifre-unuttum/submit"');
    expect(html).toContain('name="email"');
    expect(html).toContain('Sıfırlama Bağlantısı Gönder');
  });
});

describe('choosing a new password', () => {
  it('checks the staff rule and the match before calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await confirmPasswordReset(form({ token: '', password: 'x', passwordConfirm: 'x' }))).toBe(
      '/sifre-sifirla?error=invalid',
    );
    expect(
      await confirmPasswordReset(form({ token: 't1', password: 'short', passwordConfirm: 'short' })),
    ).toBe('/sifre-sifirla?token=t1&error=policy&rule=minLength');
    expect(
      await confirmPasswordReset(
        form({ token: 't1', password: 'Dort-mavi-kedi-bulutta-7', passwordConfirm: 'baska-bir-sey' }),
      ),
    ).toBe('/sifre-sifirla?token=t1&error=mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a refused link without repeating the API text, and sets no session on success', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockResolvedValueOnce(jsonResponse(400, { message: 'Bağlantı geçersiz veya süresi dolmuş.' }));
    expect(
      await confirmPasswordReset(form({ token: 't1', password: 'Dort-mavi-kedi-bulutta-7', passwordConfirm: 'Dort-mavi-kedi-bulutta-7' })),
    ).toBe('/sifre-sifirla?token=t1&error=submit');

    fetchMock.mockRejectedValueOnce(new Error('connection refused'));
    expect(
      await confirmPasswordReset(form({ token: 't1', password: 'Dort-mavi-kedi-bulutta-7', passwordConfirm: 'Dort-mavi-kedi-bulutta-7' })),
    ).toBe('/sifre-sifirla?token=t1&error=submit');

    // A Set-Cookie on the API answer is not re-issued: this module has no
    // cookie access at all, and the result is the success screen, not the panel.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'set-cookie': 'taktic_session=leak' },
      }),
    );
    expect(
      await confirmPasswordReset(form({ token: 't1', password: 'Dort-mavi-kedi-bulutta-7', passwordConfirm: 'Dort-mavi-kedi-bulutta-7' })),
    ).toBe('/sifre-sifirla?success=1');

    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toMatch(/\/auth\/password-reset\/confirm$/);
    expect(JSON.parse(String(init.body))).toEqual({ token: 't1', password: 'Dort-mavi-kedi-bulutta-7' });
  });

  it('renders the form for a live link, with the address and expiry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, { valid: true, email: 'ops@example.test', expiresAt: '2026-10-18T12:30:00.000Z' }),
      ),
    );

    const html = renderToStaticMarkup(
      await ResetPasswordPage({ searchParams: Promise.resolve({ token: 'live' }) }),
    );
    expect(html).toContain('Yeni şifre belirleyin');
    expect(html).toContain('ops@example.test');
    expect(html).toContain('action="/sifre-sifirla/submit"');
    expect(html).toContain('name="token" value="live"');
    expect(html).toContain('name="passwordConfirm"');
  });

  it('shows one message for every refused link and offers a new one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(400, { message: 'internal detail' })));

    const html = renderToStaticMarkup(
      await ResetPasswordPage({ searchParams: Promise.resolve({ token: 'spent' }) }),
    );
    expect(html).toContain('Bağlantı geçersiz');
    expect(html).toContain('Bağlantı geçersiz veya süresi dolmuş.');
    expect(html).not.toContain('internal detail');
    expect(html).toContain('href="/sifre-unuttum"');
  });

  it('says the other sessions were closed on success', async () => {
    const html = renderToStaticMarkup(
      await ResetPasswordPage({ searchParams: Promise.resolve({ success: '1' }) }),
    );
    expect(html).toContain('Şifreniz güncellendi');
    expect(html).toContain('tüm oturumlarınız kapatıldı');
    expect(html).toContain('href="/login"');
  });
});
