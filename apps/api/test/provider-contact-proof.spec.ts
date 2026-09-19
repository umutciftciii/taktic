import { CustomerActivationDelivery, UserRole } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OTP_MAX_ATTEMPTS,
  OTP_MAX_SENDS_PER_PHONE_PER_HOUR,
} from '../src/modules/phone-verification/phone-verification.constants';
import {
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * AUTH-PROVIDER-CONTACT-001 — a provider account proves its own e-mail address
 * and telephone number on the same two columns a customer does
 * (`User.emailVerifiedAt`, `User.phoneVerifiedAt`), by the same two means: a
 * link that was actually delivered to the mailbox, and a one-time code that
 * was actually sent to the number. Nothing is gated on either proof; the
 * account works exactly as before with both columns NULL.
 *
 * Every case that writes a proof also asserts what it did *not* do: no other
 * account's column moved, no request or lead was touched, and no credit or
 * campaign row appeared — the campaign engine that will one day read these
 * facts is not in this codebase yet, and this suite is what says so.
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
  ctx.sms.clear();
  resetAuthThrottle(ctx.app);
});

const PROVIDER_PHONE = '05553334455';
const PROVIDER_PHONE_E164 = '+905553334455';

async function providerAccount(overrides: { phone?: string | null; withProfile?: boolean } = {}) {
  const user = await createUser(ctx.prisma, {
    role: UserRole.PROVIDER,
    phone: overrides.phone === undefined ? PROVIDER_PHONE : overrides.phone,
    email: `veren-${uniqueSuffix()}@example.test`,
    name: 'Murat Şahin',
  });
  if (overrides.withProfile !== false) {
    await createProviderProfile(ctx.prisma, { userId: user.id });
  }
  const cookie = await loginAs(ctx.prisma, user.id);
  return { user, cookie };
}

async function proofs(userId: string) {
  return ctx.prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { phone: true, email: true, phoneVerifiedAt: true, emailVerifiedAt: true },
  });
}

/** Nothing outside the account's own two columns may move. */
async function ledger() {
  return {
    creditTransactions: await ctx.prisma.providerCreditTransaction.count(),
    serviceRequestsVerified: await ctx.prisma.serviceRequest.count({ where: { phoneVerifiedAt: { not: null } } }),
    showcaseLeads: await ctx.prisma.showcaseLead.count(),
  };
}

function sendAccountCode(cookie: string) {
  return request(ctx.server).post('/providers/me/phone-verification').set('Cookie', cookie);
}

function verifyAccountCode(cookie: string, code: string) {
  return request(ctx.server).post('/providers/me/phone-verification/verify').set('Cookie', cookie).send({ code });
}

function tokenOf(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

// ───────────────────────────────── e-mail ─────────────────────────────────

describe('provider e-mail proof', () => {
  it('mails the provider a verification link of its own template, and only the mailed link writes the proof', async () => {
    const { user, cookie } = await providerAccount();
    const before = await ledger();

    await request(ctx.server).post('/auth/email-verification/resend').set('Cookie', cookie).expect(201);

    // The provider template, to the account's own address — not the customer
    // welcome, and never the customer's "first request" copy.
    const mails = ctx.notifications.ofTemplate('provider-email-verification');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe(user.email);
    expect(ctx.notifications.ofTemplate('email-verification')).toHaveLength(0);
    expect(mails[0]!.actionUrl).toMatch(/\/e-posta-dogrula\?token=/);

    // Only the hash is stored; the link exists in the mail alone.
    const token = tokenOf(mails[0]!.actionUrl!);
    const rows = await ctx.prisma.emailVerificationToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(await ctx.prisma.notificationLog.findMany())).not.toContain(token);

    // Nothing is proven by asking.
    expect((await proofs(user.id)).emailVerifiedAt).toBeNull();

    const confirmed = await request(ctx.server).post('/auth/email-verification/confirm').send({ token }).expect(201);
    expect(confirmed.body).toEqual({ success: true, alreadyVerified: false, accountKind: 'PROVIDER' });

    const after = await proofs(user.id);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(after.phoneVerifiedAt).toBeNull();

    // Single use.
    await request(ctx.server).post('/auth/email-verification/confirm').send({ token }).expect(400);
    expect(await ledger()).toEqual(before);
  });

  it('is issued at provider registration too, best-effort and to the registered address', async () => {
    const suffix = uniqueSuffix();
    const email = `yeni-veren-${suffix}@example.test`;
    await request(ctx.server)
      .post('/auth/register-provider')
      .send({ name: 'Murat Şahin', email, phone: `0555888${suffix.padStart(4, '0')}`, password: 'Password123!' })
      .expect(201);

    const mails = ctx.notifications.ofTemplate('provider-email-verification');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe(email);
    expect(ctx.notifications.ofTemplate('email-verification')).toHaveLength(0);
  });

  it('keeps the customer template for a customer, and stays silent for an operator', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await request(ctx.server)
      .post('/auth/email-verification/resend')
      .set('Cookie', await loginAs(ctx.prisma, customer.id))
      .expect(201);
    expect(ctx.notifications.ofTemplate('email-verification')).toHaveLength(1);
    expect(ctx.notifications.ofTemplate('provider-email-verification')).toHaveLength(0);

    ctx.notifications.clear();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await request(ctx.server)
      .post('/auth/email-verification/resend')
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(201);
    expect(ctx.notifications.sent).toHaveLength(0);
    expect(await ctx.prisma.emailVerificationToken.count({ where: { userId: admin.id } })).toBe(0);
  });

  it('refuses a re-send without a session, and issues nothing to a provider already proven', async () => {
    await request(ctx.server).post('/auth/email-verification/resend').expect(401);

    const { user, cookie } = await providerAccount();
    await ctx.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    await request(ctx.server).post('/auth/email-verification/resend').set('Cookie', cookie).expect(201);
    expect(ctx.notifications.sent).toHaveLength(0);
    expect(await ctx.prisma.emailVerificationToken.count()).toBe(0);
  });

  it('works for a provider account with no profile yet — the proof belongs to the account', async () => {
    const { user, cookie } = await providerAccount({ withProfile: false });
    await request(ctx.server).post('/auth/email-verification/resend').set('Cookie', cookie).expect(201);
    const token = tokenOf(ctx.notifications.lastOfTemplate('provider-email-verification')!.actionUrl!);
    await request(ctx.server).post('/auth/email-verification/confirm').send({ token }).expect(201);
    expect((await proofs(user.id)).emailVerifiedAt).not.toBeNull();
  });

  it('is never written by an activation token of admin or unknown delivery', async () => {
    // A provider account is not an auto-created customer, so the activation
    // flow refuses it outright; the tokens below are the shapes AUTH-EMAIL-001
    // says prove nothing, and this pins that they prove nothing here either.
    const { user } = await providerAccount();
    for (const delivery of [CustomerActivationDelivery.ADMIN_LINK, null]) {
      const raw = `raw-${uniqueSuffix()}`;
      await ctx.prisma.customerActivationToken.create({
        data: {
          customerId: user.id,
          tokenHash: createHash('sha256').update(raw).digest('hex'),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          delivery,
        },
      });
      const res = await request(ctx.server)
        .post('/auth/customer-activation')
        .send({ token: raw, password: 'Password123!' });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect((await proofs(user.id)).emailVerifiedAt).toBeNull();
  });
});

// ───────────────────────────────── telefon ────────────────────────────────

describe('provider phone proof — the happy path', () => {
  it('sends a code to the account number and a correct code writes only this account\'s proof', async () => {
    const { user, cookie } = await providerAccount();
    const bystander = await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: '05559990001' });
    const before = await ledger();

    const sent = await sendAccountCode(cookie).expect(201);
    expect(sent.body).toMatchObject({ status: 'sent', maskedPhone: expect.stringContaining('***') });
    expect(JSON.stringify(sent.body)).not.toContain(ctx.sms.lastCode());
    expect(ctx.sms.sent).toHaveLength(1);
    expect(ctx.sms.sent[0]!.to).toBe(PROVIDER_PHONE_E164);

    const row = await ctx.prisma.phoneVerification.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.requestId).toBeNull();
    expect(row.normalizedPhone).toBe(PROVIDER_PHONE_E164);
    expect(row.consumedAt).toBeNull();

    const verified = await verifyAccountCode(cookie, ctx.sms.lastCode()).expect(201);
    expect(verified.body).toMatchObject({ status: 'verified' });

    const after = await proofs(user.id);
    expect(after.phoneVerifiedAt).not.toBeNull();
    expect(after.emailVerifiedAt).toBeNull();
    // The stored spelling is untouched: the proof is about the number, not its format.
    expect(after.phone).toBe(PROVIDER_PHONE);

    expect((await proofs(bystander.id)).phoneVerifiedAt).toBeNull();
    expect((await ctx.prisma.phoneVerification.findUniqueOrThrow({ where: { id: row.id } })).consumedAt).not.toBeNull();
    expect(await ledger()).toEqual(before);
  });

  it('refuses the same code a second time and a fresh send once proven', async () => {
    const { cookie } = await providerAccount();
    await sendAccountCode(cookie).expect(201);
    const code = ctx.sms.lastCode();
    await verifyAccountCode(cookie, code).expect(201);

    await verifyAccountCode(cookie, code).expect(409);
    await sendAccountCode(cookie).expect(409);
    expect(ctx.sms.sent).toHaveLength(1);
  });

  it('works for a provider account with no profile yet', async () => {
    const { user, cookie } = await providerAccount({ withProfile: false });
    await sendAccountCode(cookie).expect(201);
    await verifyAccountCode(cookie, ctx.sms.lastCode()).expect(201);
    expect((await proofs(user.id)).phoneVerifiedAt).not.toBeNull();
  });

  it('retires the outstanding code when a new one is sent', async () => {
    const { user, cookie } = await providerAccount();
    await sendAccountCode(cookie).expect(201);
    const first = ctx.sms.lastCode();
    await sendAccountCode(cookie).expect(201);
    const second = ctx.sms.lastCode();

    await verifyAccountCode(cookie, first).expect(400);
    await verifyAccountCode(cookie, second).expect(201);
    expect((await proofs(user.id)).phoneVerifiedAt).not.toBeNull();
  });
});

describe('provider phone proof — refusals', () => {
  it('answers one 400 for a wrong, an expired and a locked code, and never writes', async () => {
    const { user, cookie } = await providerAccount();
    await sendAccountCode(cookie).expect(201);
    const code = ctx.sms.lastCode();
    const wrong = code === '000000' ? '000001' : '000000';

    for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
      const res = await verifyAccountCode(cookie, wrong).expect(400);
      expect(res.body.code).toBe('PHONE_VERIFICATION_INVALID');
    }
    // Locked now: the right code is refused with the same answer.
    await verifyAccountCode(cookie, code).expect(400);

    // Expired: a fresh row past its time.
    await ctx.prisma.phoneVerification.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000), lockedUntil: null },
    });
    await verifyAccountCode(cookie, code).expect(400);

    expect((await proofs(user.id)).phoneVerifiedAt).toBeNull();
  });

  it('refuses a code sent to another account, and a code for a number the account no longer has', async () => {
    const owner = await providerAccount();
    const other = await providerAccount({ phone: '05559990002' });

    await sendAccountCode(owner.cookie).expect(201);
    const ownersCode = ctx.sms.lastCode();

    // The other provider cannot spend the owner's code: there is no row for them.
    await verifyAccountCode(other.cookie, ownersCode).expect(400);
    expect((await proofs(other.user.id)).phoneVerifiedAt).toBeNull();

    // The number moved under the code (no provider path does this today; the
    // guard is what keeps that true whatever path appears): the code proves
    // the old number and lands nowhere.
    await ctx.prisma.user.update({ where: { id: owner.user.id }, data: { phone: '+905559990003' } });
    await verifyAccountCode(owner.cookie, ownersCode).expect(400);
    expect((await proofs(owner.user.id)).phoneVerifiedAt).toBeNull();
  });

  it('answers 409 for an account with no number, and for one already proven', async () => {
    const noPhone = await providerAccount({ phone: null });
    const res = await sendAccountCode(noPhone.cookie).expect(409);
    expect(res.body.code).toBe('ACCOUNT_PHONE_MISSING');
    await verifyAccountCode(noPhone.cookie, '123456').expect(400);

    const proven = await providerAccount();
    await ctx.prisma.user.update({ where: { id: proven.user.id }, data: { phoneVerifiedAt: new Date() } });
    const again = await sendAccountCode(proven.cookie).expect(409);
    expect(again.body.code).toBe('ACCOUNT_PHONE_ALREADY_VERIFIED');
    await verifyAccountCode(proven.cookie, '123456').expect(409);

    expect(ctx.sms.sent).toHaveLength(0);
    expect(await ctx.prisma.phoneVerification.count()).toBe(0);
  });

  it('refuses a customer, an operator and an anonymous caller, with no side effect', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    for (const user of [customer, admin]) {
      const cookie = await loginAs(ctx.prisma, user.id);
      await sendAccountCode(cookie).expect(403);
      await verifyAccountCode(cookie, '123456').expect(403);
    }
    await request(ctx.server).post('/providers/me/phone-verification').expect(401);
    await request(ctx.server).post('/providers/me/phone-verification/verify').send({ code: '123456' }).expect(401);

    expect(ctx.sms.sent).toHaveLength(0);
    expect(await ctx.prisma.phoneVerification.count()).toBe(0);
    expect((await proofs(customer.id)).phoneVerifiedAt).toBeNull();
  });

  it('keeps the per-number send budget', async () => {
    const { cookie } = await providerAccount();
    for (let i = 0; i < OTP_MAX_SENDS_PER_PHONE_PER_HOUR; i += 1) {
      await sendAccountCode(cookie).expect(201);
    }
    await sendAccountCode(cookie).expect(429);
    expect(ctx.sms.sent).toHaveLength(OTP_MAX_SENDS_PER_PHONE_PER_HOUR);
  });

  it('rejects a malformed code before any lookup', async () => {
    const { cookie } = await providerAccount();
    await sendAccountCode(cookie).expect(201);
    await verifyAccountCode(cookie, '12ab').expect(400);
    await request(ctx.server)
      .post('/providers/me/phone-verification/verify')
      .set('Cookie', cookie)
      .send({})
      .expect(400);
  });
});

describe('the account code stays apart from the lead and request codes', () => {
  it('cannot be redeemed as a vitrin lead proof, and a lead send does not retire it', async () => {
    const { user, cookie } = await providerAccount();
    await sendAccountCode(cookie).expect(201);
    const accountCode = ctx.sms.lastCode();

    // A lead verification for the same number: its own row, its own code.
    await request(ctx.server).post('/showcase/lead-verification').send({ phone: PROVIDER_PHONE }).expect(200);
    const leadCode = ctx.sms.lastCode();
    expect(leadCode).not.toBe(accountCode);

    const rows = await ctx.prisma.phoneVerification.findMany({ where: { normalizedPhone: PROVIDER_PHONE_E164 } });
    expect(rows.filter((r) => r.userId === user.id && r.consumedAt === null)).toHaveLength(1);
    expect(rows.filter((r) => r.userId === null && r.requestId === null && r.consumedAt === null)).toHaveLength(1);

    // The lead code cannot prove the account; the account code cannot prove the lead.
    await verifyAccountCode(cookie, leadCode).expect(400);
    await request(ctx.server)
      .post('/showcase/lead-verification/verify')
      .send({ phone: PROVIDER_PHONE, code: accountCode })
      .expect(400);

    // Each code lands only on its own row.
    await verifyAccountCode(cookie, accountCode).expect(201);
    expect((await proofs(user.id)).phoneVerifiedAt).not.toBeNull();
    const leadRow = await ctx.prisma.phoneVerification.findFirstOrThrow({
      where: { normalizedPhone: PROVIDER_PHONE_E164, userId: null, requestId: null },
    });
    expect(leadRow.consumedAt).toBeNull();
  });

  it('a customer\'s request verification and the request gate behave as before', async () => {
    // The customer path is the one AUTH-PHONE-001 pinned; this is the smoke
    // test that opening the table to account rows changed nothing about it.
    process.env.REQUIRE_PHONE_VERIFICATION = 'true';
    try {
      const category = await createCategory(ctx.prisma, 'Klima');
      const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05557770001' });
      const cookie = await loginAs(ctx.prisma, customer.id);
      const created = await request(ctx.server)
        .post('/service-requests')
        .set('Cookie', cookie)
        .send({
          ...serviceRequestPayload(category.slug),
          customerName: undefined,
          customerPhone: undefined,
          customerEmail: undefined,
        })
        .expect(201);
      const requestId = created.body.id as string;

      await request(ctx.server).post(`/service-requests/${requestId}/phone-verification`).set('Cookie', cookie).expect(201);
      await request(ctx.server)
        .post(`/service-requests/${requestId}/phone-verification/verify`)
        .set('Cookie', cookie)
        .send({ code: ctx.sms.lastCode() })
        .expect(201);

      const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(row.phoneVerifiedAt).not.toBeNull();
      expect((await proofs(customer.id)).phoneVerifiedAt).not.toBeNull();
      const codeRow = await ctx.prisma.phoneVerification.findFirstOrThrow({ where: { requestId } });
      expect(codeRow.userId).toBeNull();
    } finally {
      process.env.REQUIRE_PHONE_VERIFICATION = 'false';
    }
  });
});
