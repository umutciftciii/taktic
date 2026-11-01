import { parseAppEnvironment } from '../../common/app-environment';

/**
 * OBS-ALERT-002 — the two secrets behind managed alert recipients.
 *
 *   OPS_ALERT_RECIPIENT_ENC_KEYS          v<n>:<base64 of 32 bytes>, comma-separated
 *   OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE    the id new addresses are sealed under
 *   OPS_ALERT_RECIPIENT_HMAC_KEY          ≥ 32 characters, keys the address identity
 *   OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION  1–1000, default 1, stored beside each HMAC
 *
 * The encryption key and the identity key are deliberately two secrets: a
 * leaked identity key lets an attacker test guesses against stored HMACs, a
 * leaked encryption key reads addresses, and neither should buy the other.
 *
 * ## Where the keys come from
 *
 *   NODE_ENV=test, or APP_ENVIRONMENT=local   the published development keys
 *                                              below when a variable is unset
 *   staging, production, undeclared           all of ENC_KEYS, ENC_KEY_ACTIVE and
 *                                              HMAC_KEY are required, and a
 *                                              development key is refused
 *                                              (the promotion-fingerprint pattern)
 *
 * Every message names the variable and never a value: these are secrets, and
 * the check also runs inside the deploy preflight where its output is read by
 * whoever is deploying.
 */

const VARS = {
  encKeys: 'OPS_ALERT_RECIPIENT_ENC_KEYS',
  encKeyActive: 'OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE',
  hmacKey: 'OPS_ALERT_RECIPIENT_HMAC_KEY',
  hmacVersion: 'OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION',
} as const;

export const OPS_ALERT_RECIPIENT_ENV = VARS;

export const RECIPIENT_HMAC_KEY_MIN_LENGTH = 32;
const AES_256_KEY_BYTES = 32;
const KEY_ID_PATTERN = /^v[1-9]\d{0,3}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Exactly 32 bytes of text that says what it is. Local stacks and tests only. */
const DEVELOPMENT_ENC_KEY_BYTES = Buffer.from('taktic-dev-recipient-not-secret!', 'utf8');

export const DEVELOPMENT_RECIPIENT_ENC_KEYS = `v1:${DEVELOPMENT_ENC_KEY_BYTES.toString('base64')}`;
export const DEVELOPMENT_RECIPIENT_ENC_KEY_ACTIVE = 'v1';
export const DEVELOPMENT_RECIPIENT_HMAC_KEY = 'taktic-local-development-recipient-hmac-key-not-secret';

export type RecipientCryptoConfig = {
  encKeys: ReadonlyMap<string, Buffer>;
  activeKeyId: string;
  hmacKey: string;
  hmacVersion: number;
  source: 'environment' | 'development';
};

export class OpsAlertRecipientCryptoConfigError extends Error {
  override name = 'OpsAlertRecipientCryptoConfigError';
}

function developmentKeyPermitted(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'test' || parseAppEnvironment(env.APP_ENVIRONMENT) === 'local';
}

function read(env: NodeJS.ProcessEnv, name: string): string {
  return env[name]?.trim() ?? '';
}

function requiredMessage(name: string, env: NodeJS.ProcessEnv): string {
  const environment = parseAppEnvironment(env.APP_ENVIRONMENT);
  return (
    `${name} is required (APP_ENVIRONMENT is ${environment ? `"${environment}"` : 'not set'}): ` +
    `operations alert recipients are encrypted at rest and compared by a keyed hash. ` +
    `Generate a secret for this deployment, or declare APP_ENVIRONMENT=local on a local stack.`
  );
}

/** Parses `v1:<base64>,v2:<base64>`; throws naming the variable, never a key. */
function parseKeyring(raw: string): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':');
    const id = separator === -1 ? '' : entry.slice(0, separator).trim();
    const encoded = separator === -1 ? '' : entry.slice(separator + 1).trim();
    if (!KEY_ID_PATTERN.test(id)) {
      throw new OpsAlertRecipientCryptoConfigError(`${VARS.encKeys} must be a comma-separated list of v<n>:<base64 key> entries.`);
    }
    if (keys.has(id)) {
      throw new OpsAlertRecipientCryptoConfigError(`${VARS.encKeys} has a duplicate key id.`);
    }
    if (!BASE64_PATTERN.test(encoded) || encoded.length % 4 !== 0) {
      throw new OpsAlertRecipientCryptoConfigError(`${VARS.encKeys} has an entry whose key is not base64.`);
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== AES_256_KEY_BYTES) {
      throw new OpsAlertRecipientCryptoConfigError(`${VARS.encKeys} has an entry that is not exactly ${AES_256_KEY_BYTES} bytes.`);
    }
    keys.set(id, key);
  }
  return keys;
}

export function resolveRecipientCryptoConfig(env: NodeJS.ProcessEnv = process.env): RecipientCryptoConfig {
  const rawVersion = read(env, VARS.hmacVersion);
  const hmacVersion = rawVersion ? Number(rawVersion) : 1;
  if (!Number.isInteger(hmacVersion) || hmacVersion < 1 || hmacVersion > 1000) {
    throw new OpsAlertRecipientCryptoConfigError(`${VARS.hmacVersion} must be a whole number from 1 to 1000.`);
  }

  const permitted = developmentKeyPermitted(env);
  const rawKeys = read(env, VARS.encKeys);
  const rawActive = read(env, VARS.encKeyActive);
  const rawHmac = read(env, VARS.hmacKey);

  let encKeys: Map<string, Buffer>;
  let activeKeyId: string;
  let encFromEnvironment = true;
  if (rawKeys) {
    encKeys = parseKeyring(rawKeys);
    if (!permitted) {
      const development = DEVELOPMENT_ENC_KEY_BYTES;
      if ([...encKeys.values()].some((key) => key.equals(development))) {
        throw new OpsAlertRecipientCryptoConfigError(
          `${VARS.encKeys} is the published development keyring; set a secret one for this deployment.`,
        );
      }
    }
    if (!rawActive) {
      throw new OpsAlertRecipientCryptoConfigError(`${VARS.encKeyActive} is required when ${VARS.encKeys} is set.`);
    }
    activeKeyId = rawActive;
  } else {
    if (!permitted) throw new OpsAlertRecipientCryptoConfigError(requiredMessage(VARS.encKeys, env));
    encKeys = parseKeyring(DEVELOPMENT_RECIPIENT_ENC_KEYS);
    activeKeyId = rawActive || DEVELOPMENT_RECIPIENT_ENC_KEY_ACTIVE;
    encFromEnvironment = false;
  }
  if (!encKeys.has(activeKeyId)) {
    throw new OpsAlertRecipientCryptoConfigError(`${VARS.encKeyActive} names a key id that is not in ${VARS.encKeys}.`);
  }

  let hmacKey: string;
  let hmacFromEnvironment = true;
  if (rawHmac) {
    if (rawHmac.length < RECIPIENT_HMAC_KEY_MIN_LENGTH) {
      throw new OpsAlertRecipientCryptoConfigError(`${VARS.hmacKey} must be at least ${RECIPIENT_HMAC_KEY_MIN_LENGTH} characters.`);
    }
    if (rawHmac === DEVELOPMENT_RECIPIENT_HMAC_KEY && !permitted) {
      throw new OpsAlertRecipientCryptoConfigError(`${VARS.hmacKey} is the published development key; set a secret one for this deployment.`);
    }
    hmacKey = rawHmac;
  } else {
    if (!permitted) throw new OpsAlertRecipientCryptoConfigError(requiredMessage(VARS.hmacKey, env));
    hmacKey = DEVELOPMENT_RECIPIENT_HMAC_KEY;
    hmacFromEnvironment = false;
  }

  return {
    encKeys,
    activeKeyId,
    hmacKey,
    hmacVersion,
    source: encFromEnvironment && hmacFromEnvironment ? 'environment' : 'development',
  };
}

/** Called once at boot from boot-config.ts, with the other configuration asserts. */
export function assertOpsAlertRecipientCryptoConfig(): void {
  resolveRecipientCryptoConfig();
}
