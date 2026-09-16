import { describe, expect, it } from 'vitest';
import {
  TURNSTILE_VARS,
  isTurnstileBypassPermitted,
  resolveTurnstileConfig,
} from '../src/modules/turnstile/turnstile.config';

/**
 * The boot contract: a deployment that says nothing gets Cloudflare and must
 * supply the secret and the hostnames, and the two modes that skip Cloudflare
 * are accepted only where a test can be running. Every message names a
 * variable and never its value.
 */
const SECRET = 'not-a-real-secret-0x1234';

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...values } as NodeJS.ProcessEnv;
}

describe('resolveTurnstileConfig — cloudflare', () => {
  it('is the mode an unset TURNSTILE_MODE resolves to, and then needs the secret', () => {
    expect(() => resolveTurnstileConfig(env({}))).toThrow(TURNSTILE_VARS.secretKey);
  });

  it('needs the expected hostnames as well', () => {
    expect(() =>
      resolveTurnstileConfig(env({ TURNSTILE_MODE: 'cloudflare', TURNSTILE_SECRET_KEY: SECRET })),
    ).toThrow(TURNSTILE_VARS.expectedHostnames);
  });

  it('resolves with the hostnames lower-cased and trimmed, and the default timeout', () => {
    const config = resolveTurnstileConfig(
      env({
        TURNSTILE_SECRET_KEY: SECRET,
        TURNSTILE_EXPECTED_HOSTNAMES: ' Taktick.example , www.taktick.example,,',
      }),
    );
    expect(config).toEqual({
      mode: 'cloudflare',
      secretKey: SECRET,
      expectedHostnames: new Set(['taktick.example', 'www.taktick.example']),
      siteverifyTimeoutMs: 5000,
    });
  });

  it('never puts the secret into an error message', () => {
    let message = '';
    try {
      resolveTurnstileConfig(env({ TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_EXPECTED_HOSTNAMES: ' ' }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(TURNSTILE_VARS.expectedHostnames);
    expect(message).not.toContain(SECRET);
  });

  it('refuses a timeout that is not a positive whole number of milliseconds', () => {
    const base = { TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_EXPECTED_HOSTNAMES: 'a.example' };
    expect(() =>
      resolveTurnstileConfig(env({ ...base, TURNSTILE_SITEVERIFY_TIMEOUT_MS: '0' })),
    ).toThrow(TURNSTILE_VARS.siteverifyTimeoutMs);
    expect(() =>
      resolveTurnstileConfig(env({ ...base, TURNSTILE_SITEVERIFY_TIMEOUT_MS: 'soon' })),
    ).toThrow(TURNSTILE_VARS.siteverifyTimeoutMs);
    expect(
      resolveTurnstileConfig(env({ ...base, TURNSTILE_SITEVERIFY_TIMEOUT_MS: '2500' })),
    ).toMatchObject({ siteverifyTimeoutMs: 2500 });
  });

  it('refuses a mode that is none of the three', () => {
    expect(() => resolveTurnstileConfig(env({ TURNSTILE_MODE: 'disabled' }))).toThrow(
      TURNSTILE_VARS.mode,
    );
  });

  it('is accepted in production even though it is the strict mode', () => {
    expect(
      resolveTurnstileConfig(
        env({
          NODE_ENV: 'production',
          APP_ENVIRONMENT: 'production',
          TURNSTILE_SECRET_KEY: SECRET,
          TURNSTILE_EXPECTED_HOSTNAMES: 'taktick.example',
        }),
      ),
    ).toMatchObject({ mode: 'cloudflare' });
  });
});

describe('resolveTurnstileConfig — test and off', () => {
  it.each(['test', 'off'] as const)('%s is accepted under NODE_ENV=test', (mode) => {
    expect(resolveTurnstileConfig(env({ NODE_ENV: 'test', TURNSTILE_MODE: mode }))).toEqual({ mode });
  });

  it.each(['test', 'off'] as const)('%s is accepted on a declared local stack', (mode) => {
    expect(
      resolveTurnstileConfig(env({ NODE_ENV: 'development', APP_ENVIRONMENT: 'local', TURNSTILE_MODE: mode })),
    ).toEqual({ mode });
  });

  it.each([
    ['staging', { NODE_ENV: 'development', APP_ENVIRONMENT: 'staging' }],
    ['production', { NODE_ENV: 'development', APP_ENVIRONMENT: 'production' }],
    ['NODE_ENV=production on a local stack', { NODE_ENV: 'production', APP_ENVIRONMENT: 'local' }],
    ['an undeclared environment', { NODE_ENV: 'development' }],
  ])('refuses to boot with TURNSTILE_MODE=test on %s', (_label, values) => {
    expect(() => resolveTurnstileConfig(env({ ...values, TURNSTILE_MODE: 'test' }))).toThrow(
      /TURNSTILE_MODE=test is refused here/,
    );
  });

  it('refuses TURNSTILE_MODE=off on staging with the same rule', () => {
    expect(() =>
      resolveTurnstileConfig(env({ NODE_ENV: 'development', APP_ENVIRONMENT: 'staging', TURNSTILE_MODE: 'off' })),
    ).toThrow(/TURNSTILE_MODE=off is refused here/);
  });

  it('a secret set alongside TURNSTILE_MODE=off is refused: the two cannot both be meant', () => {
    expect(() =>
      resolveTurnstileConfig(env({ NODE_ENV: 'test', TURNSTILE_MODE: 'off', TURNSTILE_SECRET_KEY: SECRET })),
    ).toThrow(TURNSTILE_VARS.secretKey);
  });

  it('a misspelt APP_ENVIRONMENT is a configuration error, not "not production"', () => {
    expect(() =>
      resolveTurnstileConfig(env({ NODE_ENV: 'development', APP_ENVIRONMENT: 'prod', TURNSTILE_MODE: 'off' })),
    ).toThrow(/APP_ENVIRONMENT must be one of/);
  });
});

describe('isTurnstileBypassPermitted', () => {
  it('is the same gate the two bypass modes use', () => {
    expect(isTurnstileBypassPermitted(env({ NODE_ENV: 'test' }))).toBe(true);
    expect(isTurnstileBypassPermitted(env({ NODE_ENV: 'development', APP_ENVIRONMENT: 'local' }))).toBe(true);
    expect(isTurnstileBypassPermitted(env({ NODE_ENV: 'development', APP_ENVIRONMENT: 'staging' }))).toBe(false);
    expect(isTurnstileBypassPermitted(env({ NODE_ENV: 'production', APP_ENVIRONMENT: 'local' }))).toBe(false);
    expect(isTurnstileBypassPermitted(env({ NODE_ENV: 'development' }))).toBe(false);
  });
});
