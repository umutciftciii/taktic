import { ConflictException, HttpStatus } from '@nestjs/common';
import { CONTACT_DISCLOSURE_PATH, contactDisclosureUrl } from '../../common/web-routes';

/**
 * Configuration for sharing contact details after a match.
 *
 * **On by default.** Opening the two parties' details to each other is not an
 * optional extra on this platform — it is the outcome a marketplace exists to
 * produce, and a customer who accepts an offer and then cannot reach the person
 * they accepted has not been matched to anybody. The flag used to default to
 * off, which meant a deployment that configured nothing quietly ran a
 * marketplace with its core result switched off: the accept succeeded, no
 * ContactRevealEvent was written, and both screens rendered nothing at all. It
 * remains a flag so an operator can deliberately turn the feature off, but
 * "nobody said anything" now means the product works.
 *
 * The safety model is unchanged, and it is the reason this can default to on.
 * This code can record that a customer confirmed a disclosure; it cannot invent
 * the text they confirmed. So a disclosure always has to exist:
 *
 * - By default it is {@link CONTACT_DISCLOSURE_PATH}, a page this repository
 *   ships and serves from the customer's own origin, versioned in code. There
 *   is no way for that text to be missing — it is in the build.
 * - A deployment with its own published legal page sets both
 *   CONTACT_DISCLOSURE_URL and CONTACT_DISCLOSURE_VERSION. Setting one without
 *   the other is still a startup failure: there is no partial state, because an
 *   acceptance that cannot name its version cannot say what was accepted, and a
 *   version that names no text refers to nothing.
 *
 * The acceptance stored against a request is a technical record of an
 * acknowledgement, not a legal basis on its own.
 */

/** Returned when a contact endpoint is reached while the feature is off. */
export const CONTACT_SHARING_DISABLED_CODE = 'CONTACT_SHARING_DISABLED';

/** Returned when a request carries no acceptance of the current disclosure. */
export const CONTACT_DISCLOSURE_REQUIRED_CODE = 'CONTACT_DISCLOSURE_REQUIRED';

export type ContactSharingConfig =
  | { enabled: false }
  | { enabled: true; disclosureUrl: string; disclosureVersion: string };

export type EnabledContactSharingConfig = Extract<ContactSharingConfig, { enabled: true }>;

/**
 * A short, opaque identifier for the published text — "v1", "2026-08-01",
 * "tr-1.2". Normalised to lower case so two deployments cannot disagree about
 * whether "V1" and "v1" are the same version, which would silently invalidate
 * every acceptance already on file.
 */
const DISCLOSURE_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The version of the disclosure this repository ships.
 *
 * Bump it whenever the wording of the page at {@link CONTACT_DISCLOSURE_PATH}
 * changes in a way a customer would need to see again. Every acceptance already
 * on file names the version it was given, so a bump invalidates the old ones and
 * the customer is asked once more — which is the whole reason the version is
 * stored rather than a bare boolean.
 */
export const BUILT_IN_DISCLOSURE_VERSION = 'taktic-2026-08-v1';

export { CONTACT_DISCLOSURE_PATH };

/**
 * Read on every call rather than cached at import time, so a deployment (and a
 * test) sees the environment it actually has.
 */
export function readContactSharingConfig(): ContactSharingConfig {
  if (!readStrictBoolean('CONTACT_SHARING_ENABLED', true)) {
    return { enabled: false };
  }

  const url = process.env.CONTACT_DISCLOSURE_URL?.trim();
  const version = process.env.CONTACT_DISCLOSURE_VERSION?.trim();

  // Neither configured: the platform's own page, which is in this build.
  if (!url && !version) {
    return {
      enabled: true,
      disclosureUrl: contactDisclosureUrl(),
      disclosureVersion: BUILT_IN_DISCLOSURE_VERSION,
    };
  }

  // One configured: still a startup failure, for the reason it always was.
  return {
    enabled: true,
    disclosureUrl: readDisclosureUrl(),
    disclosureVersion: readDisclosureVersion(),
  };
}

export function isContactSharingEnabled(): boolean {
  return readContactSharingConfig().enabled;
}

/**
 * The config for a caller that only runs when the feature is on. Throws the
 * explicit business-rule refusal otherwise, so no endpoint can accidentally
 * treat "disabled" as "no data".
 */
export function requireContactSharingEnabled(): EnabledContactSharingConfig {
  const config = readContactSharingConfig();
  if (!config.enabled) {
    throw contactSharingDisabledException();
  }

  return config;
}

export function contactSharingDisabledException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: CONTACT_SHARING_DISABLED_CODE,
    message: 'İletişim paylaşımı şu anda kapalı.',
  });
}

export function contactDisclosureRequiredException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: CONTACT_DISCLOSURE_REQUIRED_CODE,
    message:
      'Teklifi kabul etmek için iletişim bilgilerinin paylaşılacağına dair bilgilendirmeyi onaylayın.',
  });
}

/**
 * The wording changed after the screen was rendered.
 *
 * Its own message rather than the one above, because the two ask for different
 * things: one asks the customer to confirm, the other tells them the text they
 * confirmed is no longer the current one and they need to read it again. The
 * code stays the same so a client has one branch to handle.
 */
export function contactDisclosureSupersededException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: CONTACT_DISCLOSURE_REQUIRED_CODE,
    message: 'Bilgilendirme metni güncellendi. Lütfen sayfayı yenileyip tekrar onaylayın.',
  });
}

/**
 * Called once at boot so a misconfiguration is a startup failure rather than a
 * surprise on the first accept.
 */
export function assertContactSharingConfig(): void {
  readContactSharingConfig();
}

function readDisclosureUrl(): string {
  const raw = process.env.CONTACT_DISCLOSURE_URL?.trim();
  if (!raw) {
    throw new Error(
      'CONTACT_DISCLOSURE_URL is required alongside CONTACT_DISCLOSURE_VERSION: a version that ' +
        'names no text refers to nothing. Set both to use your own published disclosure, or ' +
        'neither to use the one this build serves.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`CONTACT_DISCLOSURE_URL must be a valid absolute URL (received "${raw}")`);
  }

  // https only: the link is shown to customers as the text they are confirming
  // they read, and a plaintext one can be rewritten in transit.
  if (parsed.protocol !== 'https:') {
    throw new Error(`CONTACT_DISCLOSURE_URL must use https (received "${parsed.protocol}//…")`);
  }

  return parsed.toString();
}

function readDisclosureVersion(): string {
  const raw = process.env.CONTACT_DISCLOSURE_VERSION?.trim().toLowerCase();
  if (!raw) {
    throw new Error(
      'CONTACT_DISCLOSURE_VERSION is required alongside CONTACT_DISCLOSURE_URL: an acceptance ' +
        'that does not name a version cannot say what was accepted. Set both to use your own ' +
        'published disclosure, or neither to use the one this build serves.',
    );
  }

  if (!DISCLOSURE_VERSION_PATTERN.test(raw)) {
    throw new Error(
      'CONTACT_DISCLOSURE_VERSION must be 1-64 characters of a-z, 0-9, dot, dash or underscore ' +
        `(received "${raw}")`,
    );
  }

  return raw;
}

function readStrictBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }

  if (raw === 'true') {
    return true;
  }

  if (raw === 'false') {
    return false;
  }

  throw new Error(`${name} must be exactly "true" or "false" (received "${raw}")`);
}
