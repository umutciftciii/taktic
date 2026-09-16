import { describe, expect, it, vi } from 'vitest';
import { CloudflareTurnstileVerifier } from '../src/modules/turnstile/cloudflare-turnstile.verifier';
import { TestTurnstileVerifier } from '../src/modules/turnstile/test-turnstile.verifier';
import { TurnstileReplayCache } from '../src/modules/turnstile/turnstile-replay.cache';
import { TURNSTILE_ACTIONS } from '../src/modules/turnstile/turnstile.constants';

/**
 * The verifier behind the guard, with Cloudflare stood in for by a fetch stub
 * so the exact request this process would make — and the exact answers it
 * accepts — are asserted on without a byte leaving the test.
 */
const SECRET = 'not-a-real-secret-0xabcdef';
const HOSTNAMES = new Set(['taktick.example', 'www.taktick.example']);
const ACTION = TURNSTILE_ACTIONS.serviceRequestCreate;

type StubCall = { url: string; init: RequestInit };

function stubFetch(
  answer: (call: StubCall) => Promise<Response> | Response,
): { fetch: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function verifier(fetchImpl: typeof fetch, timeoutMs = 5000) {
  return new CloudflareTurnstileVerifier(
    { mode: 'cloudflare', secretKey: SECRET, expectedHostnames: HOSTNAMES, siteverifyTimeoutMs: timeoutMs },
    fetchImpl,
  );
}

const okBody = {
  success: true,
  challenge_ts: '2026-09-16T10:00:00.000Z',
  hostname: 'taktick.example',
  'error-codes': [],
  action: ACTION,
};

describe('CloudflareTurnstileVerifier — the request', () => {
  it('posts secret, response and remoteip form-encoded to siteverify', async () => {
    const stub = stubFetch(() => jsonResponse(okBody));
    const verdict = await verifier(stub.fetch).verify({ token: 'tok-1', action: ACTION, remoteIp: '203.0.113.9' });

    expect(verdict).toEqual({ ok: true });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(stub.calls[0]?.init.method).toBe('POST');
    const body = new URLSearchParams(String(stub.calls[0]?.init.body));
    expect(body.get('secret')).toBe(SECRET);
    expect(body.get('response')).toBe('tok-1');
    expect(body.get('remoteip')).toBe('203.0.113.9');
  });

  it('omits remoteip when the address is unknown', async () => {
    const stub = stubFetch(() => jsonResponse(okBody));
    await verifier(stub.fetch).verify({ token: 'tok-1', action: ACTION, remoteIp: null });
    expect(new URLSearchParams(String(stub.calls[0]?.init.body)).has('remoteip')).toBe(false);
  });

  it('answers TOKEN_MISSING without calling Cloudflare for an absent or blank token', async () => {
    const stub = stubFetch(() => jsonResponse(okBody));
    const subject = verifier(stub.fetch);
    expect(await subject.verify({ token: null, action: ACTION, remoteIp: null })).toEqual({ ok: false, reason: 'TOKEN_MISSING' });
    expect(await subject.verify({ token: '   ', action: ACTION, remoteIp: null })).toEqual({ ok: false, reason: 'TOKEN_MISSING' });
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses a token longer than Turnstile ever issues without calling Cloudflare', async () => {
    const stub = stubFetch(() => jsonResponse(okBody));
    const verdict = await verifier(stub.fetch).verify({ token: 'x'.repeat(2049), action: ACTION, remoteIp: null });
    expect(verdict).toEqual({ ok: false, reason: 'TOKEN_INVALID' });
    expect(stub.calls).toHaveLength(0);
  });
});

describe('CloudflareTurnstileVerifier — the answer', () => {
  it('accepts success on an expected hostname, case-insensitively, with the expected action', async () => {
    const stub = stubFetch(() => jsonResponse({ ...okBody, hostname: 'WWW.Taktick.example' }));
    expect(await verifier(stub.fetch).verify({ token: 't', action: ACTION, remoteIp: null })).toEqual({ ok: true });
  });

  it('refuses success: false with the error codes as TOKEN_INVALID', async () => {
    const stub = stubFetch(() => jsonResponse({ success: false, 'error-codes': ['timeout-or-duplicate'] }));
    expect(await verifier(stub.fetch).verify({ token: 't', action: ACTION, remoteIp: null })).toEqual({
      ok: false,
      reason: 'TOKEN_INVALID',
    });
  });

  it('refuses a token solved on another hostname', async () => {
    const stub = stubFetch(() => jsonResponse({ ...okBody, hostname: 'evil.example' }));
    expect(await verifier(stub.fetch).verify({ token: 't', action: ACTION, remoteIp: null })).toEqual({
      ok: false,
      reason: 'HOSTNAME_MISMATCH',
    });
  });

  it('refuses a success that names no hostname at all', async () => {
    const { hostname: _dropped, ...withoutHostname } = okBody;
    const stub = stubFetch(() => jsonResponse(withoutHostname));
    expect(await verifier(stub.fetch).verify({ token: 't', action: ACTION, remoteIp: null })).toEqual({
      ok: false,
      reason: 'HOSTNAME_MISMATCH',
    });
  });

  it('refuses a token minted for another action, and one minted for none', async () => {
    const other = stubFetch(() => jsonResponse({ ...okBody, action: TURNSTILE_ACTIONS.identityCheck }));
    expect(await verifier(other.fetch).verify({ token: 't', action: ACTION, remoteIp: null })).toEqual({
      ok: false,
      reason: 'ACTION_MISMATCH',
    });
    const { action: _dropped, ...withoutAction } = okBody;
    const none = stubFetch(() => jsonResponse(withoutAction));
    expect(await verifier(none.fetch).verify({ token: 't', action: ACTION, remoteIp: null })).toEqual({
      ok: false,
      reason: 'ACTION_MISMATCH',
    });
  });

  it('is VERIFIER_UNAVAILABLE on a 5xx, on a body that is not JSON, and on a body that is not an object', async () => {
    const five = stubFetch(() => new Response('upstream error', { status: 502 }));
    expect(await verifier(five.fetch).verify({ token: 't', action: ACTION, remoteIp: null })).toEqual({
      ok: false,
      reason: 'VERIFIER_UNAVAILABLE',
    });
    const html = stubFetch(() => new Response('<html>', { status: 200 }));
    expect(await verifier(html.fetch).verify({ token: 't', action: ACTION, remoteIp: null })).toEqual({
      ok: false,
      reason: 'VERIFIER_UNAVAILABLE',
    });
    const list = stubFetch(() => jsonResponse([true]));
    expect(await verifier(list.fetch).verify({ token: 't', action: ACTION, remoteIp: null })).toEqual({
      ok: false,
      reason: 'VERIFIER_UNAVAILABLE',
    });
  });

  it('is VERIFIER_UNAVAILABLE when fetch itself fails', async () => {
    const stub = stubFetch(() => Promise.reject(new Error('ECONNRESET')));
    expect(await verifier(stub.fetch).verify({ token: 't', action: ACTION, remoteIp: null })).toEqual({
      ok: false,
      reason: 'VERIFIER_UNAVAILABLE',
    });
  });

  it('aborts and is VERIFIER_UNAVAILABLE once the timeout passes', async () => {
    vi.useFakeTimers();
    try {
      const stub = stubFetch(
        ({ init }) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      );
      const pending = verifier(stub.fetch, 1000).verify({ token: 't', action: ACTION, remoteIp: null });
      await vi.advanceTimersByTimeAsync(1001);
      expect(await pending).toEqual({ ok: false, reason: 'VERIFIER_UNAVAILABLE' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs the reason and the error codes, never the token or the secret', async () => {
    const warn = vi.fn();
    const stub = stubFetch(() => jsonResponse({ success: false, 'error-codes': ['invalid-input-response'] }));
    const subject = new CloudflareTurnstileVerifier(
      { mode: 'cloudflare', secretKey: SECRET, expectedHostnames: HOSTNAMES, siteverifyTimeoutMs: 5000 },
      stub.fetch,
      { warn },
    );
    await subject.verify({ token: 'tok-secretish-value', action: ACTION, remoteIp: null });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('invalid-input-response');
    expect(line).not.toContain('tok-secretish-value');
    expect(line).not.toContain(SECRET);
  });
});

describe('TestTurnstileVerifier', () => {
  const subject = new TestTurnstileVerifier();

  it('accepts the deterministic token for the expected action', async () => {
    expect(await subject.verify({ token: `turnstile-test:${ACTION}:n1`, action: ACTION, remoteIp: null })).toEqual({ ok: true });
  });

  it('refuses a missing token, a foreign token, and a token for another action', async () => {
    expect(await subject.verify({ token: null, action: ACTION, remoteIp: null })).toEqual({ ok: false, reason: 'TOKEN_MISSING' });
    expect(await subject.verify({ token: 'real-looking-token', action: ACTION, remoteIp: null })).toEqual({ ok: false, reason: 'TOKEN_INVALID' });
    expect(
      await subject.verify({ token: `turnstile-test:${TURNSTILE_ACTIONS.identityCheck}:n1`, action: ACTION, remoteIp: null }),
    ).toEqual({ ok: false, reason: 'ACTION_MISMATCH' });
  });

  it('simulates an unreachable Cloudflare for the browser suite', async () => {
    expect(await subject.verify({ token: 'turnstile-test:__unavailable__:n1', action: ACTION, remoteIp: null })).toEqual({
      ok: false,
      reason: 'VERIFIER_UNAVAILABLE',
    });
  });
});

describe('TurnstileReplayCache', () => {
  it('claims a token once and refuses it the second time, within the TTL', () => {
    const cache = new TurnstileReplayCache(60_000);
    expect(cache.claim('tok-a', 1_000)).toBe(true);
    expect(cache.claim('tok-a', 2_000)).toBe(false);
    expect(cache.claim('tok-b', 2_000)).toBe(true);
  });

  it('forgets a token once its TTL has passed', () => {
    const cache = new TurnstileReplayCache(1_000);
    expect(cache.claim('tok-a', 0)).toBe(true);
    expect(cache.claim('tok-a', 1_001)).toBe(true);
  });

  it('keeps digests, not tokens', () => {
    const cache = new TurnstileReplayCache(60_000);
    cache.claim('tok-plain-text', 0);
    expect(JSON.stringify([...cache.entries()])).not.toContain('tok-plain-text');
  });
});
