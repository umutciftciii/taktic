import { describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_FINGERPRINT_KEY,
  businessRegistrationFingerprint,
  resolvePromotionFingerprintConfig,
  sessionIpFingerprint,
} from '../src/modules/business-registration/promotion-fingerprint';

/** The fingerprint key's boot contract (CMP-006 PR-C design §3, RG-4). */

const SECRET = 'x'.repeat(40);

describe('resolvePromotionFingerprintConfig', () => {
  it('a local stack and the test suite boot with no value, on the development key, version 1', () => {
    expect(resolvePromotionFingerprintConfig({ APP_ENVIRONMENT: 'local' })).toEqual({
      key: DEVELOPMENT_FINGERPRINT_KEY,
      version: 1,
      source: 'development',
    });
    expect(resolvePromotionFingerprintConfig({ NODE_ENV: 'test' })).toMatchObject({ source: 'development' });
  });

  it.each([{ APP_ENVIRONMENT: 'staging' }, { APP_ENVIRONMENT: 'production' }, {}])(
    'refuses to boot without a key on %o, naming the variable and no value',
    (env) => {
      expect(() => resolvePromotionFingerprintConfig(env)).toThrow(/PROMOTION_FINGERPRINT_KEY is required/);
    },
  );

  it('refuses a short key, and the published development key where a secret is required', () => {
    expect(() => resolvePromotionFingerprintConfig({ APP_ENVIRONMENT: 'staging', PROMOTION_FINGERPRINT_KEY: 'short' })).toThrow(
      /at least 32/,
    );
    expect(() =>
      resolvePromotionFingerprintConfig({ APP_ENVIRONMENT: 'production', PROMOTION_FINGERPRINT_KEY: DEVELOPMENT_FINGERPRINT_KEY }),
    ).toThrow(/development key/);
  });

  it('reads the version, and refuses one that is not a whole number from 1 to 1000', () => {
    expect(
      resolvePromotionFingerprintConfig({ APP_ENVIRONMENT: 'production', PROMOTION_FINGERPRINT_KEY: SECRET, PROMOTION_FINGERPRINT_KEY_VERSION: '3' }),
    ).toEqual({ key: SECRET, version: 3, source: 'environment' });
    for (const bad of ['0', '-1', '1.5', 'two', '1001']) {
      expect(() => resolvePromotionFingerprintConfig({ NODE_ENV: 'test', PROMOTION_FINGERPRINT_KEY_VERSION: bad })).toThrow(
        /PROMOTION_FINGERPRINT_KEY_VERSION/,
      );
    }
  });
});

describe('fingerprints', () => {
  const config = { key: SECRET, version: 2, source: 'environment' as const };

  it('are keyed, versioned, deterministic and separated by type and by kind', () => {
    const a = businessRegistrationFingerprint('TAX_NUMBER', '1234567890', config);
    expect(a).toEqual(businessRegistrationFingerprint('TAX_NUMBER', '1234567890', config));
    expect(a.fingerprintVersion).toBe(2);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.fingerprint).not.toContain('1234567890');
    expect(businessRegistrationFingerprint('MERSIS', '1234567890', config).fingerprint).not.toBe(a.fingerprint);
    expect(businessRegistrationFingerprint('TAX_NUMBER', '1234567890', { ...config, key: 'y'.repeat(40) }).fingerprint).not.toBe(
      a.fingerprint,
    );
  });

  it('an address becomes `v<version>:<hex>` and never appears in it', () => {
    const value = sessionIpFingerprint('203.0.113.7', config);
    expect(value).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(value).not.toContain('203.0.113.7');
  });
});
