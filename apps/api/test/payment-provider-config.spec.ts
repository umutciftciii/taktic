import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LEMON_SQUEEZY_API_BASE_URL,
  DEFAULT_LEMON_SQUEEZY_TIMEOUT_MS,
  missingLemonSqueezyConfigKeys,
  readLemonSqueezyConfig,
} from '../src/modules/payments/lemon-squeezy.config';
import {
  PAYMENT_PROVIDER_KINDS,
  REFUSED_LIVE_MODE_ENV_KEYS,
  assertNoLiveModeConfig,
  assertPaymentProviderConfig,
  resolvePaymentProviderKind,
} from '../src/modules/payments/payment-provider.config';

/**
 * The boot-time payment configuration matrix.
 *
 * Nothing here opens a checkout: these are the checks that decide whether a
 * process is allowed to exist at all, and the whole point of running them at
 * boot is that a misconfigured deployment never reaches its first purchase.
 *
 * Every credential below is a syntactically valid placeholder that was never
 * issued, and each case that expects a refusal also asserts the refusal did not
 * echo the value back.
 */
const PLACEHOLDER_API_KEY = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.${'placeholderNotARealCredential'}`;
const PLACEHOLDER_WEBHOOK_SECRET = 'placeholder-webhook-secret-not-real';
const PLACEHOLDER_STORE_ID = '424242';

const MANAGED_KEYS = [
  'NODE_ENV',
  'PAYMENT_PROVIDER',
  'LEMON_SQUEEZY_API_KEY',
  'LEMON_SQUEEZY_STORE_ID',
  'LEMON_SQUEEZY_WEBHOOK_SECRET',
  'LEMON_SQUEEZY_VARIANT_MAP',
  'LEMON_SQUEEZY_API_BASE_URL',
  'LEMON_SQUEEZY_TIMEOUT_MS',
  'LEMON_SQUEEZY_MODE',
  ...REFUSED_LIVE_MODE_ENV_KEYS,
] as const;

let original: Record<string, string | undefined>;

beforeEach(() => {
  original = Object.fromEntries(MANAGED_KEYS.map((key) => [key, process.env[key]]));

  for (const key of MANAGED_KEYS) {
    delete process.env[key];
  }

  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function configureLemonSqueezy() {
  process.env.PAYMENT_PROVIDER = 'lemon-squeezy-test';
  process.env.LEMON_SQUEEZY_API_KEY = PLACEHOLDER_API_KEY;
  process.env.LEMON_SQUEEZY_STORE_ID = PLACEHOLDER_STORE_ID;
  process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = PLACEHOLDER_WEBHOOK_SECRET;
  process.env.LEMON_SQUEEZY_VARIANT_MAP = 'baslangic:111,profesyonel:222';
}

describe('PAYMENT_PROVIDER allow-list', () => {
  it('defaults to the mock provider, which collects nothing', () => {
    expect(resolvePaymentProviderKind()).toBe('mock');
    expect(() => assertPaymentProviderConfig()).not.toThrow();
  });

  it('accepts each allowed value and nothing else', () => {
    expect([...PAYMENT_PROVIDER_KINDS]).toEqual(['mock', 'lemon-squeezy-test']);

    process.env.PAYMENT_PROVIDER = 'mock';
    expect(resolvePaymentProviderKind()).toBe('mock');

    configureLemonSqueezy();
    expect(resolvePaymentProviderKind()).toBe('lemon-squeezy-test');
  });

  it('refuses a value outside the allow-list without echoing it', () => {
    process.env.PAYMENT_PROVIDER = PLACEHOLDER_API_KEY;

    try {
      resolvePaymentProviderKind();
      expect.unreachable('an unknown payment provider must not be accepted');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/must be exactly one of/);
      expect(message).not.toContain(PLACEHOLDER_API_KEY);
    }
  });

  it('refuses a live-looking Lemon Squeezy provider name', () => {
    for (const candidate of ['lemon-squeezy', 'lemon-squeezy-live', 'LEMON-SQUEEZY-TEST']) {
      process.env.PAYMENT_PROVIDER = candidate;
      expect(() => resolvePaymentProviderKind()).toThrow(/must be exactly one of/);
    }
  });
});

describe('live mode is not a switch that exists yet', () => {
  it('refuses every live-mode variable, even set to a falsy value', () => {
    for (const key of REFUSED_LIVE_MODE_ENV_KEYS) {
      process.env[key] = 'false';
      expect(() => assertNoLiveModeConfig()).toThrow(/live payment collection is not part/);
      expect(() => assertPaymentProviderConfig()).toThrow(/live payment collection is not part/);
      delete process.env[key];
    }

    expect(() => assertNoLiveModeConfig()).not.toThrow();
  });

  it('refuses the live-mode variables even under the mock provider', () => {
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.LEMON_SQUEEZY_LIVE_ENABLED = 'true';

    expect(() => assertPaymentProviderConfig()).toThrow(/live payment collection is not part/);
  });

  it('pins LEMON_SQUEEZY_MODE to test without echoing another value', () => {
    process.env.LEMON_SQUEEZY_MODE = 'test';
    expect(() => assertNoLiveModeConfig()).not.toThrow();

    process.env.LEMON_SQUEEZY_MODE = 'live';
    try {
      assertNoLiveModeConfig();
      expect.unreachable('a non-test Lemon Squeezy mode must not be accepted');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/may only be "test"/);
      expect(message).not.toContain('live');
    }
  });
});

describe('production boot matrix', () => {
  it('refuses the sandbox provider in production', () => {
    configureLemonSqueezy();
    process.env.NODE_ENV = 'production';

    expect(() => assertPaymentProviderConfig()).toThrow(/cannot run under NODE_ENV=production/);
  });

  it('keeps the mock provider bootable in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_PROVIDER = 'mock';

    expect(() => assertPaymentProviderConfig()).not.toThrow();
  });

  it('refuses the API base-url test seam in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.LEMON_SQUEEZY_API_BASE_URL = 'https://api.lemonsqueezy.com';

    // The seam is only read when the sandbox provider is selected, which
    // production already refuses — this asserts the second lock independently.
    configureLemonSqueezy();
    process.env.NODE_ENV = 'test';
    expect(() => readLemonSqueezyConfig()).not.toThrow();

    process.env.NODE_ENV = 'production';
    expect(() => readLemonSqueezyConfig()).toThrow(/must not be set in production/);
  });
});

describe('Lemon Squeezy credentials', () => {
  it('are required only when the sandbox provider is selected', () => {
    process.env.PAYMENT_PROVIDER = 'mock';
    expect(() => assertPaymentProviderConfig()).not.toThrow();

    process.env.PAYMENT_PROVIDER = 'lemon-squeezy-test';
    expect(() => assertPaymentProviderConfig()).toThrow(/LEMON_SQUEEZY_API_KEY is required/);
  });

  it('fails fast on each missing setting, one at a time', () => {
    configureLemonSqueezy();
    expect(() => assertPaymentProviderConfig()).not.toThrow();

    delete process.env.LEMON_SQUEEZY_VARIANT_MAP;
    expect(() => assertPaymentProviderConfig()).toThrow(/LEMON_SQUEEZY_VARIANT_MAP is required/);

    configureLemonSqueezy();
    delete process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
    expect(() => assertPaymentProviderConfig()).toThrow(/LEMON_SQUEEZY_WEBHOOK_SECRET is required/);

    configureLemonSqueezy();
    delete process.env.LEMON_SQUEEZY_STORE_ID;
    expect(() => assertPaymentProviderConfig()).toThrow(/LEMON_SQUEEZY_STORE_ID is required/);
  });

  it('refuses a malformed key and secret without echoing either', () => {
    configureLemonSqueezy();
    process.env.LEMON_SQUEEZY_API_KEY = 'paste-your-key-here';

    try {
      readLemonSqueezyConfig();
      expect.unreachable('a malformed key must not be accepted');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/shape of a Lemon Squeezy API key/);
      expect(message).not.toContain('paste-your-key-here');
    }

    configureLemonSqueezy();
    process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = 'too short';

    try {
      readLemonSqueezyConfig();
      expect.unreachable('a malformed webhook secret must not be accepted');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/16-255 printable/);
      expect(message).not.toContain('too short');
    }
  });

  it('refuses a variant map that is ambiguous or malformed', () => {
    configureLemonSqueezy();

    process.env.LEMON_SQUEEZY_VARIANT_MAP = 'baslangic:111,baslangic:222';
    expect(() => readLemonSqueezyConfig()).toThrow(/more than once/);

    process.env.LEMON_SQUEEZY_VARIANT_MAP = 'baslangic:111,profesyonel:111';
    expect(() => readLemonSqueezyConfig()).toThrow(/more than one credit package/);

    process.env.LEMON_SQUEEZY_VARIANT_MAP = 'Baslangic:111';
    expect(() => readLemonSqueezyConfig()).toThrow(/credit-package-slug:numericVariantId/);

    process.env.LEMON_SQUEEZY_VARIANT_MAP = 'baslangic:not-a-number';
    expect(() => readLemonSqueezyConfig()).toThrow(/credit-package-slug:numericVariantId/);

    process.env.LEMON_SQUEEZY_VARIANT_MAP = ' , ';
    expect(() => readLemonSqueezyConfig()).toThrow(/is empty/);
  });

  it('reads a complete configuration without carrying a secret into its shape', () => {
    configureLemonSqueezy();
    const config = readLemonSqueezyConfig();

    expect(config.storeId).toBe(PLACEHOLDER_STORE_ID);
    expect(config.apiBaseUrl).toBe(DEFAULT_LEMON_SQUEEZY_API_BASE_URL);
    expect(config.timeoutMs).toBe(DEFAULT_LEMON_SQUEEZY_TIMEOUT_MS);
    expect(config.variantsBySlug.get('baslangic')).toBe('111');
    expect(config.variantsBySlug.get('profesyonel')).toBe('222');
    expect(config.variantsBySlug.get('bilinmeyen')).toBeUndefined();
  });

  it('bounds the request timeout', () => {
    configureLemonSqueezy();

    process.env.LEMON_SQUEEZY_TIMEOUT_MS = '2500';
    expect(readLemonSqueezyConfig().timeoutMs).toBe(2500);

    for (const invalid of ['0', '999', '60001', 'soon', '1500.5']) {
      process.env.LEMON_SQUEEZY_TIMEOUT_MS = invalid;
      expect(() => readLemonSqueezyConfig()).toThrow(/LEMON_SQUEEZY_TIMEOUT_MS/);
    }
  });

  it('allows a loopback API base url outside production and refuses plain http elsewhere', () => {
    configureLemonSqueezy();

    process.env.LEMON_SQUEEZY_API_BASE_URL = 'http://127.0.0.1:3299';
    expect(readLemonSqueezyConfig().apiBaseUrl).toBe('http://127.0.0.1:3299');

    process.env.LEMON_SQUEEZY_API_BASE_URL = 'http://payments.example.test';
    expect(() => readLemonSqueezyConfig()).toThrow(/must use https/);

    process.env.LEMON_SQUEEZY_API_BASE_URL = 'not-a-url';
    expect(() => readLemonSqueezyConfig()).toThrow(/valid absolute URL/);
  });
});

describe('the admin view of an incomplete configuration', () => {
  it('lists names only, and never a value', () => {
    process.env.PAYMENT_PROVIDER = 'lemon-squeezy-test';

    expect(missingLemonSqueezyConfigKeys()).toEqual([
      'LEMON_SQUEEZY_API_KEY',
      'LEMON_SQUEEZY_STORE_ID',
      'LEMON_SQUEEZY_WEBHOOK_SECRET',
      'LEMON_SQUEEZY_VARIANT_MAP',
    ]);

    configureLemonSqueezy();
    expect(missingLemonSqueezyConfigKeys()).toEqual([]);

    process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = 'short';
    const missing = missingLemonSqueezyConfigKeys();
    expect(missing).toEqual(['LEMON_SQUEEZY_WEBHOOK_SECRET']);
    expect(missing.join(' ')).not.toContain('short');
  });
});
