/**
 * How long a reset link lives, and how many a single account may be issued.
 *
 * Thirty minutes is what the design's own copy states, and it is the right
 * order of magnitude for a link that replaces a password: long enough to
 * survive a slow inbox, short enough that a link left in a mail archive is dead
 * by the time anybody finds it.
 *
 * The per-account budget is the control that matters. The IP throttle in front
 * of the endpoint stops one machine hammering it; this stops a distributed
 * caller from using the reset endpoint as a way to fill a stranger's inbox,
 * because the budget is counted against the account being reset rather than
 * against whoever asked.
 */
export const PASSWORD_RESET_TOKEN_TTL_MINUTES = 30;

/** Reset links one account may be issued inside the window below. */
export const PASSWORD_RESET_MAX_PER_WINDOW = 3;

export const PASSWORD_RESET_WINDOW_MINUTES = 60;

export function passwordResetExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000);
}

export function passwordResetWindowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - PASSWORD_RESET_WINDOW_MINUTES * 60 * 1000);
}
