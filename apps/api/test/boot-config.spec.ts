import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOOT_CONFIG_CHECKS, assertBootConfig, runBootConfigChecks } from '../src/boot-config';

/**
 * The API's boot checks as one list (boot-config.ts), and the staging runtime
 * contract they must accept: the immutable production build
 * (NODE_ENV=production) on APP_ENVIRONMENT=staging with Lemon Squeezy's
 * sandbox. The same list runs inside the image during the deploy preflight
 * (boot-config-check.ts), so "accepted here" is "accepted before the API is
 * stopped and before any migration".
 *
 * Every value below is a never-issued placeholder in the shape its reader
 * expects.
 */
const PLACEHOLDER_FINGERPRINT_KEY = 'placeholder-fingerprint-key-not-a-secret-0001';
const PLACEHOLDER_LEMON_KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.placeholderNotARealCredential';
const PLACEHOLDER_WEBHOOK_SECRET = 'placeholder-webhook-secret-not-real';

const STAGING_CONTRACT: Record<string, string> = {
  NODE_ENV: 'production',
  APP_ENVIRONMENT: 'staging',
  EMAIL_TRANSPORT: 'resend',
  RESEND_API_KEY: 're_placeholderNotARealKey',
  EMAIL_FROM: 'Taktick <noreply@notify.taktick.com.tr>',
  PAYMENT_PROVIDER: 'lemon-squeezy-test',
  LEMON_SQUEEZY_API_KEY: PLACEHOLDER_LEMON_KEY,
  LEMON_SQUEEZY_STORE_ID: '424242',
  LEMON_SQUEEZY_WEBHOOK_SECRET: PLACEHOLDER_WEBHOOK_SECRET,
  LEMON_SQUEEZY_VARIANT_MAP: 'baslangic:111,profesyonel:222',
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  TURNSTILE_EXPECTED_HOSTNAMES: 'staging.example.test',
  PROMOTION_FINGERPRINT_KEY: PLACEHOLDER_FINGERPRINT_KEY,
};

let original: NodeJS.ProcessEnv;

beforeEach(() => {
  original = { ...process.env };
  // Only the variables a boot check reads matter; start every case from
  // nothing so a developer's exported value cannot decide the outcome.
  for (const key of Object.keys(process.env)) {
    if (key !== 'PATH' && key !== 'HOME') {
      delete process.env[key];
    }
  }
  Object.assign(process.env, STAGING_CONTRACT);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, original);
});

function refused(): Record<string, string> {
  return Object.fromEntries(
    runBootConfigChecks().flatMap((result) => (result.ok ? [] : [[result.name, result.message]])),
  );
}

describe('the staging runtime contract', () => {
  it('boots the production build on staging with the Lemon Squeezy sandbox', () => {
    expect(refused()).toEqual({});
    expect(() => assertBootConfig()).not.toThrow();
  });

  it('refuses the same configuration once it declares itself production', () => {
    process.env.APP_ENVIRONMENT = 'production';

    expect(Object.keys(refused())).toContain('payment-provider');
    expect(refused()['payment-provider']).toMatch(/APP_ENVIRONMENT is "production"/);
  });

  it('refuses a missing or short promotion fingerprint key, naming it and nothing else', () => {
    delete process.env.PROMOTION_FINGERPRINT_KEY;
    expect(refused()).toEqual({
      'promotion-fingerprint': expect.stringMatching(/PROMOTION_FINGERPRINT_KEY is required/),
    });

    process.env.PROMOTION_FINGERPRINT_KEY = 'x'.repeat(31);
    expect(refused()['promotion-fingerprint']).toMatch(/at least 32 characters/);
    expect(refused()['promotion-fingerprint']).not.toContain('x'.repeat(31));
  });

  it('reports every refusal in one run instead of stopping at the first', () => {
    delete process.env.PROMOTION_FINGERPRINT_KEY;
    delete process.env.LEMON_SQUEEZY_API_KEY;
    process.env.EMAIL_TRANSPORT = 'console';

    expect(Object.keys(refused()).sort()).toEqual(
      ['email-transport', 'payment-provider', 'promotion-fingerprint'].sort(),
    );
  });

  it('never prints a secret in a refusal', () => {
    process.env.LEMON_SQUEEZY_API_KEY = 'not-a-jwt-but-secret-looking-value';
    process.env.RESEND_API_KEY = 'secret-looking-resend-value';

    const messages = Object.values(refused()).join('\n');
    expect(messages).not.toContain('not-a-jwt-but-secret-looking-value');
    expect(messages).not.toContain('secret-looking-resend-value');
    expect(messages).not.toContain(PLACEHOLDER_WEBHOOK_SECRET);
    expect(messages).not.toContain(PLACEHOLDER_FINGERPRINT_KEY);
  });

  it('stops main.ts at the first refusal, in list order', () => {
    delete process.env.PROMOTION_FINGERPRINT_KEY;
    process.env.EMAIL_TRANSPORT = 'console';

    expect(() => assertBootConfig()).toThrow(/NODE_ENV=production requires an e-mail transport/);
    expect(BOOT_CONFIG_CHECKS.map((check) => check.name)).toEqual([
      'email-branding',
      'session-policy',
      'contact-sharing',
      'email-transport',
      'provider-claim',
      'payment-provider',
      'phone-verification-test-bypass',
      'turnstile',
      'promotion-fingerprint',
    ]);
  });
});
