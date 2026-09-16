import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp } from './harness';

/**
 * The boot contract, at the level that matters: the application graph itself
 * refuses to come up when Turnstile is unconfigured or a bypass is asked for
 * where none may run. resolveTurnstileConfig's own cases are in
 * turnstile-config.spec.ts; these two prove the module actually asks it.
 */
const MANAGED = ['NODE_ENV', 'APP_ENVIRONMENT', 'TURNSTILE_MODE', 'TURNSTILE_SECRET_KEY'] as const;
const original = Object.fromEntries(MANAGED.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of MANAGED) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the application graph and Turnstile', () => {
  it('does not boot on the default (cloudflare) mode without a secret', async () => {
    delete process.env.TURNSTILE_MODE;
    await expect(createTestApp()).rejects.toThrow(/TURNSTILE_SECRET_KEY/);
  });

  it('does not boot with a bypass on a staging-like environment', async () => {
    process.env.NODE_ENV = 'development';
    process.env.APP_ENVIRONMENT = 'staging';
    process.env.TURNSTILE_MODE = 'off';
    await expect(createTestApp()).rejects.toThrow(/TURNSTILE_MODE=off is refused here/);
  });
});
