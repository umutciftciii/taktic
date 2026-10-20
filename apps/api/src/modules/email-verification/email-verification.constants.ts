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

/**
 * Why a verification link was refused (STAGING-UAT-001 B3).
 *
 * Every refusal is still a 400; the code is what lets the confirmation page say
 * the right thing and offer the right next step, instead of one sentence that
 * blamed a dead link for a link that had simply been used already.
 *
 * Only the holder of a link that exists can see a code other than INVALID, and
 * a link is 32 random bytes compared by hash — so the code tells nobody
 * anything they could not already learn by reading that mailbox. Everything
 * that could describe somebody else's account (an unknown link, a link whose
 * address the account has since left, a deactivated account) stays INVALID.
 */
export const EMAIL_VERIFICATION_INVALID = 'EMAIL_VERIFICATION_INVALID';
export const EMAIL_VERIFICATION_EXPIRED = 'EMAIL_VERIFICATION_EXPIRED';
export const EMAIL_VERIFICATION_ALREADY_VERIFIED = 'EMAIL_VERIFICATION_ALREADY_VERIFIED';

export type EmailVerificationRefusalCode =
  | typeof EMAIL_VERIFICATION_INVALID
  | typeof EMAIL_VERIFICATION_EXPIRED
  | typeof EMAIL_VERIFICATION_ALREADY_VERIFIED;
