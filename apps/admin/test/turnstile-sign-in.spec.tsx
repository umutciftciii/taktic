import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as shared from '@taktic/shared';
import * as adminTurnstile from '../lib/turnstile';
import { forwardedForHeaders } from '../lib/forwarded-for';

/**
 * SEC-AUTH-ABUSE-001 in the admin panel: the sign-in and password-reset cards
 * carry a Turnstile token the same way the web's do, under the same rules —
 * not a copy of them, the same functions — and the refusal sentences say
 * nothing about whether an operator account exists.
 */

const requestHeaders = new Headers();
vi.mock('next/headers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/headers')>()),
  headers: async () => requestHeaders,
  cookies: async () => ({ set: () => undefined, delete: () => undefined, get: () => undefined }),
}));

const { signIn } = await import('../app/login/sign-in');
const { default: LoginPage } = await import('../app/login/page');
const { default: ForgotPasswordPage } = await import('../app/sifre-unuttum/page');

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('one contract for the web and the panel', () => {
  it('reads Turnstile through the very functions the web reads', () => {
    expect(adminTurnstile.readTurnstileWebConfig).toBe(shared.readTurnstileWebConfig);
    expect(adminTurnstile.credentialRefusalOf).toBe(shared.credentialRefusalOf);
    expect(adminTurnstile.turnstileHeaders).toBe(shared.turnstileHeaders);
    expect(adminTurnstile.TURNSTILE_ACTIONS).toBe(shared.TURNSTILE_ACTIONS);
  });

  it('renders closed — not open — on a deployed panel without a site key', () => {
    expect(adminTurnstile.readTurnstileWebConfig({ APP_ENVIRONMENT: 'staging' })).toEqual({ mode: 'unconfigured' });
    expect(adminTurnstile.readTurnstileWebConfig({ APP_ENVIRONMENT: 'staging', TURNSTILE_MODE: 'off' })).toEqual({
      mode: 'unconfigured',
    });
    expect(adminTurnstile.readTurnstileWebConfig({ APP_ENVIRONMENT: 'local' })).toEqual({ mode: 'test' });
  });
});

describe('the sign-in submission', () => {
  it('carries the form token in its header and nowhere else', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(401, { code: 'INVALID_CREDENTIALS' }));
    vi.stubGlobal('fetch', fetchMock);

    await signIn(form({ email: 'ops@example.test', password: 'pw', turnstileToken: 'turnstile-test:login:n1' }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('x-turnstile-token')).toBe('turnstile-test:login:n1');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'ops@example.test', password: 'pw', rememberMe: false });
  });

  it.each([
    [401, { code: 'INVALID_CREDENTIALS' }, '/login?error=1'],
    [403, { message: 'User is inactive' }, '/login?error=1'],
    [429, { code: 'AUTH_TEMPORARILY_LOCKED' }, '/login?error=locked'],
    [403, { code: 'TURNSTILE_FAILED' }, '/login?error=verification'],
    [503, { code: 'TURNSTILE_UNAVAILABLE' }, '/login?error=verification-unavailable'],
  ])('%i %j → %s', async (status, body, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(status, body)));
    expect(await signIn(form({ email: 'ops@example.test', password: 'pw' }))).toBe(expected);
  });

  it('forwards the operator address only where WEB_TRUST_PROXY says the edge is trusted', () => {
    expect(forwardedForHeaders('198.51.100.4', false)).toEqual({});
    expect(forwardedForHeaders('198.51.100.4', true)).toEqual({ 'x-forwarded-for': '198.51.100.4' });
  });
});

describe('the cards', () => {
  it('the sign-in card posts to its fixed URL with the token field and the widget slot', async () => {
    vi.stubEnv('APP_ENVIRONMENT', 'local');
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(html).toMatch(/<form[^>]*action="\/login\/submit"[^>]*method="post"/);
    expect(html).toContain('name="turnstileToken"');
    expect(html).toContain('data-turnstile-action="login"');
    expect(html).toContain('data-testid="turnstile-slot"');
  });

  it('the reset card carries the password-reset action', async () => {
    vi.stubEnv('APP_ENVIRONMENT', 'local');
    const html = renderToStaticMarkup(await ForgotPasswordPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-turnstile-action="password-reset"');
  });

  it('a deployed panel without a site key says the check cannot run', async () => {
    vi.stubEnv('APP_ENVIRONMENT', 'production');
    vi.stubEnv('TURNSTILE_SITE_KEY', '');
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-testid="turnstile-unconfigured"');
  });

  it.each(['locked', 'verification', 'verification-unavailable', '1'])(
    'error=%s reads the same whoever the address belongs to',
    async (error) => {
      const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ error }) }));
      expect(html).not.toMatch(/bulunamad|kayıtlı değil|hesap yok/i);
    },
  );
});
