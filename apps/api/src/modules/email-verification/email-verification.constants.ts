/**
 * How long a verification link lives, and how often one may be re-sent.
 *
 * Seven days is the figure the design's own copy states, and it suits a link
 * that unlocks nothing: unlike a reset link there is no credential behind it,
 * so the cost of a long window is low and the cost of a short one — a customer
 * who opens their mail on Monday and finds a dead link — is real.
 *
 * The cooldown is what makes a re-send idempotent rather than merely limited: a
 * second request inside it issues nothing and sends nothing, so a retried
 * click cannot produce two links. The window budget bounds the day.
 */
export const EMAIL_VERIFICATION_TOKEN_TTL_DAYS = 7;

/** A re-send inside this window is a no-op rather than a second link. */
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_MINUTES = 5;

/** Verification links one account may be issued inside the window below. */
export const EMAIL_VERIFICATION_MAX_PER_WINDOW = 5;

export const EMAIL_VERIFICATION_WINDOW_MINUTES = 24 * 60;

export function emailVerificationExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + EMAIL_VERIFICATION_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function emailVerificationCooldownStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - EMAIL_VERIFICATION_RESEND_COOLDOWN_MINUTES * 60 * 1000);
}

export function emailVerificationWindowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - EMAIL_VERIFICATION_WINDOW_MINUTES * 60 * 1000);
}
