import { afterEach, describe, expect, it, vi } from 'vitest';

const incoming = new Headers({ 'x-forwarded-for': '203.0.113.7' });
vi.mock('next/headers', () => ({ headers: async () => incoming }));

const { readVerificationLink, resultFromSearchParams, submitEmailVerification } = await import(
  '../app/e-posta-dogrula/verify'
);

/**
 * The e-mail verification page reads its link, and only the button spends it
 * (STAGING-UAT-001 B3). `fetch` is a scripted API; the screens themselves are
 * driven by the end-to-end suite.
 */

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

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function form(token: string): FormData {
  const data = new FormData();
  data.set('token', token);
  return data;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('reading the link (the page, on every open)', () => {
  it('only ever GETs — opening the page never calls confirm', async () => {
    const calls = apiAnswers(json(200, { status: 'VALID', accountKind: 'PROVIDER' }));

    expect(await readVerificationLink('tok')).toEqual({ kind: 'ready', accountKind: 'PROVIDER' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/auth\/email-verification\?token=tok$/);
    expect(calls[0]!.init?.method ?? 'GET').toBe('GET');
  });

  it.each([
    [{ code: 'EMAIL_VERIFICATION_ALREADY_VERIFIED', accountKind: 'PROVIDER' }, { kind: 'already', accountKind: 'PROVIDER' }],
    [{ code: 'EMAIL_VERIFICATION_EXPIRED', accountKind: 'CUSTOMER' }, { kind: 'expired', accountKind: 'CUSTOMER' }],
    [{ code: 'EMAIL_VERIFICATION_INVALID' }, { kind: 'invalid' }],
    [{ message: 'Token is required' }, { kind: 'invalid' }],
  ])('maps the refusal %j', async (body, state) => {
    apiAnswers(json(400, body));
    expect(await readVerificationLink('tok')).toEqual(state);
  });

  it('reads a throttle or an outage as "try again", not as a dead link', async () => {
    apiAnswers(json(429, { message: 'Too Many Requests' }));
    expect(await readVerificationLink('tok')).toEqual({ kind: 'failed' });

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    expect(await readVerificationLink('tok')).toEqual({ kind: 'failed' });
  });
});

describe('the button (POST /e-posta-dogrula/submit)', () => {
  it('spends the link with one POST and lands on a result word, never on the token', async () => {
    const calls = apiAnswers(json(201, { success: true, alreadyVerified: false, accountKind: 'PROVIDER' }));

    const location = await submitEmailVerification(form('gizli-token'));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/auth\/email-verification\/confirm$/);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ token: 'gizli-token' });
    expect(location).toBe('/e-posta-dogrula?sonuc=dogrulandi&hesap=hizmet-veren');
    expect(location).not.toContain('gizli-token');
  });

  it.each([
    [json(201, { success: true, alreadyVerified: true, accountKind: 'CUSTOMER' }), '/e-posta-dogrula?sonuc=zaten-dogrulanmis'],
    [json(400, { code: 'EMAIL_VERIFICATION_ALREADY_VERIFIED', accountKind: 'CUSTOMER' }), '/e-posta-dogrula?sonuc=zaten-dogrulanmis'],
    [json(400, { code: 'EMAIL_VERIFICATION_EXPIRED', accountKind: 'PROVIDER' }), '/e-posta-dogrula?sonuc=suresi-doldu&hesap=hizmet-veren'],
    [json(400, { code: 'EMAIL_VERIFICATION_INVALID' }), '/e-posta-dogrula?sonuc=gecersiz'],
    [json(500, {}), '/e-posta-dogrula?sonuc=tamamlanamadi'],
  ])('sends answer #%# to its result screen', async (response, location) => {
    apiAnswers(response);
    expect(await submitEmailVerification(form('tok'))).toBe(location);
  });

  it('calls nothing for an empty token', async () => {
    const calls = apiAnswers();
    expect(await submitEmailVerification(form('  '))).toBe('/e-posta-dogrula?sonuc=gecersiz');
    expect(calls).toHaveLength(0);
  });
});

describe("the reader's address", () => {
  it('is passed on to both calls behind a trusted edge, so readers do not share one auth budget', async () => {
    vi.stubEnv('WEB_TRUST_PROXY', 'true');
    const calls = apiAnswers(
      json(200, { status: 'VALID', accountKind: 'CUSTOMER' }),
      json(201, { success: true, alreadyVerified: false, accountKind: 'CUSTOMER' }),
    );

    await readVerificationLink('tok');
    await submitEmailVerification(form('tok'));

    for (const call of calls) {
      expect(new Headers(call.init?.headers).get('x-forwarded-for')).toBe('203.0.113.7');
    }
  });

  it('is not passed on without one', async () => {
    vi.stubEnv('WEB_TRUST_PROXY', 'false');
    const calls = apiAnswers(json(200, { status: 'VALID', accountKind: 'CUSTOMER' }));

    await readVerificationLink('tok');

    expect(new Headers(calls[0]!.init?.headers).get('x-forwarded-for')).toBeNull();
  });
});

describe('the result screen reads its own URL', () => {
  it('round-trips every result word', () => {
    expect(resultFromSearchParams({ sonuc: 'dogrulandi', hesap: 'hizmet-veren' })).toEqual({
      kind: 'verified',
      accountKind: 'PROVIDER',
    });
    expect(resultFromSearchParams({ sonuc: 'zaten-dogrulanmis' })).toEqual({ kind: 'already', accountKind: 'CUSTOMER' });
    expect(resultFromSearchParams({ sonuc: 'suresi-doldu' })).toEqual({ kind: 'expired', accountKind: 'CUSTOMER' });
    expect(resultFromSearchParams({ sonuc: 'gecersiz', hesap: 'hizmet-veren' })).toEqual({ kind: 'invalid' });
    expect(resultFromSearchParams({ sonuc: 'tamamlanamadi' })).toEqual({ kind: 'failed' });
  });

  it('ignores an unknown word, so the page falls back to reading the link', () => {
    expect(resultFromSearchParams({ sonuc: 'baska-bir-sey' })).toBeNull();
    expect(resultFromSearchParams({})).toBeNull();
  });
});
