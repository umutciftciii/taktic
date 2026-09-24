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

  it.each([
    [401, 'a wrong password'],
    [429, 'the API rate limit'],
    [500, 'an API failure'],
  ])('answers %i (%s) with the form’s own error and writes no cookie', async (status) => {
    apiAnswers(json(status, { message: 'nope' }));

    await expect(signIn(form({ email: 'a', password: 'b', redirectTo: '/account/profile' }))).resolves.toBe(
      '/login?error=1&redirectTo=%2Faccount%2Fprofile',
    );
    expect(jar.size).toBe(0);
  });
});

describe('changePassword', () => {
  it('maps the API rate limit to its own message code', async () => {
    apiAnswers(json(429, { message: 'Too Many Requests' }));

    await expect(
      changePassword(form({ currentPassword: 'OldPass123!', password: 'NewPass456!', passwordConfirm: 'NewPass456!' })),
    ).resolves.toBe('/account/password?error=throttled');
  });

  it('refuses a mismatch before calling the API', async () => {
    const calls = apiAnswers();

    await expect(
      changePassword(form({ currentPassword: 'OldPass123!', password: 'NewPass456!', passwordConfirm: 'Other456!' })),
    ).resolves.toBe('/account/password?error=mismatch');
    expect(calls).toHaveLength(0);
  });
});

describe('registerCustomer', () => {
  it('turns ACTIVATION_REQUIRED into the activation notice', async () => {
    apiAnswers(json(409, { code: 'ACTIVATION_REQUIRED' }));

    await expect(registerCustomer(form({ name: 'A', email: 'a@b.c', password: 'Password123!' }))).resolves.toBe(
      '/register/customer?notice=activation-sent',
    );
    expect(jar.size).toBe(0);
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
