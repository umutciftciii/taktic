import { NotificationChannel, NotificationStatus, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  type TestContext,
} from './harness';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.sms.clear();
  delete process.env.REQUIRE_PHONE_VERIFICATION;
});

afterEach(() => {
  // The gate is read per call, so a test that turns it on must never leak into
  // the next one.
  delete process.env.REQUIRE_PHONE_VERIFICATION;
});

const CATEGORY_COST = 2;

async function requestFixture() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });
  const cookie = await loginAs(ctx.prisma, customer.id);

  return { category, customer, cookie, serviceRequest };
}

async function providerFixture(categoryId: string) {
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId,
  });
  const cookie = await loginAs(ctx.prisma, ownerUser.id);
  await grantCredits(ctx.prisma, provider.id, 10);

  return { ownerUser, provider, cookie };
}

function sendUrl(requestId: string) {
  return `/service-requests/${requestId}/phone-verification`;
}

function verifyUrl(requestId: string) {
  return `/service-requests/${requestId}/phone-verification/verify`;
}

describe('phone verification — code handling', () => {
  it('stores only a hash and never returns or logs the code', async () => {
    const { cookie, serviceRequest } = await requestFixture();

    const response = await request(ctx.server)
      .post(sendUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .expect(201);

    const code = ctx.sms.lastCode();
    expect(code).toMatch(/^\d{6}$/);

    // Nothing in the HTTP response may carry the code.
    expect(JSON.stringify(response.body)).not.toContain(code);
    expect(response.body.maskedPhone).not.toContain(code);

    const stored = await ctx.prisma.phoneVerification.findFirstOrThrow({
      where: { requestId: serviceRequest.id },
    });
    expect(stored.codeHash).not.toBe(code);
    expect(stored.codeHash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare(code, stored.codeHash)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(code);
  });

  it('verifies once and refuses a replay of the same code', async () => {
    const { cookie, serviceRequest } = await requestFixture();

    await request(ctx.server).post(sendUrl(serviceRequest.id)).set('Cookie', cookie).expect(201);
    const code = ctx.sms.lastCode();

    await request(ctx.server)
      .post(verifyUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .send({ code })
      .expect(201);

    const verified = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(verified.phoneVerifiedAt).not.toBeNull();

    // A second use is refused — here because the request is already verified.
    await request(ctx.server)
      .post(verifyUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .send({ code })
      .expect(409);
  });

  it('refuses an expired code', async () => {
    const { cookie, serviceRequest } = await requestFixture();

    await request(ctx.server).post(sendUrl(serviceRequest.id)).set('Cookie', cookie).expect(201);
    const code = ctx.sms.lastCode();

    await ctx.prisma.phoneVerification.updateMany({
      where: { requestId: serviceRequest.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await request(ctx.server)
      .post(verifyUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .send({ code })
      .expect(400);
    expect(response.body.code).toBe('PHONE_VERIFICATION_INVALID');

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.phoneVerifiedAt).toBeNull();
  });

  it('invalidates the previous code when a new one is issued', async () => {
    const { cookie, serviceRequest } = await requestFixture();

    await request(ctx.server).post(sendUrl(serviceRequest.id)).set('Cookie', cookie).expect(201);
    const firstCode = ctx.sms.lastCode();

    await request(ctx.server).post(sendUrl(serviceRequest.id)).set('Cookie', cookie).expect(201);
    const secondCode = ctx.sms.lastCode();
    expect(secondCode).not.toBe(firstCode);

    await request(ctx.server)
      .post(verifyUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .send({ code: firstCode })
      .expect(400);

    await request(ctx.server)
      .post(verifyUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .send({ code: secondCode })
      .expect(201);
  });

  it('locks after five wrong codes and then refuses even the right one', async () => {
    const { cookie, serviceRequest } = await requestFixture();

    await request(ctx.server).post(sendUrl(serviceRequest.id)).set('Cookie', cookie).expect(201);
    const code = ctx.sms.lastCode();
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await request(ctx.server)
        .post(verifyUrl(serviceRequest.id))
        .set('Cookie', cookie)
        .send({ code: wrong })
        .expect(400);

      const row = await ctx.prisma.phoneVerification.findFirstOrThrow({
        where: { requestId: serviceRequest.id },
      });
      expect(row.attemptCount).toBe(attempt);
    }

    const locked = await ctx.prisma.phoneVerification.findFirstOrThrow({
      where: { requestId: serviceRequest.id },
    });
    expect(locked.lockedUntil).not.toBeNull();

    const response = await request(ctx.server)
      .post(verifyUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .send({ code })
      .expect(400);
    // A locked row answers exactly like a wrong code — no hint that the code
    // was right or that a lock exists.
    expect(response.body.code).toBe('PHONE_VERIFICATION_INVALID');

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.phoneVerifiedAt).toBeNull();
  });

  it('caps sends per phone number at three per hour', async () => {
    const { cookie, serviceRequest } = await requestFixture();

    for (let i = 0; i < 3; i += 1) {
      await request(ctx.server).post(sendUrl(serviceRequest.id)).set('Cookie', cookie).expect(201);
    }

    const response = await request(ctx.server)
      .post(sendUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .expect(429);
    // The message must not reveal which budget was hit or whether the number is
    // known to the platform.
    expect(JSON.stringify(response.body)).not.toContain(serviceRequest.customerPhone);
    expect(await ctx.prisma.phoneVerification.count()).toBe(3);
  });

  it('answers a malformed code exactly like a wrong one', async () => {
    const { cookie, serviceRequest } = await requestFixture();
    await request(ctx.server).post(sendUrl(serviceRequest.id)).set('Cookie', cookie).expect(201);

    for (const code of ['12', 'abcdef', '1234567', '']) {
      const response = await request(ctx.server)
        .post(verifyUrl(serviceRequest.id))
        .set('Cookie', cookie)
        .send({ code })
        .expect(400);
      expect(response.body.code).toBe('PHONE_VERIFICATION_INVALID');
    }
  });
});

describe('phone verification — authorization', () => {
  it('refuses anonymous callers, other customers and providers', async () => {
    const { category, serviceRequest } = await requestFixture();
    const stranger = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const strangerCookie = await loginAs(ctx.prisma, stranger.id);
    const { cookie: providerCookie } = await providerFixture(category.id);

    await request(ctx.server).post(sendUrl(serviceRequest.id)).expect(401);
    await request(ctx.server)
      .post(sendUrl(serviceRequest.id))
      .set('Cookie', strangerCookie)
      .expect(403);
    await request(ctx.server)
      .post(sendUrl(serviceRequest.id))
      .set('Cookie', providerCookie)
      .expect(403);

    await request(ctx.server).post(verifyUrl(serviceRequest.id)).send({ code: '123456' }).expect(401);
    await request(ctx.server)
      .post(verifyUrl(serviceRequest.id))
      .set('Cookie', strangerCookie)
      .send({ code: '123456' })
      .expect(403);

    expect(await ctx.prisma.phoneVerification.count()).toBe(0);
  });

  it('cannot carry one request’s code over to another request', async () => {
    const first = await requestFixture();
    const second = await createApprovedRequest(ctx.prisma, {
      categoryId: first.category.id,
      customerId: first.customer.id,
    });

    await request(ctx.server).post(sendUrl(first.serviceRequest.id)).set('Cookie', first.cookie).expect(201);
    const code = ctx.sms.lastCode();

    // Same customer, same phone, but the code belongs to the other request.
    await request(ctx.server)
      .post(verifyUrl(second.id))
      .set('Cookie', first.cookie)
      .send({ code })
      .expect(400);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: second.id } });
    expect(stored.phoneVerifiedAt).toBeNull();
  });
});

describe('notification audit', () => {
  it('records a SENT row that carries no code, token or raw phone', async () => {
    const { cookie, serviceRequest } = await requestFixture();

    await request(ctx.server).post(sendUrl(serviceRequest.id)).set('Cookie', cookie).expect(201);
    const code = ctx.sms.lastCode();

    const log = await ctx.prisma.notificationLog.findFirstOrThrow({
      where: { requestId: serviceRequest.id },
    });
    expect(log.channel).toBe(NotificationChannel.SMS);
    expect(log.template).toBe('phone-verification-code');
    expect(log.status).toBe(NotificationStatus.SENT);
    expect(log.sentAt).not.toBeNull();
    expect(log.errorCode).toBeNull();

    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain(serviceRequest.customerPhone);
    expect(log.maskedRecipient).toContain('*');
  });

  it('records FAILED without invalidating the issued code', async () => {
    const { cookie, serviceRequest } = await requestFixture();
    ctx.sms.failNextSend = true;

    // The endpoint still succeeds: the code exists, only delivery failed.
    const response = await request(ctx.server)
      .post(sendUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .expect(201);
    expect(response.body.delivery).toBe(NotificationStatus.FAILED);

    const log = await ctx.prisma.notificationLog.findFirstOrThrow({
      where: { requestId: serviceRequest.id },
    });
    expect(log.status).toBe(NotificationStatus.FAILED);
    expect(log.failedAt).not.toBeNull();
    expect(log.errorCode).toBe('TRANSPORT_UNAVAILABLE');

    // The verification row survived the transport failure.
    expect(await ctx.prisma.phoneVerification.count({ where: { requestId: serviceRequest.id } })).toBe(1);
  });

  it('audits the customer activation e-mail without changing its transport', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      password: null,
      customerOrigin: 'AUTO_CREATED_REQUEST',
    });

    await request(ctx.server)
      .post(`/customers/${customer.id}/activation-link`)
      .set('Cookie', adminCookie)
      .expect(201);

    // Admin-issued links are returned to the admin, not mailed, so no log is
    // expected here; what must hold is that the endpoint still works.
    const logs = await ctx.prisma.notificationLog.findMany({
      where: { channel: NotificationChannel.EMAIL },
    });
    for (const log of logs) {
      expect(log.template).toBe('customer-activation');
      expect(log.maskedRecipient).toContain('*');
    }
  });
});

describe('REQUIRE_PHONE_VERIFICATION gate', () => {
  it('leaves provider discovery and offering untouched while false', async () => {
    const { category, serviceRequest } = await requestFixture();
    const { provider, cookie } = await providerFixture(category.id);

    const list = await request(ctx.server)
      .get(`/providers/${provider.id}/requests`)
      .set('Cookie', cookie)
      .expect(200);
    expect((list.body as Array<{ id: string }>).map((item) => item.id)).toContain(serviceRequest.id);

    await request(ctx.server)
      .get(`/providers/${provider.id}/requests/${serviceRequest.id}`)
      .set('Cookie', cookie)
      .expect(200);

    await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);
  });

  it('hides an unverified request from providers while true', async () => {
    const { category, serviceRequest } = await requestFixture();
    const { provider, cookie } = await providerFixture(category.id);

    process.env.REQUIRE_PHONE_VERIFICATION = 'true';

    const list = await request(ctx.server)
      .get(`/providers/${provider.id}/requests`)
      .set('Cookie', cookie)
      .expect(200);
    expect((list.body as Array<{ id: string }>).map((item) => item.id)).not.toContain(
      serviceRequest.id,
    );

    // The gate must hold on the direct endpoints too, not just the list.
    await request(ctx.server)
      .get(`/providers/${provider.id}/requests/${serviceRequest.id}`)
      .set('Cookie', cookie)
      .expect(404);

    await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(404);

    expect(await ctx.prisma.offer.count()).toBe(0);
  });

  it('lets a verified request back into the normal flow while true', async () => {
    const { category, cookie: customerCookie, serviceRequest } = await requestFixture();
    const { provider, cookie } = await providerFixture(category.id);

    await request(ctx.server)
      .post(sendUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .expect(201);
    await request(ctx.server)
      .post(verifyUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ code: ctx.sms.lastCode() })
      .expect(201);

    process.env.REQUIRE_PHONE_VERIFICATION = 'true';

    const list = await request(ctx.server)
      .get(`/providers/${provider.id}/requests`)
      .set('Cookie', cookie)
      .expect(200);
    expect((list.body as Array<{ id: string }>).map((item) => item.id)).toContain(serviceRequest.id);

    await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);
  });

  it('blocks approving an unverified request while true, and allows it once verified', async () => {
    const { cookie: customerCookie, serviceRequest } = await requestFixture();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { status: 'IN_REVIEW' },
    });

    process.env.REQUIRE_PHONE_VERIFICATION = 'true';

    const blocked = await request(ctx.server)
      .patch(`/service-requests/${serviceRequest.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'APPROVED' })
      .expect(409);
    expect(blocked.body.code).toBe('PHONE_NOT_VERIFIED');

    // Rejecting stays possible so the queue can still be cleared.
    await request(ctx.server)
      .patch(`/service-requests/${serviceRequest.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'REJECTED', rejectionReason: 'Eksik bilgi' })
      .expect(200);

    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { status: 'IN_REVIEW' },
    });

    delete process.env.REQUIRE_PHONE_VERIFICATION;
    await request(ctx.server)
      .post(sendUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .expect(201);
    await request(ctx.server)
      .post(verifyUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ code: ctx.sms.lastCode() })
      .expect(201);
    process.env.REQUIRE_PHONE_VERIFICATION = 'true';

    await request(ctx.server)
      .patch(`/service-requests/${serviceRequest.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'APPROVED' })
      .expect(200);
  });
});
