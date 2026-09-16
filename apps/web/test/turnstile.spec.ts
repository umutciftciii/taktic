import { describe, expect, it } from 'vitest';
import {
  TURNSTILE_ACTIONS,
  TURNSTILE_TOKEN_HEADER,
  isTurnstileRefusalCode,
  readTurnstileWebConfig,
  resolveTestTurnstileToken,
  turnstileHeaders,
} from '../lib/turnstile';

/**
 * What the web decides for itself about Turnstile — which is deliberately
 * little. The site key is public and read at request time, never baked in at
 * build; the two bypass modes are accepted only on a declared local stack;
 * and the token travels in exactly one header and nowhere else.
 */
const SITE_KEY = '0x4AAAAAAA-not-a-real-site-key';

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...values } as NodeJS.ProcessEnv;
}

describe('readTurnstileWebConfig', () => {
  it('is the test adapter with nothing set on a declared local stack — what the compose passes', () => {
    expect(readTurnstileWebConfig(env({ NODE_ENV: 'production', APP_ENVIRONMENT: 'local' }))).toEqual({ mode: 'test' });
    expect(
      readTurnstileWebConfig(env({ NODE_ENV: 'development', APP_ENVIRONMENT: 'local', TURNSTILE_MODE: '', TURNSTILE_SITE_KEY: '' })),
    ).toEqual({ mode: 'test' });
  });

  it('is cloudflare with nothing set anywhere else, and carries the site key', () => {
    expect(readTurnstileWebConfig(env({ APP_ENVIRONMENT: 'staging', TURNSTILE_SITE_KEY: ` ${SITE_KEY} ` }))).toEqual({
      mode: 'cloudflare',
      siteKey: SITE_KEY,
    });
    expect(readTurnstileWebConfig(env({ TURNSTILE_SITE_KEY: SITE_KEY }))).toEqual({ mode: 'cloudflare', siteKey: SITE_KEY });
  });

  it('is unconfigured — closed, not off — when cloudflare has no site key', () => {
    expect(readTurnstileWebConfig(env({}))).toEqual({ mode: 'unconfigured' });
    expect(readTurnstileWebConfig(env({ APP_ENVIRONMENT: 'staging' }))).toEqual({ mode: 'unconfigured' });
    expect(readTurnstileWebConfig(env({ APP_ENVIRONMENT: 'production', TURNSTILE_SITE_KEY: '' }))).toEqual({ mode: 'unconfigured' });
    expect(readTurnstileWebConfig(env({ TURNSTILE_MODE: 'cloudflare', TURNSTILE_SITE_KEY: '' }))).toEqual({
      mode: 'unconfigured',
    });
  });

  it('honours an explicit cloudflare on a local stack, site key and all', () => {
    expect(readTurnstileWebConfig(env({ APP_ENVIRONMENT: 'local', TURNSTILE_MODE: 'cloudflare', TURNSTILE_SITE_KEY: SITE_KEY }))).toEqual({
      mode: 'cloudflare',
      siteKey: SITE_KEY,
    });
  });

  it.each(['test', 'off'] as const)('accepts %s only on a declared local stack', (mode) => {
    expect(readTurnstileWebConfig(env({ TURNSTILE_MODE: mode, APP_ENVIRONMENT: 'local' }))).toEqual({ mode });
    expect(readTurnstileWebConfig(env({ TURNSTILE_MODE: mode, APP_ENVIRONMENT: 'staging' }))).toEqual({
      mode: 'unconfigured',
    });
    expect(readTurnstileWebConfig(env({ TURNSTILE_MODE: mode }))).toEqual({ mode: 'unconfigured' });
  });

  it('treats an unknown mode as unconfigured', () => {
    expect(readTurnstileWebConfig(env({ TURNSTILE_MODE: 'disabled', TURNSTILE_SITE_KEY: SITE_KEY }))).toEqual({
      mode: 'unconfigured',
    });
  });

  it('never reads a secret: the API secret is not a web variable', () => {
    const config = readTurnstileWebConfig(env({ TURNSTILE_SITE_KEY: SITE_KEY, TURNSTILE_SECRET_KEY: 'shh' }));
    expect(JSON.stringify(config)).not.toContain('shh');
  });
});

describe('turnstileHeaders', () => {
  it('puts the token in the one header and nothing else', () => {
    expect(turnstileHeaders('tok')).toEqual({ [TURNSTILE_TOKEN_HEADER]: 'tok' });
    expect(TURNSTILE_TOKEN_HEADER).toBe('x-turnstile-token');
  });

  it('sends no header at all without a token — the API answers TURNSTILE_REQUIRED', () => {
    expect(turnstileHeaders(null)).toEqual({});
    expect(turnstileHeaders('  ')).toEqual({});
  });
});

describe('resolveTestTurnstileToken', () => {
  it('mints the deterministic token for the action, with a fresh nonce each time', () => {
    const first = resolveTestTurnstileToken(TURNSTILE_ACTIONS.identityCheck, undefined);
    const second = resolveTestTurnstileToken(TURNSTILE_ACTIONS.identityCheck, undefined);
    expect(first).toMatch(/^turnstile-test:identity-check:[A-Za-z0-9_-]+$/);
    expect(second).toMatch(/^turnstile-test:identity-check:[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
  });

  it('lets a browser test ask for a token the API will refuse, or one that makes Cloudflare unreachable', () => {
    expect(resolveTestTurnstileToken(TURNSTILE_ACTIONS.identityCheck, { outcome: 'invalid' })).toMatch(
      /^turnstile-test:__invalid__:/,
    );
    expect(resolveTestTurnstileToken(TURNSTILE_ACTIONS.identityCheck, { outcome: 'unavailable' })).toMatch(
      /^turnstile-test:__unavailable__:/,
    );
  });

  it('throws for the "widget failed" outcome, which is what a real widget error looks like to the form', () => {
    expect(() => resolveTestTurnstileToken(TURNSTILE_ACTIONS.identityCheck, { outcome: 'error' })).toThrow(
      /TURNSTILE_CHALLENGE_FAILED/,
    );
  });
});

describe('isTurnstileRefusalCode', () => {
  it('names the three API codes and the one client-side code', () => {
    for (const code of ['TURNSTILE_REQUIRED', 'TURNSTILE_FAILED', 'TURNSTILE_UNAVAILABLE', 'TURNSTILE_CHALLENGE_FAILED']) {
      expect(isTurnstileRefusalCode(code)).toBe(true);
    }
    expect(isTurnstileRefusalCode('CUSTOMER_IDENTITY_CONFLICT')).toBe(false);
  });
});
