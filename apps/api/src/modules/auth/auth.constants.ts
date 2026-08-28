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
 * "Beni hatırla" is a different policy, not a longer cookie. It has its own idle
 * window as well as its own absolute lifetime, and both are enforced on the
 * server from `Session.rememberMe`.
 *
 * Giving it only a longer cookie was the mistake this replaces. With one shared
 * 30-minute idle window, a remembered session was indistinguishable from an
 * ordinary one after half an hour of quiet: the persistent cookie bought
 * exactly the first thirty minutes after a browser restart and nothing else,
 * which is not what anybody ticking the box is asking for. What they are asking
 * for is "do not make me sign in again on this device", and that is a longer
 * idle window — so it is one.
 *
 * The two policies remain the same *shape*: an idle clock activity slides, an
 * absolute clock nothing does. Only the durations differ.
 *
 * Every value is read from the environment on each call rather than captured at
 * import time, so a test (and a deployment) sees the environment it actually
 * has.
 */

/** 30 minutes of inactivity ends an ordinary session. */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 30 * 60;
/** 8 hours — one working day, and long enough that nobody meets it by accident. */
const DEFAULT_ABSOLUTE_TTL_SECONDS = 8 * 60 * 60;
/**
 * 30 days of inactivity ends a remembered session.
 *
 * The same figure as its absolute lifetime below, and deliberately so: what
 * "Beni hatırla" promises is a month on this device, and a shorter idle window
 * would quietly take most of that back. It is a separate setting rather than a
 * derived one because they answer different questions — "how long may this
 * device stay signed in without being used" and "how long may this session
 * exist at all" — and an operator must be able to shorten one without the
 * other.
 */
const DEFAULT_REMEMBER_ME_IDLE_TIMEOUT_SECONDS = 30 * 24 * 60 * 60;
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
/**
 * And a day for a remembered one.
 *
 * Two minutes would be useless here: a month-long session reaches its last two
 * minutes at an hour nobody is watching, so the warning would fire into an
 * empty room and the person would find out by being signed out. A day is long
 * enough that somebody who uses the device at all that week sees it. Nothing
 * depends on them seeing it — the server ends the session either way — so this
 * is a courtesy, sized to when it can actually be one.
 */
const DEFAULT_REMEMBER_ME_IDLE_WARNING_SECONDS = 24 * 60 * 60;

export function sessionIdleTimeoutSeconds(): number {
  return readPositiveInt('SESSION_IDLE_TIMEOUT_SECONDS', DEFAULT_IDLE_TIMEOUT_SECONDS);
}

export function sessionRememberMeIdleTimeoutSeconds(): number {
  return readPositiveInt(
    'SESSION_REMEMBER_ME_IDLE_TIMEOUT_SECONDS',
    DEFAULT_REMEMBER_ME_IDLE_TIMEOUT_SECONDS,
  );
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
 * The inactivity window this session runs under.
 *
 * Every caller that decides whether a session is still alive goes through here
 * rather than reading a constant, so the two policies cannot drift apart — and
 * so a remembered session cannot be validated against the ordinary window by a
 * caller that forgot which kind it was holding.
 */
export function sessionIdleTimeoutSecondsFor(rememberMe: boolean): number {
  return rememberMe ? sessionRememberMeIdleTimeoutSeconds() : sessionIdleTimeoutSeconds();
}

/**
 * How long before the cut-off the client offers to keep the session.
 *
 * Clamped to that session's own idle window: a warning that fired later than
 * the cut-off would never be seen, and one that fired earlier than the whole
 * window would be on screen from the moment of login.
 */
export function sessionIdleWarningSecondsFor(rememberMe: boolean): number {
  const configured = rememberMe
    ? readPositiveInt(
        'SESSION_REMEMBER_ME_IDLE_WARNING_SECONDS',
        DEFAULT_REMEMBER_ME_IDLE_WARNING_SECONDS,
      )
    : readPositiveInt('SESSION_IDLE_WARNING_SECONDS', DEFAULT_IDLE_WARNING_SECONDS);

  return Math.min(configured, sessionIdleTimeoutSecondsFor(rememberMe));
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
  // Both policies, so a typo in the remembered one is a startup failure rather
  // than something the first person to tick the box discovers.
  sessionTouchIntervalSeconds();
  for (const rememberMe of [false, true]) {
    sessionIdleTimeoutSecondsFor(rememberMe);
    sessionTtlSecondsFor(rememberMe);
    sessionIdleWarningSecondsFor(rememberMe);
  }
}
