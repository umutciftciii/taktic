import { UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PASSWORD_RESET_MAX_PER_WINDOW,
  PASSWORD_RESET_TOKEN_TTL_MINUTES,
} from '../src/modules/password-reset/password-reset.constants';
import {
  createTestApp,
  createUser,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The reset flow's security properties, exercised through the real HTTP routes.
 *
 * Four of them are load-bearing and each has a case here: the endpoint is not an
 * account-enumeration oracle, the token is single use and expiring, the raw
 * token never appears anywhere but the URL, and a successful reset closes every
 * session the old password opened.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  // These cases legitimately hit a credential endpoint many times each; the
  // limiter's own behaviour is covered in auth-rate-limit.spec.ts.
  resetAuthThrottle(ctx.app);
});

const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'YeniSifre456!';

function tokenOf(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

function lastResetUrl(): string {
  const message = ctx.notifications.lastOfTemplate('password-reset');
  if (!message?.actionUrl) {
    throw new Error('no password reset link was sent');
  }
  return message.actionUrl;
}

async function requestReset(email: string) {
  return request(ctx.server).post('/auth/password-reset').send({ email }).expect(201);
}

describe('password reset — issuing', () => {
  it('answers identically whether or not the address is registered', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });

    const known = await requestReset(user.email!);
    const unknown = await requestReset('kimse-yok@example.test');

    expect(known.body).toEqual(unknown.body);
    expect(known.status).toBe(unknown.status);

    // Only the real account got a link, and the response said nothing about it.
    expect(ctx.notifications.ofTemplate('password-reset')).toHaveLength(1);
    expect(JSON.stringify(known.body)).not.toContain(user.email!);
  });

  it('says nothing different for an account that has no password to reset', async () => {
    const claimable = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: null });

    const response = await requestReset(claimable.email!);

    expect(response.body).toEqual({ status: 'accepted' });
    // The activation link is that account's route to a first password; a reset
    // link would be a second, weaker one.
    expect(ctx.notifications.ofTemplate('password-reset')).toHaveLength(0);
  });

  it('says nothing different for an inactive account', async () => {
    const inactive = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      password: PASSWORD,
      isActive: false,
    });

    const response = await requestReset(inactive.email!);

    expect(response.body).toEqual({ status: 'accepted' });
    expect(ctx.notifications.ofTemplate('password-reset')).toHaveLength(0);
  });

  it('caps how many links one account can be sent', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });

    for (let attempt = 0; attempt < PASSWORD_RESET_MAX_PER_WINDOW + 3; attempt += 1) {
      // The per-caller limiter is cleared between attempts so this case can
      // reach the per-account budget, which is the control under test: it is
      // what stops a distributed caller from filling one stranger's inbox.
      resetAuthThrottle(ctx.app);
      const response = await requestReset(user.email!);
      // Being over budget is invisible: a different answer here would tell a
      // caller that this address exists.
      expect(response.body).toEqual({ status: 'accepted' });
    }

    expect(ctx.notifications.ofTemplate('password-reset')).toHaveLength(
      PASSWORD_RESET_MAX_PER_WINDOW,
    );
  });

  it('keeps at most one link alive, and stores only its hash', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });

    await requestReset(user.email!);
    const firstToken = tokenOf(lastResetUrl());
    await requestReset(user.email!);
    const secondToken = tokenOf(lastResetUrl());

    expect(firstToken).not.toBe(secondToken);

    const rows = await ctx.prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.usedAt === null)).toHaveLength(1);

    // The raw token is nowhere in the table; only sha256(raw) is.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(firstToken);
    expect(serialized).not.toContain(secondToken);
    expect(rows.some((row) => row.tokenHash === sha256(secondToken))).toBe(true);

    // The superseded link is dead.
    await request(ctx.server)
      .post('/auth/password-reset/confirm')
      .send({ token: firstToken, password: NEW_PASSWORD })
      .expect(400);
  });

  it('sets the expiry the message states', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    const before = Date.now();

    await requestReset(user.email!);

    const row = await ctx.prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id },
    });
    const ttlMs = row.expiresAt.getTime() - before;

    expect(ttlMs).toBeGreaterThan((PASSWORD_RESET_TOKEN_TTL_MINUTES - 1) * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual((PASSWORD_RESET_TOKEN_TTL_MINUTES + 1) * 60 * 1000);

    const message = ctx.notifications.lastOfTemplate('password-reset');
    expect(message?.data?.expiryMinutes).toBe(String(PASSWORD_RESET_TOKEN_TTL_MINUTES));
  });

  it('keeps the token out of the audit trail and the log line', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    await requestReset(user.email!);
    const token = tokenOf(lastResetUrl());

    const logs = await ctx.prisma.notificationLog.findMany({ where: { template: 'password-reset' } });
    expect(logs).toHaveLength(1);

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(user.email!);
    expect(serialized).not.toContain('sifre-sifirla');
    expect(logs[0]!.maskedRecipient).toMatch(/^.\*+@/);
  });
});

describe('password reset — consuming', () => {
  async function issueFor(user: { id: string; email: string | null }) {
    await requestReset(user.email!);
    return tokenOf(lastResetUrl());
  }

  it('validates a live link and refuses everything else the same way', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    const token = await issueFor(user);

    const valid = await request(ctx.server)
      .get(`/auth/password-reset?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(valid.body.valid).toBe(true);
    expect(valid.body.email).toBe(user.email);

    await request(ctx.server).get('/auth/password-reset?token=uydurma').expect(400);
  });

  it('sets the new password and revokes every session', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    const cookie = await loginAs(ctx.prisma, user.id);

    // The session works before the reset.
    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(200);

    const token = await issueFor(user);
    const response = await request(ctx.server)
      .post('/auth/password-reset/confirm')
      .send({ token, password: NEW_PASSWORD })
      .expect(201);

    expect(response.body).toEqual({ success: true });
    // No session is handed back: the reset is not a sign-in.
    expect(response.headers['set-cookie']).toBeUndefined();

    // The old session is gone with the old password.
    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(401);

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(NEW_PASSWORD, stored.passwordHash!)).toBe(true);
    expect(await bcrypt.compare(PASSWORD, stored.passwordHash!)).toBe(false);

    // And the new one works.
    await request(ctx.server)
      .post('/auth/login')
      .send({ email: user.email, password: NEW_PASSWORD })
      .expect(201);
  });

  it('refuses a second use of the same link', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    const token = await issueFor(user);

    await request(ctx.server)
      .post('/auth/password-reset/confirm')
      .send({ token, password: NEW_PASSWORD })
      .expect(201);

    await request(ctx.server)
      .post('/auth/password-reset/confirm')
      .send({ token, password: 'UcuncuSifre789!' })
      .expect(400);

    // The second attempt changed nothing.
    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(NEW_PASSWORD, stored.passwordHash!)).toBe(true);
  });

  it('refuses an expired link', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    const token = await issueFor(user);

    await ctx.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await request(ctx.server).get(`/auth/password-reset?token=${token}`).expect(400);
    await request(ctx.server)
      .post('/auth/password-reset/confirm')
      .send({ token, password: NEW_PASSWORD })
      .expect(400);

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(PASSWORD, stored.passwordHash!)).toBe(true);
  });

  it('refuses a link whose account was deactivated in the meantime', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    const token = await issueFor(user);

    await ctx.prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    await request(ctx.server)
      .post('/auth/password-reset/confirm')
      .send({ token, password: NEW_PASSWORD })
      .expect(400);
  });

  it('enforces the same password bounds the activation form does', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: PASSWORD });
    const token = await issueFor(user);

    await request(ctx.server)
      .post('/auth/password-reset/confirm')
      .send({ token, password: 'kisa' })
      .expect(400);

    // The token survives a rejected password — the link is not burned by a typo.
    await request(ctx.server)
      .post('/auth/password-reset/confirm')
      .send({ token, password: NEW_PASSWORD })
      .expect(201);
  });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
