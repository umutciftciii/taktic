import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The auth form submissions that moved from Server Actions to fixed route
 * handlers (BUG-AUTH-STALE-ACTION-001), checked for the one thing the move
 * could have changed: which screen each API answer sends the browser to, and
 * whether a session cookie is written.
 *
 * `next/headers` is replaced by an in-memory cookie jar, and `fetch` by a
 * scripted API. The route handler itself — origin check, `303`, open-redirect
 * guard — is @taktic/shared's form-post and has its own spec.
 */

const jar = new Map<string, { value: string; options: unknown }>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    set: (name: string, value: string, options: unknown) => jar.set(name, { value, options }),
    delete: (name: string) => jar.delete(name),
    toString: () => [...jar].map(([name, { value }]) => `${name}=${value}`).join('; '),
  }),
  headers: async () => new Headers(),
}));

const { signIn } = await import('../app/login/sign-in');
const { changePassword } = await import('../app/account/change-password');
const { registerCustomer } = await import('../app/register/register');
const { requestPasswordReset } = await import('../app/sifre-unuttum/request-reset');
const { POST: logout } = await import('../app/logout/route');
const { POST: loginRoute } = await import('../app/login/submit/route');

const SESSION_SET_COOKIE = 'taktic_session=abc123; Path=/; HttpOnly; SameSite=Lax';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function apiAnswers(...responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected API call to ${url}`);
      return next;
    }),
  );
  return calls;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(() => jar.clear());
afterEach(() => vi.unstubAllGlobals());

describe('signIn', () => {
  it('sends a customer to their requests and re-issues the session cookie', async () => {
    const calls = apiAnswers(json(200, { id: 'u1', role: 'CUSTOMER' }, { 'set-cookie': SESSION_SET_COOKIE }));

    await expect(signIn(form({ email: 'a@b.c', password: 'pw', rememberMe: 'true' }))).resolves.toBe(
      '/requests/my',
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ email: 'a@b.c', password: 'pw', rememberMe: true });
    expect(jar.get('taktic_session')?.value).toBe('abc123');
  });

  it('follows a safe redirectTo and drops an unsafe one', async () => {
    apiAnswers(json(200, { id: 'u1', role: 'CUSTOMER' }, { 'set-cookie': SESSION_SET_COOKIE }));
    await expect(signIn(form({ email: 'a', password: 'b', redirectTo: '/account/profile' }))).resolves.toBe(
      '/account/profile',
    );

    apiAnswers(json(200, { id: 'u1', role: 'CUSTOMER' }, { 'set-cookie': SESSION_SET_COOKIE }));
    await expect(signIn(form({ email: 'a', password: 'b', redirectTo: '//evil.example' }))).resolves.toBe(
      '/requests/my',
    );
  });

  it.each<[number, Record<string, string>, string, string]>([
    [401, { code: 'INVALID_CREDENTIALS' }, '1', 'a wrong password or an unknown e-mail'],
    [403, { message: 'User is inactive' }, '1', 'an inactive account'],
    [500, { message: 'nope' }, '1', 'an API failure'],
    [429, { code: 'AUTH_TEMPORARILY_LOCKED' }, 'locked', 'the account lock'],
    [429, { message: 'ThrottlerException: Too Many Requests' }, 'locked', 'the address throttle'],
    [403, { code: 'TURNSTILE_REQUIRED' }, 'verification', 'a missing Turnstile token'],
    [403, { code: 'TURNSTILE_FAILED' }, 'verification', 'a refused Turnstile token'],
    [503, { code: 'TURNSTILE_UNAVAILABLE' }, 'verification-unavailable', 'an unreachable Cloudflare'],
  ])('answers %i %j with error=%s (%s) and writes no cookie', async (status, body, error) => {
    apiAnswers(json(status, body));

    await expect(signIn(form({ email: 'a', password: 'b', redirectTo: '/account/profile' }))).resolves.toBe(
      `/login?error=${error}&redirectTo=%2Faccount%2Fprofile`,
    );
    expect(jar.size).toBe(0);
  });

  it('carries the form’s Turnstile token in the one header the API reads, never in the body', async () => {
    const calls = apiAnswers(json(200, { id: 'u1', role: 'CUSTOMER' }, { 'set-cookie': SESSION_SET_COOKIE }));

    await signIn(form({ email: 'a@b.c', password: 'pw', turnstileToken: ' turnstile-test:login:n1 ' }));

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('x-turnstile-token')).toBe('turnstile-test:login:n1');
    expect(String(calls[0]?.init?.body)).not.toContain('turnstile');
  });

  it('sends no token header when the form carried none, so the API answers TURNSTILE_REQUIRED', async () => {
    const calls = apiAnswers(json(403, { code: 'TURNSTILE_REQUIRED' }));

    await expect(signIn(form({ email: 'a@b.c', password: 'pw' }))).resolves.toBe('/login?error=verification');
    expect(new Headers(calls[0]?.init?.headers).has('x-turnstile-token')).toBe(false);
  });
});

describe('changePassword', () => {
  it('maps the API rate limit to its own message code', async () => {
    apiAnswers(json(429, { message: 'Too Many Requests' }));

    await expect(
      changePassword(form({ currentPassword: 'fixture-current-value', password: 'fixture-new-value-1', passwordConfirm: 'fixture-new-value-1' })),
    ).resolves.toBe('/account/password?error=throttled');
  });

  it('refuses a mismatch before calling the API', async () => {
    const calls = apiAnswers();

    await expect(
      changePassword(form({ currentPassword: 'fixture-current-value', password: 'fixture-new-value-1', passwordConfirm: 'fixture-new-value-2' })),
    ).resolves.toBe('/account/password?error=mismatch');
    expect(calls).toHaveLength(0);
  });
});

describe('registerCustomer', () => {
  it('turns ACTIVATION_REQUIRED into the activation notice', async () => {
    apiAnswers(json(409, { code: 'ACTIVATION_REQUIRED' }));

    await expect(registerCustomer(form({ name: 'A', email: 'a@b.c', password: 'fixture-new-value-1' }))).resolves.toBe(
      '/register/customer?notice=activation-sent',
    );
    expect(jar.size).toBe(0);
  });

  it('carries the token and maps the security refusals before reading any conflict', async () => {
    const calls = apiAnswers(json(403, { code: 'TURNSTILE_FAILED' }));
    await expect(
      registerCustomer(form({ name: 'A', email: 'a@b.c', password: 'fixture-new-value-1', turnstileToken: 'tok-1' })),
    ).resolves.toBe('/register/customer?error=verification');
    expect(new Headers(calls[0]?.init?.headers).get('x-turnstile-token')).toBe('tok-1');

    apiAnswers(json(429, { message: 'Too Many Requests' }));
    await expect(registerCustomer(form({ name: 'A', email: 'a@b.c', password: 'fixture-new-value-1' }))).resolves.toBe(
      '/register/customer?error=locked',
    );
  });
});

describe('requestPasswordReset', () => {
  it('lands on the same "sent" screen for every answer that concerns the address', async () => {
    for (const response of [json(201, { status: 'accepted' }), json(500, { message: 'x' })]) {
      apiAnswers(response);
      await expect(requestPasswordReset(form({ email: 'a@b.c', turnstileToken: 'tok' }))).resolves.toBe('/sifre-unuttum?sent=1');
    }
  });

  it('says the check failed instead of claiming a mail that was never asked for', async () => {
    const calls = apiAnswers(json(403, { code: 'TURNSTILE_REQUIRED' }));
    await expect(requestPasswordReset(form({ email: 'a@b.c' }))).resolves.toBe('/sifre-unuttum?error=verification');
    expect(new Headers(calls[0]?.init?.headers).has('x-turnstile-token')).toBe(false);

    apiAnswers(json(503, { code: 'TURNSTILE_UNAVAILABLE' }));
    await expect(requestPasswordReset(form({ email: 'a@b.c', turnstileToken: 'tok' }))).resolves.toBe(
      '/sifre-unuttum?error=verification-unavailable',
    );
  });
});

describe('the route handlers', () => {
  it('sign-in answers 303 to the chosen screen with the cookie on the response', async () => {
    apiAnswers(json(200, { id: 'u1', role: 'CUSTOMER' }, { 'set-cookie': SESSION_SET_COOKIE }));

    const response = await loginRoute(
      new Request('http://localhost:3000/login/submit', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
        body: form({ email: 'a', password: 'b' }),
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/requests/my');
  });

  it('sign-out revokes on the API, drops the cookie, and lands on one of two fixed screens', async () => {
    for (const [after, expected] of [
      ['home', '/'],
      ['login', '/login'],
      ['https://evil.example', '/login'],
    ] as const) {
      jar.set('taktic_session', { value: 'abc123', options: {} });
      const calls = apiAnswers(new Response(null, { status: 204 }));

      const response = await logout(
        new Request('http://localhost:3000/logout', {
          method: 'POST',
          headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
          body: form({ after }),
        }),
      );

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(expected);
      expect(calls[0]?.url).toMatch(/\/auth\/logout$/);
      expect(jar.has('taktic_session')).toBe(false);
    }
  });

  it('sign-out from another origin does nothing at all', async () => {
    jar.set('taktic_session', { value: 'abc123', options: {} });
    const calls = apiAnswers();

    const response = await logout(
      new Request('http://localhost:3000/logout', {
        method: 'POST',
        headers: { origin: 'https://evil.example', host: 'localhost:3000' },
        body: form({}),
      }),
    );

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(jar.has('taktic_session')).toBe(true);
  });
});
