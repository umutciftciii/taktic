import { CustomerOrigin, UserRole } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomerActivationService } from '../src/modules/customer-activation/customer-activation.service';
import { EMAIL_VERIFICATION_TOKEN_TTL_DAYS } from '../src/modules/email-verification/email-verification.constants';
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
 * Proving mailbox ownership after registration.
 *
 * The cases below cover the three things that make this safe to add next to the
 * activation flow rather than on top of it: the two lifecycles never overlap, a
 * repeat request is idempotent instead of a second link, and the token is
 * hashed, expiring and single use like every other one in this codebase.
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
  resetAuthThrottle(ctx.app);
});

const PASSWORD = 'Password123!';

function tokenOf(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

function lastVerifyUrl(): string {
  const message = ctx.notifications.lastOfTemplate('email-verification');
  if (!message?.actionUrl) {
    throw new Error('no verification link was sent');
  }
  return message.actionUrl;
}

async function registerCustomer() {
  const suffix = uniqueSuffix();
  const email = `kayit-${suffix}@example.test`;
  const response = await request(ctx.server)
    .post('/auth/register-customer')
    .send({
      name: 'Deniz Yılmaz',
      email,
      phone: `0555777${suffix.padStart(4, '0')}`,
      password: PASSWORD,
    })
    .expect(201);

  const setCookie = response.headers['set-cookie'];
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) {
    throw new Error('registration did not issue a session cookie');
  }

  return { email, userId: response.body.id as string, cookie: header.split(';')[0]! };
}

describe('e-mail verification — issuing', () => {
  it('mails a link when a customer registers, to the address they registered with', async () => {
    const { email, userId } = await registerCustomer();

    const messages = ctx.notifications.ofTemplate('email-verification');
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.to).toBe(email);
    expect(message.subject).toBe("TakTick'e hoş geldiniz — e-postanızı doğrulayın");
    expect(message.data?.expiryDays).toBe(String(EMAIL_VERIFICATION_TOKEN_TTL_DAYS));

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.emailVerifiedAt).toBeNull();
  });

  it('does not mail a provider registration', async () => {
    const suffix = uniqueSuffix();
    await request(ctx.server)
      .post('/auth/register-provider')
      .send({
        name: 'Murat Şahin',
        email: `veren-${suffix}@example.test`,
        phone: `0555888${suffix.padStart(4, '0')}`,
        password: PASSWORD,
      })
      .expect(201);

    expect(ctx.notifications.ofTemplate('email-verification')).toHaveLength(0);
  });

  it('treats an immediate re-send as the same request rather than a second link', async () => {
    const { cookie } = await registerCustomer();

    const first = await request(ctx.server)
      .post('/auth/email-verification/resend')
      .set('Cookie', cookie)
      .expect(201);
    const second = await request(ctx.server)
      .post('/auth/email-verification/resend')
      .set('Cookie', cookie)
      .expect(201);

    expect(first.body).toEqual({ status: 'accepted' });
    expect(second.body).toEqual(first.body);
    // Still exactly the one issued at registration.
    expect(ctx.notifications.ofTemplate('email-verification')).toHaveLength(1);
  });

  it('refuses a re-send from somebody with no session', async () => {
    await registerCustomer();
    await request(ctx.server).post('/auth/email-verification/resend').expect(401);
  });

  it('issues a fresh link once the cooldown has passed, and kills the old one', async () => {
    const { cookie, userId } = await registerCustomer();
    const firstToken = tokenOf(lastVerifyUrl());

    // Age the issued token past the cooldown without waiting for it.
    await ctx.prisma.emailVerificationToken.updateMany({
      where: { userId },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    await request(ctx.server)
      .post('/auth/email-verification/resend')
      .set('Cookie', cookie)
      .expect(201);

    const secondToken = tokenOf(lastVerifyUrl());
    expect(secondToken).not.toBe(firstToken);

    await request(ctx.server)
      .post('/auth/email-verification/confirm')
      .send({ token: firstToken })
      .expect(400);
    await request(ctx.server)
      .post('/auth/email-verification/confirm')
      .send({ token: secondToken })
      .expect(201);
  });

  it('stores only the hash, and never the link', async () => {
    const { userId } = await registerCustomer();
    const token = tokenOf(lastVerifyUrl());

    const rows = await ctx.prisma.emailVerificationToken.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);

    const logs = await ctx.prisma.notificationLog.findMany({
      where: { template: 'email-verification' },
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('e-posta-dogrula');
  });
});

describe('e-mail verification — consuming', () => {
  it('records the proof and refuses the link a second time', async () => {
    const { userId } = await registerCustomer();
    const token = tokenOf(lastVerifyUrl());

    const first = await request(ctx.server)
      .post('/auth/email-verification/confirm')
      .send({ token })
      .expect(201);
    expect(first.body).toEqual({ success: true, alreadyVerified: false });

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.emailVerifiedAt).not.toBeNull();

    await request(ctx.server)
      .post('/auth/email-verification/confirm')
      .send({ token })
      .expect(400);
  });

  it('refuses an expired link', async () => {
    const { userId } = await registerCustomer();
    const token = tokenOf(lastVerifyUrl());

    await ctx.prisma.emailVerificationToken.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await request(ctx.server).get(`/auth/email-verification?token=${token}`).expect(400);
    await request(ctx.server)
      .post('/auth/email-verification/confirm')
      .send({ token })
      .expect(400);

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.emailVerifiedAt).toBeNull();
  });

  it('refuses a link whose address the account has since left', async () => {
    const { userId } = await registerCustomer();
    const token = tokenOf(lastVerifyUrl());

    await ctx.prisma.user.update({
      where: { id: userId },
      data: { email: `tasindi-${uniqueSuffix()}@example.test` },
    });

    // The snapshot no longer matches, so the link cannot verify the new address.
    await request(ctx.server)
      .post('/auth/email-verification/confirm')
      .send({ token })
      .expect(400);

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.emailVerifiedAt).toBeNull();
  });

  it('stops issuing links once the address is verified', async () => {
    const { cookie } = await registerCustomer();
    const token = tokenOf(lastVerifyUrl());

    await request(ctx.server)
      .post('/auth/email-verification/confirm')
      .send({ token })
      .expect(201);

    ctx.notifications.clear();
    await request(ctx.server)
      .post('/auth/email-verification/resend')
      .set('Cookie', cookie)
      .expect(201);

    expect(ctx.notifications.ofTemplate('email-verification')).toHaveLength(0);
  });
});

describe('e-mail verification and account activation are separate lifecycles', () => {
  it('never sends a verification link to a password-less auto-created account', async () => {
    const guest = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      password: null,
      customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
    });

    await ctx.app.get(CustomerActivationService).issueForAutoCreatedCustomer(guest.id);

    // The activation link is that account's whole route to a usable password;
    // a verification link alongside it would be a second, ambiguous one.
    expect(ctx.notifications.ofTemplate('customer-activation')).toHaveLength(1);
    expect(ctx.notifications.ofTemplate('email-verification')).toHaveLength(0);
  });

  it('counts a consumed activation link as proof of the mailbox', async () => {
    const guest = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      password: null,
      customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
    });

    await ctx.app.get(CustomerActivationService).issueForAutoCreatedCustomer(guest.id);
    const activationUrl = ctx.notifications.lastOfTemplate('customer-activation')?.actionUrl;
    expect(activationUrl).toBeTruthy();

    await request(ctx.server)
      .post('/auth/customer-activation')
      .send({ token: tokenOf(activationUrl!), password: PASSWORD })
      .expect(201);

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: guest.id } });
    expect(stored.passwordHash).not.toBeNull();
    expect(stored.emailVerifiedAt).not.toBeNull();
  });

  it('leaves an unverified account able to sign in and use the product', async () => {
    const { email, cookie } = await registerCustomer();

    // Nothing is gated on verification, so the session registration issued
    // still works and a fresh login still works.
    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(200);
    await request(ctx.server)
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);
  });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
