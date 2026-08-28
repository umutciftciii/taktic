import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  sessionIdleTimeoutSecondsFor,
  sessionIdleWarningSecondsFor,
  sessionTtlSecondsFor,
} from './auth.constants';

export type SessionMeta = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type SessionOptions = {
  /** Whether the person ticked "Beni hatırla". Defaults to false everywhere. */
  rememberMe?: boolean;
};

/** The absolute expiry a session created now would carry. */
export function sessionExpiry(rememberMe = false, now: Date = new Date()) {
  return new Date(now.getTime() + sessionTtlSecondsFor(rememberMe) * 1000);
}

/**
 * When inactivity alone would end this session.
 *
 * `rememberMe` is a parameter rather than a lookup because the two policies have
 * different windows, and the caller always knows which kind of session it is
 * holding — it is a column on the row. Defaulting it would let a remembered
 * session be measured against the ordinary window by a caller that simply
 * forgot to pass it, which is exactly the mistake this signature exists to make
 * impossible.
 */
export function idleExpiry(lastSeenAt: Date, rememberMe: boolean) {
  return new Date(lastSeenAt.getTime() + sessionIdleTimeoutSecondsFor(rememberMe) * 1000);
}

/**
 * The moment a session actually ends: whichever of the two clocks runs out
 * first. Both are the server's, read from the row.
 */
export function effectiveExpiry(session: {
  expiresAt: Date;
  lastSeenAt: Date;
  rememberMe: boolean;
}) {
  const idle = idleExpiry(session.lastSeenAt, session.rememberMe);
  return idle < session.expiresAt ? idle : session.expiresAt;
}

/**
 * The session's own view of itself, for a client that wants to warn somebody
 * before their session ends.
 *
 * `serverTime` travels with it deliberately. A client must measure the time it
 * has left against the clock that will actually decide, not against its own —
 * a browser clock moved forward by a day must not end a live session, and one
 * moved backwards must not keep a dead one alive. Nothing here is a decision:
 * the server refuses the next request regardless of what the client concluded.
 */
export function toSessionStatus(session: {
  expiresAt: Date;
  lastSeenAt: Date;
  rememberMe: boolean;
}) {
  return {
    rememberMe: session.rememberMe,
    absoluteExpiresAt: session.expiresAt.toISOString(),
    idleExpiresAt: idleExpiry(session.lastSeenAt, session.rememberMe).toISOString(),
    expiresAt: effectiveExpiry(session).toISOString(),
    // This session's own policy, not the deployment's default one — the client
    // needs the window it is actually running under to know when to warn.
    idleTimeoutSeconds: sessionIdleTimeoutSecondsFor(session.rememberMe),
    idleWarningSeconds: sessionIdleWarningSecondsFor(session.rememberMe),
    serverTime: new Date().toISOString(),
  };
}

export type SessionStatus = ReturnType<typeof toSessionStatus>;

/**
 * Issues a login session. Shared by password login, registration, customer
 * activation and the provider claim so all four produce identical session
 * semantics.
 *
 * The id is 256 bits of crypto-random rather than the schema's default cuid:
 * this value is a bearer secret, and a sortable identifier is the wrong shape
 * for one.
 */
export async function createSessionForUser(
  client: Pick<Prisma.TransactionClient, 'session' | 'user'>,
  userId: string,
  meta: SessionMeta,
  options: SessionOptions = {},
) {
  const rememberMe = options.rememberMe === true;
  const expiresAt = sessionExpiry(rememberMe);
  const session = await client.session.create({
    data: {
      id: randomBytes(32).toString('hex'),
      userId,
      expiresAt,
      rememberMe,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });

  await client.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date() },
  });

  return { sessionId: session.id, expiresAt, rememberMe };
}
