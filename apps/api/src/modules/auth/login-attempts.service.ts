import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * SEC-AUTH-ABUSE-001: the persistent half of sign-in abuse protection.
 *
 * The in-memory AuthThrottlerGuard bounds how fast one client may call the
 * credential routes, per process. This bounds how many *guesses* anybody gets,
 * in three scopes that are judged together on every attempt:
 *
 *   IP_ACCOUNT  one address against one e-mail — what an ordinary typo burns,
 *               and the first to lock, so a person mistyping their own
 *               password is stopped before they touch the wider scopes
 *   ACCOUNT     one e-mail, from every address — what a distributed guesser
 *               against one account runs into
 *   IP          one address, against every e-mail — what credential stuffing
 *               from one address runs into
 *
 * Counted in PostgreSQL rather than in memory, so a lock survives a restart
 * and holds across every API instance. Each attempt is one atomic upsert per
 * scope that increments and judges in the same statement: of fifty concurrent
 * attempts against a scope with five left, exactly five reach the password
 * check and the rest are refused without a bcrypt call.
 *
 * What the caller learns is the same whether or not the e-mail belongs to an
 * account. An unknown e-mail is counted and locked exactly like a known one,
 * so "too many attempts" is never a membership oracle.
 *
 * Failure is never silent: a database error propagates and the sign-in is
 * refused with it, rather than the check being skipped.
 */

export type AttemptScope = 'ACCOUNT' | 'IP' | 'IP_ACCOUNT';

export type AttemptPolicy = {
  /** Attempts that may reach the password check within one window. */
  limit: number;
  windowMs: number;
  /** How long the scope stays refused once the limit is reached. */
  lockMs: number;
};

const MINUTE = 60 * 1000;

/**
 * The defaults, in code rather than the environment on purpose: a lock is a
 * security decision, and a typo in a variable must not be able to turn it off.
 * The reasoning for each figure is in docs/security/sec-auth-abuse-001.md.
 */
export const LOGIN_ATTEMPT_POLICIES: Readonly<Record<AttemptScope, AttemptPolicy>> = {
  IP_ACCOUNT: { limit: 5, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE },
  ACCOUNT: { limit: 10, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE },
  IP: { limit: 50, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE },
};

/** Rows untouched for this long are swept; no window or lock outlives it. */
export const LOGIN_ATTEMPT_RETENTION_MS = 24 * 60 * MINUTE;
/** One sweep per this many claims, per process. */
const SWEEP_EVERY = 200;

export const AUTH_TEMPORARILY_LOCKED_CODE = 'AUTH_TEMPORARILY_LOCKED';
export const INVALID_CREDENTIALS_CODE = 'INVALID_CREDENTIALS';

/**
 * The one refusal a lock produces, in every scope. It names no scope: "this
 * address is locked" and "this account is locked" would each tell a guesser
 * something the other does not.
 */
export class LoginTemporarilyLockedException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        code: AUTH_TEMPORARILY_LOCKED_CODE,
        message:
          'Çok fazla başarısız giriş denemesi yapıldı. Lütfen bir süre sonra tekrar deneyin ' +
          'veya şifrenizi sıfırlayın.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export type AttemptKeys = { scope: AttemptScope; keyHash: string; accountKeyHash: string | null }[];

/** The digest of one scope's key. Domain-separated so two scopes never collide. */
export function attemptKeyHash(scope: AttemptScope, material: string): string {
  return createHash('sha256').update(`taktic:auth-attempt:${scope}:${material}`, 'utf8').digest('hex');
}

/**
 * The three keys of one attempt. `email` is the normalized address the caller
 * typed; `ip` is Express `req.ip` (TRUST_PROXY decides what that is), or null.
 * An attempt with no known address is counted under one shared "unknown" key
 * rather than not counted at all.
 */
export function loginAttemptKeys(email: string, ip: string | null): AttemptKeys {
  const address = ip?.trim() || 'unknown';
  const account = attemptKeyHash('ACCOUNT', email);
  // The order is the order claim() walks them in, and it is load-bearing: an
  // address that is locked touches no account's count, and an attempt the
  // pair refused is not spent from the account — so neither a spraying address
  // nor one address hammering one account can lock that account for everybody.
  return [
    { scope: 'IP', keyHash: attemptKeyHash('IP', address), accountKeyHash: null },
    { scope: 'IP_ACCOUNT', keyHash: attemptKeyHash('IP_ACCOUNT', `${address}\n${email}`), accountKeyHash: account },
    { scope: 'ACCOUNT', keyHash: account, accountKeyHash: null },
  ];
}

type ClaimRow = { attempts: number; lockedUntil: Date | null };

/**
 * A timestamp as the columns hold it: UTC, without a zone. Passed as text and
 * cast in the statement, so the session's TimeZone setting cannot shift it.
 */
function ts(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

@Injectable()
export class LoginAttemptService {
  private readonly logger = new Logger(LoginAttemptService.name);
  private claims = 0;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /**
   * Spends one attempt in every scope, or refuses.
   *
   * Counted *before* the password is checked, so the count bounds concurrent
   * attempts too; a correct password gives its attempt back (`succeeded`).
   * The scopes are claimed in loginAttemptKeys' order — address, pair,
   * account — and the first refusal stops the walk: an attempt the address or
   * the pair already refused is not also spent from the account. Otherwise one
   * address hammering one account would lock that account for everybody,
   * which is the pair lock's job to absorb. A scope that is already locked is not counted again either — a
   * locked account is not locked for longer by being knocked on.
   */
  async claim(keys: AttemptKeys, now: Date = new Date()): Promise<void> {
    let refused = false;
    for (const key of keys) {
      if (refused) {
        break;
      }
      const policy = LOGIN_ATTEMPT_POLICIES[key.scope];
      const windowStart = new Date(now.getTime() - policy.windowMs);
      const lockEnd = new Date(now.getTime() + policy.lockMs);
      const rows = await this.prisma.$queryRaw<ClaimRow[]>`
        INSERT INTO "AuthAttemptCounter" AS c
          ("scope", "keyHash", "accountKeyHash", "attempts", "windowStartedAt", "lockedUntil", "updatedAt")
        VALUES (${key.scope}, ${key.keyHash}, ${key.accountKeyHash}, 1, ${ts(now)}::timestamp(3),
          NULL, ${ts(now)}::timestamp(3))
        ON CONFLICT ("scope", "keyHash") DO UPDATE SET
          "attempts" = CASE
            WHEN c."lockedUntil" > ${ts(now)}::timestamp(3) THEN c."attempts"
            WHEN c."lockedUntil" IS NOT NULL OR c."windowStartedAt" <= ${ts(windowStart)}::timestamp(3) THEN 1
            ELSE c."attempts" + 1
          END,
          "windowStartedAt" = CASE
            WHEN c."lockedUntil" > ${ts(now)}::timestamp(3) THEN c."windowStartedAt"
            WHEN c."lockedUntil" IS NOT NULL OR c."windowStartedAt" <= ${ts(windowStart)}::timestamp(3) THEN ${ts(now)}::timestamp(3)
            ELSE c."windowStartedAt"
          END,
          "lockedUntil" = CASE
            WHEN c."lockedUntil" > ${ts(now)}::timestamp(3) THEN c."lockedUntil"
            WHEN c."lockedUntil" IS NULL
              AND c."windowStartedAt" > ${ts(windowStart)}::timestamp(3)
              AND c."attempts" + 1 > ${policy.limit}
              THEN ${ts(lockEnd)}::timestamp(3)
            ELSE NULL
          END,
          "updatedAt" = ${ts(now)}::timestamp(3)
        RETURNING "attempts", "lockedUntil"
      `;
      const row = rows[0];
      if (!row || (row.lockedUntil && row.lockedUntil > now) || row.attempts > policy.limit) {
        refused = true;
      }
    }

    await this.maybeSweep(now);

    if (refused) {
      throw new LoginTemporarilyLockedException();
    }
  }

  /**
   * A wrong password: the attempt stays counted, and a scope that has now
   * spent its last attempt locks at once rather than on the next knock.
   */
  async failed(keys: AttemptKeys, now: Date = new Date()): Promise<void> {
    for (const key of keys) {
      const policy = LOGIN_ATTEMPT_POLICIES[key.scope];
      const lockEnd = new Date(now.getTime() + policy.lockMs);
      await this.prisma.$executeRaw`
        UPDATE "AuthAttemptCounter"
        SET "lockedUntil" = ${ts(lockEnd)}::timestamp(3), "updatedAt" = ${ts(now)}::timestamp(3)
        WHERE "scope" = ${key.scope} AND "keyHash" = ${key.keyHash}
          AND "attempts" >= ${policy.limit}
          AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${ts(now)}::timestamp(3))
      `;
    }
  }

  /**
   * A correct password. The pair is cleared — the person at this address has
   * proved who they are — and what that pair had put on the account and the
   * address is given back with it, so somebody who mistypes now and then is
   * never walked into the wider locks by their own typos. Nothing else is
   * given back: a success must not wipe out what somebody else has been doing
   * to the same account, or from the same address.
   */
  async succeeded(keys: AttemptKeys, now: Date = new Date()): Promise<void> {
    const pair = keys.find((key) => key.scope === 'IP_ACCOUNT');
    let returned = 1;
    if (pair) {
      const rows = await this.prisma.$queryRaw<{ attempts: number }[]>`
        DELETE FROM "AuthAttemptCounter" WHERE "scope" = 'IP_ACCOUNT' AND "keyHash" = ${pair.keyHash}
        RETURNING "attempts"
      `;
      returned = Math.max(1, rows[0]?.attempts ?? 1);
    }
    for (const key of keys) {
      if (key.scope === 'IP_ACCOUNT') {
        continue;
      }
      await this.prisma.$executeRaw`
        UPDATE "AuthAttemptCounter"
        SET "attempts" = GREATEST("attempts" - ${returned}, 0), "updatedAt" = ${ts(now)}::timestamp(3)
        WHERE "scope" = ${key.scope} AND "keyHash" = ${key.keyHash}
          AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${ts(now)}::timestamp(3))
      `;
    }
  }

  /**
   * A completed password reset: the mailbox has just been proved, so every
   * lock on this e-mail — the account's own and every address's pair with it —
   * is lifted. This is the self-service way out of a lock somebody else
   * caused. Address locks are left alone; they are not this account's.
   */
  async clearAccount(email: string): Promise<void> {
    const account = attemptKeyHash('ACCOUNT', email);
    await this.prisma.$executeRaw`
      DELETE FROM "AuthAttemptCounter"
      WHERE ("scope" = 'ACCOUNT' AND "keyHash" = ${account})
         OR ("scope" = 'IP_ACCOUNT' AND "accountKeyHash" = ${account})
    `;
  }

  private async maybeSweep(now: Date): Promise<void> {
    this.claims += 1;
    if (this.claims % SWEEP_EVERY !== 0) {
      return;
    }
    try {
      await this.prisma.$executeRaw`
        DELETE FROM "AuthAttemptCounter"
        WHERE "updatedAt" < ${ts(new Date(now.getTime() - LOGIN_ATTEMPT_RETENTION_MS))}::timestamp(3)
          AND ("lockedUntil" IS NULL OR "lockedUntil" < ${ts(now)}::timestamp(3))
      `;
    } catch (error) {
      // Housekeeping only: a failed sweep leaves old rows for the next one and
      // decides nothing about the attempt in hand.
      this.logger.warn(`auth attempt sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
