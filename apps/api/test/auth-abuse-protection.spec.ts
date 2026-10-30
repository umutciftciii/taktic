import { UserRole } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_TEMPORARILY_LOCKED_CODE,
  INVALID_CREDENTIALS_CODE,
  LOGIN_ATTEMPT_POLICIES,
  LoginAttemptService,
  LoginTemporarilyLockedException,
  attemptKeyHash,
  loginAttemptKeys,
} from '../src/modules/auth/login-attempts.service';
import { TestTurnstileVerifier } from '../src/modules/turnstile/test-turnstile.verifier';
import {
  TURNSTILE_ACTIONS,
  TURNSTILE_TEST_TOKEN_PREFIX,
  TURNSTILE_TOKEN_HEADER,
  type TurnstileAction,
} from '../src/modules/turnstile/turnstile.constants';
import { TEST_ACCOUNT_PASSWORD, generateFixturePassword } from './fixture-password';
import {
  createTestApp,
  createUser,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * SEC-AUTH-ABUSE-001, through real HTTP against the deterministic Turnstile
 * verifier: the guard, its replay cache and the persistent attempt scopes are
 * the real ones. The in-memory address throttle is reset before every call —
 * its own behaviour is auth-rate-limit.spec.ts's — so what answers here is the
 * lock, never the throttle.
 */

let ctx: TestContext;
let attempts: LoginAttemptService;

beforeAll(async () => {
  ctx = await createTestApp({ turnstileVerifier: new TestTurnstileVerifier() });
  attempts = ctx.app.get(LoginAttemptService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  resetAuthThrottle(ctx.app);
});

const PASSWORD = TEST_ACCOUNT_PASSWORD;
const PAIR_LIMIT = LOGIN_ATTEMPT_POLICIES.IP_ACCOUNT.limit;

function token(action: TurnstileAction): string {
  return `${TURNSTILE_TEST_TOKEN_PREFIX}${action}:${uniqueSuffix()}${Math.random().toString(36).slice(2)}`;
}

async function login(email: string, password: string, turnstile: string | null = token(TURNSTILE_ACTIONS.login)) {
  resetAuthThrottle(ctx.app);
  const call = request(ctx.server).post('/auth/login');
  if (turnstile !== null) call.set(TURNSTILE_TOKEN_HEADER, turnstile);
  return call.send({ email, password });
}

async function counterRows() {
  return ctx.prisma.authAttemptCounter.findMany();
}

describe('sign-in — Turnstile is enforced on the server', () => {
  it('refuses a sign-in without a token, before any attempt is counted or any session issued', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });

    const response = await login(user.email!, PASSWORD, null);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TURNSTILE_REQUIRED');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await counterRows()).toEqual([]);
    expect(await ctx.prisma.session.count()).toBe(0);
  });

  it('refuses a token minted for another operation', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });

    const response = await login(user.email!, PASSWORD, token(TURNSTILE_ACTIONS.register));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TURNSTILE_FAILED');
  });

  it('accepts a token once: the replay is refused even with the right password', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    const once = token(TURNSTILE_ACTIONS.login);

    expect((await login(user.email!, PASSWORD, once)).status).toBe(201);
    const replay = await login(user.email!, PASSWORD, once);

    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe('TURNSTILE_FAILED');
    expect(await ctx.prisma.session.count()).toBe(1);
  });

  it('lets exactly one of two concurrent uses of the same token through', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    const once = token(TURNSTILE_ACTIONS.login);

    const statuses = (await Promise.all([login(user.email!, PASSWORD, once), login(user.email!, PASSWORD, once)]))
      .map((response) => response.status)
      .sort();

    expect(statuses).toEqual([201, 403]);
  });

  it('fails closed with 503 when the verifier cannot be asked', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });

    const response = await login(user.email!, PASSWORD, `${TURNSTILE_TEST_TOKEN_PREFIX}__unavailable__:${uniqueSuffix()}`);

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('TURNSTILE_UNAVAILABLE');
    expect(await ctx.prisma.session.count()).toBe(0);
  });

  it('signs a staff account in under the same rules as everybody else', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.ADMIN, password: PASSWORD });

    expect((await login(admin.email!, PASSWORD, null)).status).toBe(403);
    expect((await login(admin.email!, PASSWORD)).status).toBe(201);
  });
});

describe('sign-in — the answer never says whether the account exists', () => {
  it('answers a wrong password and an unknown e-mail with the same status and body', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });

    const wrongPassword = await login(user.email!, 'WrongPassword!1');
    const unknownEmail = await login(`kimse-${uniqueSuffix()}@example.test`, 'WrongPassword!1');
    const passwordless = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: null });
    const noPassword = await login(passwordless.email!, 'WrongPassword!1');

    for (const response of [wrongPassword, unknownEmail, noPassword]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        statusCode: 401,
        error: 'Unauthorized',
        code: INVALID_CREDENTIALS_CODE,
        message: 'E-posta veya şifre hatalı.',
      });
    }
  });

  it('does not reveal an inactive account to somebody without its password', async () => {
    const inactive = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD, isActive: false });

    const guess = await login(inactive.email!, 'WrongPassword!1');
    expect(guess.status).toBe(401);
    expect(guess.body.code).toBe(INVALID_CREDENTIALS_CODE);

    // The owner, who knows the password, is told.
    expect((await login(inactive.email!, PASSWORD)).status).toBe(403);
  });

  it('locks an unknown e-mail exactly like a known one, with the same refusal', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    const unknown = `kimse-${uniqueSuffix()}@example.test`;

    const known: number[] = [];
    const absent: number[] = [];
    for (let attempt = 0; attempt <= PAIR_LIMIT; attempt += 1) {
      known.push((await login(user.email!, 'WrongPassword!1')).status);
      absent.push((await login(unknown, 'WrongPassword!1')).status);
    }

    expect(known).toEqual(absent);
    expect(known.at(-1)).toBe(429);
    const lockedKnown = await login(user.email!, 'WrongPassword!1');
    const lockedUnknown = await login(unknown, 'WrongPassword!1');
    expect(lockedKnown.body).toEqual(lockedUnknown.body);
    expect(lockedKnown.body.code).toBe(AUTH_TEMPORARILY_LOCKED_CODE);
    expect(JSON.stringify(lockedKnown.body)).not.toMatch(/hesap bulunamad|kayıtlı değil|not found/i);
  });

  it('keeps no e-mail or address in the clear', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    await login(user.email!, 'WrongPassword!1');

    const dump = JSON.stringify(await counterRows());
    expect(dump).not.toContain(user.email!);
    expect(dump).not.toContain('127.0.0.1');
  });
});

describe('sign-in — the account lock', () => {
  it(`locks the address/account pair after ${PAIR_LIMIT} wrong passwords, and the right password is refused too`, async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < PAIR_LIMIT; attempt += 1) {
      statuses.push((await login(user.email!, 'WrongPassword!1')).status);
    }
    expect(statuses.every((status) => status === 401)).toBe(true);

    const locked = await login(user.email!, PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe(AUTH_TEMPORARILY_LOCKED_CODE);
    expect(locked.headers['set-cookie']).toBeUndefined();
    expect(await ctx.prisma.session.count()).toBe(0);
  });

  it('does not lock a person who mistypes a few times and then gets it right — repeatedly', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });

    for (let round = 0; round < 3; round += 1) {
      for (let attempt = 0; attempt < PAIR_LIMIT - 1; attempt += 1) {
        expect((await login(user.email!, 'WrongPassword!1')).status).toBe(401);
      }
      expect((await login(user.email!, PASSWORD)).status).toBe(201);
    }
  });

  it('a correct sign-in leaves no pair counter behind and gives its attempt back to the wider scopes', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });

    expect((await login(user.email!, PASSWORD)).status).toBe(201);

    const rows = await counterRows();
    expect(rows.find((row) => row.scope === 'IP_ACCOUNT')).toBeUndefined();
    for (const row of rows) {
      expect(row.attempts).toBe(0);
      expect(row.lockedUntil).toBeNull();
    }
  });

  it('a completed password reset lifts the lock on that e-mail', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    for (let attempt = 0; attempt < PAIR_LIMIT; attempt += 1) {
      await login(user.email!, 'WrongPassword!1');
    }
    expect((await login(user.email!, PASSWORD)).status).toBe(429);

    const reset = await request(ctx.server)
      .post('/auth/password-reset')
      .set(TURNSTILE_TOKEN_HEADER, token(TURNSTILE_ACTIONS.passwordReset))
      .send({ email: user.email });
    expect(reset.status).toBe(201);
    const url = ctx.notifications.lastOfTemplate('password-reset')?.actionUrl;
    const raw = new URL(url!).searchParams.get('token')!;
    const newPassword = generateFixturePassword();
    resetAuthThrottle(ctx.app);
    await request(ctx.server).post('/auth/password-reset/confirm').send({ token: raw, password: newPassword }).expect(201);

    expect((await login(user.email!, newPassword)).status).toBe(201);
  });

  it('a lock elsewhere does not touch another account from the same address', async () => {
    const victim = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    const other = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    for (let attempt = 0; attempt <= PAIR_LIMIT; attempt += 1) {
      await login(victim.email!, 'WrongPassword!1');
    }

    expect((await login(other.email!, PASSWORD)).status).toBe(201);
  });
});

describe('LoginAttemptService — scopes, windows and races', () => {
  const email = () => `scope-${uniqueSuffix()}@example.test`;
  const pairOf = (keys: ReturnType<typeof loginAttemptKeys>) => keys.find((key) => key.scope === 'IP_ACCOUNT')!.keyHash;

  async function claims(keys: ReturnType<typeof loginAttemptKeys>, count: number, now?: Date) {
    const results = await Promise.allSettled(Array.from({ length: count }, () => attempts.claim(keys, now)));
    return {
      allowed: results.filter((result) => result.status === 'fulfilled').length,
      refused: results.filter(
        (result) => result.status === 'rejected' && result.reason instanceof LoginTemporarilyLockedException,
      ).length,
    };
  }

  it('lets exactly the pair limit through when thirty attempts arrive at once', async () => {
    const keys = loginAttemptKeys(email(), '203.0.113.7');

    const { allowed, refused } = await claims(keys, 30);

    expect(allowed).toBe(PAIR_LIMIT);
    expect(refused).toBe(30 - PAIR_LIMIT);
  });

  it('locks the account across addresses once its own limit is spent', async () => {
    const account = email();
    const limit = LOGIN_ATTEMPT_POLICIES.ACCOUNT.limit;
    for (let i = 0; i < limit; i += 1) {
      const keys = loginAttemptKeys(account, `198.51.100.${i + 1}`);
      await attempts.claim(keys);
      await attempts.failed(keys);
    }

    await expect(attempts.claim(loginAttemptKeys(account, '192.0.2.200'))).rejects.toBeInstanceOf(
      LoginTemporarilyLockedException,
    );
    // A different account from that fresh address is unaffected.
    await expect(attempts.claim(loginAttemptKeys(email(), '192.0.2.200'))).resolves.toBeUndefined();
  });

  it('an address that is locked spends nothing from the accounts it keeps trying', async () => {
    const limit = LOGIN_ATTEMPT_POLICIES.IP.limit;
    for (let i = 0; i < limit; i += 1) {
      const keys = loginAttemptKeys(email(), '203.0.113.77');
      await attempts.claim(keys);
      await attempts.failed(keys);
    }
    const victim = email();
    await claims(loginAttemptKeys(victim, '203.0.113.77'), 20);

    expect(
      await ctx.prisma.authAttemptCounter.findUnique({
        where: { scope_keyHash: { scope: 'ACCOUNT', keyHash: attemptKeyHash('ACCOUNT', victim) } },
      }),
    ).toBeNull();
  });

  it('one address hammering one account locks the pair, not the account', async () => {
    const account = email();
    await claims(loginAttemptKeys(account, '203.0.113.78'), 40);

    await expect(attempts.claim(loginAttemptKeys(account, '192.0.2.78'))).resolves.toBeUndefined();
  });

  it('locks an address that sprays many accounts, and only that address', async () => {
    const limit = LOGIN_ATTEMPT_POLICIES.IP.limit;
    for (let i = 0; i < limit; i += 1) {
      const keys = loginAttemptKeys(email(), '203.0.113.99');
      await attempts.claim(keys);
      await attempts.failed(keys);
    }

    await expect(attempts.claim(loginAttemptKeys(email(), '203.0.113.99'))).rejects.toBeInstanceOf(
      LoginTemporarilyLockedException,
    );
    await expect(attempts.claim(loginAttemptKeys(email(), '203.0.113.100'))).resolves.toBeUndefined();
  });

  it('successful sign-ins from a shared address never add up to an address lock', async () => {
    const limit = LOGIN_ATTEMPT_POLICIES.IP.limit;
    for (let i = 0; i < limit + 10; i += 1) {
      const keys = loginAttemptKeys(email(), '203.0.113.50');
      await attempts.claim(keys);
      await attempts.succeeded(keys);
    }

    await expect(attempts.claim(loginAttemptKeys(email(), '203.0.113.50'))).resolves.toBeUndefined();
  });

  it("a person's own success gives back only their own attempts, never a guesser's from elsewhere", async () => {
    const account = email();
    for (let i = 0; i < 6; i += 1) {
      const keys = loginAttemptKeys(account, `198.51.100.${i + 1}`);
      await attempts.claim(keys);
      await attempts.failed(keys);
    }
    const own = loginAttemptKeys(account, '192.0.2.10');
    for (let i = 0; i < 2; i += 1) {
      await attempts.claim(own);
      await attempts.failed(own);
    }
    await attempts.claim(own);
    await attempts.succeeded(own);

    const row = await ctx.prisma.authAttemptCounter.findUniqueOrThrow({
      where: { scope_keyHash: { scope: 'ACCOUNT', keyHash: own.find((key) => key.scope === 'ACCOUNT')!.keyHash } },
    });
    expect(row.attempts).toBe(6);
  });

  it('a lock ends after its duration, and the window starts over', async () => {
    const keys = loginAttemptKeys(email(), '203.0.113.8');
    const start = new Date();
    for (let i = 0; i < PAIR_LIMIT; i += 1) {
      await attempts.claim(keys, start);
      await attempts.failed(keys, start);
    }
    await expect(attempts.claim(keys, new Date(start.getTime() + 60_000))).rejects.toBeInstanceOf(
      LoginTemporarilyLockedException,
    );

    const after = new Date(start.getTime() + LOGIN_ATTEMPT_POLICIES.IP_ACCOUNT.lockMs + 1_000);
    await expect(attempts.claim(keys, after)).resolves.toBeUndefined();
    const pair = await ctx.prisma.authAttemptCounter.findUniqueOrThrow({
      where: { scope_keyHash: { scope: 'IP_ACCOUNT', keyHash: pairOf(keys) } },
    });
    expect(pair.attempts).toBe(1);
    expect(pair.lockedUntil).toBeNull();
  });

  it('a locked scope is not locked for longer by being knocked on', async () => {
    const keys = loginAttemptKeys(email(), '203.0.113.9');
    const start = new Date();
    for (let i = 0; i < PAIR_LIMIT; i += 1) {
      await attempts.claim(keys, start);
      await attempts.failed(keys, start);
    }
    const before = await ctx.prisma.authAttemptCounter.findUniqueOrThrow({
      where: { scope_keyHash: { scope: 'IP_ACCOUNT', keyHash: pairOf(keys) } },
    });
    await claims(keys, 5, new Date(start.getTime() + 5 * 60_000));
    const after = await ctx.prisma.authAttemptCounter.findUniqueOrThrow({
      where: { scope_keyHash: { scope: 'IP_ACCOUNT', keyHash: pairOf(keys) } },
    });

    expect(after.lockedUntil).toEqual(before.lockedUntil);
    expect(after.attempts).toBe(before.attempts);
  });

  it('digests are domain-separated per scope', () => {
    expect(attemptKeyHash('ACCOUNT', 'x')).not.toBe(attemptKeyHash('IP', 'x'));
    expect(attemptKeyHash('ACCOUNT', 'x')).not.toBe(createHash('sha256').update('x').digest('hex'));
  });
});

describe('registration, password reset and verification resend — Turnstile on the server', () => {
  const routes: { name: string; action: TurnstileAction; send: (t: string | null) => Promise<request.Response> }[] = [
    {
      name: 'register-customer',
      action: TURNSTILE_ACTIONS.register,
      send: (t) => post('/auth/register-customer', t, registration()),
    },
    {
      name: 'register-provider',
      action: TURNSTILE_ACTIONS.register,
      send: (t) => post('/auth/register-provider', t, registration()),
    },
    {
      name: 'password-reset',
      action: TURNSTILE_ACTIONS.passwordReset,
      send: (t) => post('/auth/password-reset', t, { email: `kimse-${uniqueSuffix()}@example.test` }),
    },
  ];

  function registration() {
    const suffix = uniqueSuffix();
    return { name: `Kayıt ${suffix}`, email: `kayit-${suffix}@example.test`, password: PASSWORD };
  }

  function post(path: string, t: string | null, body: object, cookie?: string) {
    resetAuthThrottle(ctx.app);
    const call = request(ctx.server).post(path);
    if (t !== null) call.set(TURNSTILE_TOKEN_HEADER, t);
    if (cookie) call.set('Cookie', cookie);
    return call.send(body);
  }

  for (const route of routes) {
    it(`${route.name}: refuses no token, a foreign token and a replay; accepts a fresh one`, async () => {
      const usersBefore = await ctx.prisma.user.count();

      expect((await route.send(null)).body.code).toBe('TURNSTILE_REQUIRED');
      expect((await route.send(token(TURNSTILE_ACTIONS.login))).body.code).toBe('TURNSTILE_FAILED');
      expect(await ctx.prisma.user.count()).toBe(usersBefore);
      expect(ctx.notifications.sent.length).toBe(0);

      const once = token(route.action);
      expect([200, 201]).toContain((await route.send(once)).status);
      const replay = await route.send(once);
      expect(replay.status).toBe(403);
      expect(replay.body.code).toBe('TURNSTILE_FAILED');
    });
  }

  it('email-verification resend: refuses without a token, before the session is even read', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    const cookie = await loginAs(ctx.prisma, user.id);

    const without = await post('/auth/email-verification/resend', null, {}, cookie);
    expect(without.status).toBe(403);
    expect(without.body.code).toBe('TURNSTILE_REQUIRED');
    expect(ctx.notifications.sent.length).toBe(0);

    const once = token(TURNSTILE_ACTIONS.emailVerificationResend);
    expect((await post('/auth/email-verification/resend', once, {}, cookie)).status).toBe(201);
    expect((await post('/auth/email-verification/resend', once, {}, cookie)).body.code).toBe('TURNSTILE_FAILED');

    // No session: still the token question first, then the session one.
    const anonymous = await post('/auth/email-verification/resend', token(TURNSTILE_ACTIONS.emailVerificationResend), {});
    expect(anonymous.status).toBe(401);
  });

  it('the confirm steps need no token: the mailed link is the proof', async () => {
    const response = await post('/auth/password-reset/confirm', null, { token: 'x'.repeat(43), password: PASSWORD });
    expect(response.body.code).not.toBe('TURNSTILE_REQUIRED');
  });
});

describe('auth-lock:clear — the operator break-glass', () => {
  it('names the e-mail twice and only reads without --apply', async () => {
    const { parseArgs } = await import('../src/scripts/clear-auth-lock');
    expect(() => parseArgs(['clear', '--email', 'a@b.co', '--confirm-email', 'x@b.co'])).toThrow(/repeat --email/);
    expect(() => parseArgs(['inspect', '--email', 'a@b.co', '--apply'])).toThrow(/only reads/);
    expect(parseArgs(['--', 'clear', '--email', ' A@B.co ', '--confirm-email', 'a@b.co'])).toEqual({
      command: 'clear',
      email: 'a@b.co',
      confirmEmail: 'a@b.co',
      apply: false,
    });
  });

  it('lifts the account and pair locks of that e-mail, and no address lock', async () => {
    const { clearAuthLock, inspectAuthLock } = await import('../src/scripts/clear-auth-lock');
    const locked = `ops-${uniqueSuffix()}@example.test`;
    const keys = loginAttemptKeys(locked, '203.0.113.200');
    for (let i = 0; i < PAIR_LIMIT; i += 1) {
      await attempts.claim(keys);
      await attempts.failed(keys);
    }
    expect((await inspectAuthLock(ctx.prisma, locked)).some((row) => row.locked)).toBe(true);

    expect(await clearAuthLock(ctx.prisma, locked)).toBe(2);
    expect(await inspectAuthLock(ctx.prisma, locked)).toEqual([]);
    expect(await ctx.prisma.authAttemptCounter.count({ where: { scope: 'IP' } })).toBe(1);
    await expect(attempts.claim(keys)).resolves.toBeUndefined();
  });
});
