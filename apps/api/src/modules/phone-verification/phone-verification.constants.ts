/** Digits in a one-time code. */
export const OTP_CODE_LENGTH = 6;

/** How long a freshly issued code stays usable. */
export const OTP_TTL_MINUTES = 5;

/** Wrong codes allowed against one row before it locks. */
export const OTP_MAX_ATTEMPTS = 5;

/** How long a row stays locked once the attempt budget is spent. */
export const OTP_LOCK_MINUTES = 15;

/** Codes that may be issued to one phone number per hour. */
export const OTP_MAX_SENDS_PER_PHONE_PER_HOUR = 3;

/** Codes that may be issued from one IP address per hour. */
export const OTP_MAX_SENDS_PER_IP_PER_HOUR = 10;

export const OTP_RATE_WINDOW_MINUTES = 60;

/**
 * Whether an unverified request is hidden from providers and blocked from
 * moderation.
 *
 * Defaults to false and must stay false until a real SMS transport exists:
 * turning it on without one would strand every new request in an unverifiable
 * state. Only the two literals are accepted — a typo must fail at boot rather
 * than silently disable the gate.
 */
export function isPhoneVerificationRequired(): boolean {
  return readStrictBoolean('REQUIRE_PHONE_VERIFICATION', false);
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
