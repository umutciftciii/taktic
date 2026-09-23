import { createHmac } from 'node:crypto';
import type { BusinessRegistrationType } from '@prisma/client';
import { parseAppEnvironment } from '../../common/app-environment';

/**
 * The versioned keyed hash behind every fingerprint the promotion eligibility
 * gate compares (CMP-006 PR-C, S0 §5 rule 2, RG-4).
 *
 * A fingerprint lets two rows be recognised as "the same business" or "the
 * same network address" without either row holding the number or the address.
 * It is HMAC-SHA256 under a secret key, with a domain prefix per kind so a
 * registration number and an address can never collide.
 *
 * ## Where the key comes from
 *
 *   NODE_ENV=test, or APP_ENVIRONMENT=local   the development key below, when
 *                                              PROMOTION_FINGERPRINT_KEY is unset
 *                                              — a local stack boots with no value
 *   staging, production, undeclared           PROMOTION_FINGERPRINT_KEY is
 *                                              required (≥ 32 characters) or the
 *                                              process refuses to boot
 *
 * ## Changing the key is a migration
 *
 * `PROMOTION_FINGERPRINT_KEY_VERSION` is written beside every fingerprint.
 * Replacing the key without re-deriving the stored fingerprints (from
 * ProviderBusinessRegistration's raw numbers) would make every business new
 * again and open a second introductory promotion to each — so a rotation is a
 * reviewed migration that bumps the version, never a quiet `.env` edit.
 */

const VARS = { key: 'PROMOTION_FINGERPRINT_KEY', version: 'PROMOTION_FINGERPRINT_KEY_VERSION' } as const;

/** Local stacks and the test suite only. Never valid where the key is required. */
export const DEVELOPMENT_FINGERPRINT_KEY = 'taktic-local-development-promotion-fingerprint-key-not-secret';

export const FINGERPRINT_KEY_MIN_LENGTH = 32;

export type PromotionFingerprintConfig = { key: string; version: number; source: 'environment' | 'development' };

function developmentKeyPermitted(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'test' || parseAppEnvironment(env.APP_ENVIRONMENT) === 'local';
}

export function resolvePromotionFingerprintConfig(env: NodeJS.ProcessEnv = process.env): PromotionFingerprintConfig {
  const rawVersion = env[VARS.version]?.trim();
  const version = rawVersion ? Number(rawVersion) : 1;
  if (!Number.isInteger(version) || version < 1 || version > 1000) {
    throw new Error(`${VARS.version} must be a whole number from 1 to 1000.`);
  }

  const key = env[VARS.key]?.trim() ?? '';
  if (key) {
    if (key.length < FINGERPRINT_KEY_MIN_LENGTH) {
      throw new Error(`${VARS.key} must be at least ${FINGERPRINT_KEY_MIN_LENGTH} characters.`);
    }
    if (key === DEVELOPMENT_FINGERPRINT_KEY && !developmentKeyPermitted(env)) {
      throw new Error(`${VARS.key} is the published development key; set a secret one for this deployment.`);
    }
    return { key, version, source: 'environment' };
  }

  if (!developmentKeyPermitted(env)) {
    const environment = parseAppEnvironment(env.APP_ENVIRONMENT);
    throw new Error(
      `${VARS.key} is required (APP_ENVIRONMENT is ${environment ? `"${environment}"` : 'not set'}): ` +
        `promotion eligibility compares business registrations by a keyed fingerprint. ` +
        `Generate a secret of at least ${FINGERPRINT_KEY_MIN_LENGTH} characters, or declare APP_ENVIRONMENT=local on a local stack.`,
    );
  }
  return { key: DEVELOPMENT_FINGERPRINT_KEY, version, source: 'development' };
}

/** Called once at boot from main.ts, with the other configuration asserts. */
export function assertPromotionFingerprintConfig(): void {
  resolvePromotionFingerprintConfig();
}

function hmac(config: PromotionFingerprintConfig, message: string): string {
  return createHmac('sha256', config.key).update(message, 'utf8').digest('hex');
}

export function businessRegistrationFingerprint(
  type: BusinessRegistrationType,
  numberCanonical: string,
  config: PromotionFingerprintConfig = resolvePromotionFingerprintConfig(),
): { fingerprint: string; fingerprintVersion: number } {
  return { fingerprint: hmac(config, `business-registration:${type}:${numberCanonical}`), fingerprintVersion: config.version };
}

/** `v<version>:<hex>` — the only form a network address takes in a stored snapshot. */
export function sessionIpFingerprint(
  ipAddress: string,
  config: PromotionFingerprintConfig = resolvePromotionFingerprintConfig(),
): string {
  return `v${config.version}:${hmac(config, `session-ip:${ipAddress}`)}`;
}
