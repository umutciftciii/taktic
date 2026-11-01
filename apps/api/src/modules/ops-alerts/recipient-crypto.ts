import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { isWellFormedEmail } from '../company-settings/company-settings.rules';
import type { RecipientCryptoConfig } from './recipient-crypto.config';

/**
 * OBS-ALERT-002 — sealing a recipient's address and recognising it again.
 *
 * AES-256-GCM binds each ciphertext to its recipient through the AAD
 * (`ops-alert-recipient:<id>`), so a row copied onto another recipient's id
 * decrypts to nothing rather than to a plausible stranger's mailbox.
 * Identity is HMAC-SHA256 over the normalized address: it detects a
 * duplicate without the address being readable from the column.
 *
 * No error here carries an address, a key or a recipient id.
 */

export const MAX_ADDRESS_LENGTH = 254;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Domain prefix of the identity hash; fixed text, unrelated to the key version. */
const HMAC_DOMAIN = 'ops-alert-recipient:v1:';

export class InvalidRecipientAddressError extends Error {
  override name = 'InvalidRecipientAddressError';
  constructor() {
    super('The address is not a plain e-mail address.');
  }
}

export class RecipientDecryptError extends Error {
  override name = 'RecipientDecryptError';
  constructor() {
    super('The recipient address could not be decrypted.');
  }
}

export type SealedAddress = { ciphertext: Buffer; nonce: Buffer; tag: Buffer; keyId: string };

/** The one place an address is trimmed, lowercased and validated. */
export function normalizeAddress(raw: string): string {
  const address = raw.trim().toLowerCase();
  if (
    address.length === 0 ||
    address.length > MAX_ADDRESS_LENGTH ||
    /[<>\s]/.test(address) ||
    !isWellFormedEmail(address)
  ) {
    throw new InvalidRecipientAddressError();
  }
  return address;
}

function aad(recipientId: string): Buffer {
  return Buffer.from('ops-alert-recipient:' + recipientId);
}

export function encryptAddress(config: RecipientCryptoConfig, recipientId: string, address: string): SealedAddress {
  const key = config.encKeys.get(config.activeKeyId);
  if (!key) throw new RecipientDecryptError();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(recipientId));
  const ciphertext = Buffer.concat([cipher.update(address, 'utf8'), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag(), keyId: config.activeKeyId };
}

export function decryptAddress(config: RecipientCryptoConfig, recipientId: string, sealed: SealedAddress): string {
  const key = config.encKeys.get(sealed.keyId);
  if (!key) throw new RecipientDecryptError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(recipientId));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, wrong recipient, wrong tag or truncated input: one answer.
    throw new RecipientDecryptError();
  }
}

/** Takes an address already passed through {@link normalizeAddress}. */
export function addressHmac(config: RecipientCryptoConfig, normalized: string): { hmac: string; version: number } {
  const hmac = createHmac('sha256', config.hmacKey).update(HMAC_DOMAIN + normalized, 'utf8').digest('hex');
  return { hmac, version: config.hmacVersion };
}
