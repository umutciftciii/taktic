export const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

/**
 * The session policy, in one place.
 *
 * Two independent clocks end a session, and neither extends the other:
 *
 *   idle       rejected once `now - lastSeenAt` exceeds the inactivity window.
 *              Activity slides this window and nothing else.
 *   absolute   `expiresAt`, fixed when the session is created and never moved
 *              forward. There is no sliding session and no session that renews
 *              itself forever.
 *
 * "Beni hatırla" changes the absolute clock and the cookie's persistence. It
 * deliberately does NOT relax the idle window: a remembered session left alone
 * on a shared machine ends after the same half hour as any other.
 *
 * Every value is read from the environment on each call rather than captured at
 * import time, so a test (and a deployment) sees the environment it actually
 * has.
 */

/** 30 minutes. */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 30 * 60;
/** 8 hours — one working day, and long enough that nobody meets it by accident. */
const DEFAULT_ABSOLUTE_TTL_SECONDS = 8 * 60 * 60;
/** 30 days, the lifetime "Beni hatırla" promises. */
const DEFAULT_REMEMBER_ME_TTL_SECONDS = 30 * 24 * 60 * 60;
/** 5 minutes between `lastSeenAt` writes, so an active user is not a write hot spot. */
const DEFAULT_TOUCH_INTERVAL_SECONDS = 5 * 60;
/**
 * How long before the idle cut-off the client is offered a chance to stay
 * signed in. Two minutes: long enough to notice, short enough that the offer is
 * about this session rather than a permanent banner.
 */
const DEFAULT_IDLE_WARNING_SECONDS = 2 * 60;

export function sessionIdleTimeoutSeconds(): number {
  return readPositiveInt('SESSION_IDLE_TIMEOUT_SECONDS', DEFAULT_IDLE_TIMEOUT_SECONDS);
}

export function sessionAbsoluteTtlSeconds(): number {
  return readPositiveInt('SESSION_ABSOLUTE_TTL_SECONDS', DEFAULT_ABSOLUTE_TTL_SECONDS);
}

export function sessionRememberMeTtlSeconds(): number {
  return readPositiveInt('SESSION_REMEMBER_ME_TTL_SECONDS', DEFAULT_REMEMBER_ME_TTL_SECONDS);
}

export function sessionTouchIntervalSeconds(): number {
  return readPositiveInt('SESSION_TOUCH_INTERVAL_SECONDS', DEFAULT_TOUCH_INTERVAL_SECONDS);
}

/**
 * Clamped to the idle window: a warning that fired later than the cut-off would
 * never be seen, and one that fired earlier than the whole window would be on
 * screen from the moment of login.
 */
export function sessionIdleWarningSeconds(): number {
  const configured = readPositiveInt('SESSION_IDLE_WARNING_SECONDS', DEFAULT_IDLE_WARNING_SECONDS);
  return Math.min(configured, sessionIdleTimeoutSeconds());
}

/** The absolute lifetime this session gets, given how it was asked for. */
export function sessionTtlSecondsFor(rememberMe: boolean): number {
  return rememberMe ? sessionRememberMeTtlSeconds() : sessionAbsoluteTtlSeconds();
}

/**
 * A misconfigured duration is a startup failure rather than a silent fallback.
 *
 * Getting this wrong in either direction is a security decision made by
 * accident — a typo that reads as zero would end every session on the next
 * request, and one that reads as NaN would silently restore a default nobody
 * chose.
 */
function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number of seconds (received "${raw}")`);
  }

  return parsed;
}

/**
 * Called once at boot so a bad duration stops the process instead of surfacing
 * on somebody's first sign-in.
 */
export function assertSessionPolicyConfig(): void {
  sessionIdleTimeoutSeconds();
  sessionAbsoluteTtlSeconds();
  sessionRememberMeTtlSeconds();
  sessionTouchIntervalSeconds();
  sessionIdleWarningSeconds();
}
