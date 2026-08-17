import { ConflictException, HttpStatus } from '@nestjs/common';

/**
 * Configuration for sharing contact details after a match.
 *
 * The feature is off unless three things are true at once: the flag is on, an
 * https disclosure URL is configured, and a version identifier for that text is
 * configured. There is no partial state and no silent fallback — a deployment
 * that turns the flag on without the other two fails to boot.
 *
 * That strictness is the point. This code can record that a customer ticked a
 * box; it cannot supply the text that box refers to. Requiring the URL and the
 * version makes it impossible to open contact details while the thing the
 * customer supposedly read does not exist. The acceptance stored on a request is
 * a technical record of an acknowledgement, not a legal basis on its own.
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
 * Read on every call rather than cached at import time, so a deployment (and a
 * test) sees the environment it actually has.
 */
export function readContactSharingConfig(): ContactSharingConfig {
  if (!readStrictBoolean('CONTACT_SHARING_ENABLED', false)) {
    return { enabled: false };
  }

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
    message: 'Bu talep için bilgilendirme onayı bulunmuyor.',
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
      'CONTACT_DISCLOSURE_URL is required when CONTACT_SHARING_ENABLED=true: contact details ' +
        'may not be opened without a published disclosure text to point the customer at.',
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
      'CONTACT_DISCLOSURE_VERSION is required when CONTACT_SHARING_ENABLED=true: an acceptance ' +
        'that does not name a version cannot say what was accepted.',
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
