import { NotificationStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestPublishOutbox } from '../src/modules/notifications/request-publish-outbox.service';
import {
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';

/**
 * REQ-UX-010 — the owner-only signal that a request is waiting for the
 * customer's own phone verification, and nothing else.
 *
 * `SUBMITTED` on its own does not say what a request waits for: an operator,
 * a switch that flipped after it was born, or the customer's proof of their
 * number. `awaitingPhoneVerification` is `true` only for the last one — gate
 * on, number unproven, still SUBMITTED, a marketplace request — and only on
 * the owner's own reads. Every other reader keeps exactly the answer it had.
 */

let ctx: TestContext;
let outbox: RequestPublishOutbox;

beforeAll(async () => {
  ctx = await createTestApp();
  outbox = ctx.app.get(RequestPublishOutbox);
});

afterAll(async () => {
  await setAutoPublish(false);
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  await setAutoPublish(false);
  process.env.REQUIRE_PHONE_VERIFICATION = 'false';
  resetAuthThrottle(ctx.app);
});

afterEach(async () => {
  process.env.REQUIRE_PHONE_VERIFICATION = 'false';
  // A request born live fires its fan-out in the background; let that sweep
  // finish before the next case truncates the rows it is updating.
  await outbox.deliverPending();
});

async function setAutoPublish(enabled: boolean) {
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      unviewedOfferRefundWindowHours: 48,
      marketplaceAutoPublishEnabled: enabled,
    },
    update: { marketplaceAutoPublishEnabled: enabled },
  });
}

async function sentRows(requestId: string, template: string) {
  return ctx.prisma.notificationLog.findMany({
    where: { requestId, template, status: NotificationStatus.SENT },
  });
}

/** A signed-in customer posting a marketplace request with their account's contact. */
async function createOwnedRequest() {
  const category = await createCategory(ctx.prisma, 'Klima');
  const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  await createDiscoverableProvider(ctx.prisma, { categoryId: category.id, userId: providerUser.id });
  const customer = await createUser(ctx.prisma, {
    role: UserRole.CUSTOMER,
    phone: '05551112233',
    email: 'owner@example.test',
    name: 'Owner',
  });
  const cookie = await loginAs(ctx.prisma, customer.id);

  const res = await request(ctx.server)
    .post('/service-requests')
    .set('Cookie', cookie)
    .send({
      ...serviceRequestPayload(category.slug),
      customerName: undefined,
      customerPhone: undefined,
      customerEmail: undefined,
    })
    .expect(201);

  return { id: res.body.id as string, cookie, customer, providerUser };
}

async function readMine(cookie: string, id: string) {
  const res = await request(ctx.server)
    .get(`/service-requests/my/${id}`)
    .set('Cookie', cookie)
    .expect(200);
  return res.body as { status: string; awaitingPhoneVerification?: boolean };
}

async function verifyPhone(cookie: string, id: string) {
  await request(ctx.server).post(`/service-requests/${id}/phone-verification`).set('Cookie', cookie).expect(201);
  await request(ctx.server)
    .post(`/service-requests/${id}/phone-verification/verify`)
    .set('Cookie', cookie)
    .send({ code: ctx.sms.lastCode() })
    .expect(201);
}

describe('awaitingPhoneVerification — the four cells', () => {
  it('auto on + gate off: born APPROVED, and the owner is not asked to verify', async () => {
    await setAutoPublish(true);
    const { id, cookie } = await createOwnedRequest();

    const mine = await readMine(cookie, id);
    expect(mine.status).toBe(ServiceRequestStatus.APPROVED);
    expect(mine.awaitingPhoneVerification).toBe(false);
  });

  it('auto on + gate on + unverified: SUBMITTED, and the owner reads an explicit wait for their own proof', async () => {
    await setAutoPublish(true);
    process.env.REQUIRE_PHONE_VERIFICATION = 'true';
    const { id, cookie } = await createOwnedRequest();

    const mine = await readMine(cookie, id);
    expect(mine.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(mine.awaitingPhoneVerification).toBe(true);

    // The list read is the same projection: the two screens cannot disagree.
    const list = await request(ctx.server).get('/service-requests/my').set('Cookie', cookie).expect(200);
    expect(list.body.find((row: { id: string }) => row.id === id).awaitingPhoneVerification).toBe(true);
  });

  it('the same request, once verified: APPROVED, the wait is over, and exactly one publish and fan-out', async () => {
    await setAutoPublish(true);
    process.env.REQUIRE_PHONE_VERIFICATION = 'true';
    const { id, cookie } = await createOwnedRequest();

    await verifyPhone(cookie, id);

    const mine = await readMine(cookie, id);
    expect(mine.status).toBe(ServiceRequestStatus.APPROVED);
    expect(mine.awaitingPhoneVerification).toBe(false);

    // A second verification is refused (409), and nothing about the request
    // or its fan-out moves a second time.
    await request(ctx.server)
      .post(`/service-requests/${id}/phone-verification/verify`)
      .set('Cookie', cookie)
      .send({ code: '000000' })
      .expect(409);
    await request(ctx.server).post(`/service-requests/${id}/phone-verification`).set('Cookie', cookie).expect(409);

    await outbox.deliverPending();
    await outbox.deliverPending();
    expect(await sentRows(id, 'request-available')).toHaveLength(1);
    expect(await sentRows(id, 'request-published')).toHaveLength(1);
    // Every status, not only SENT: a second enqueue would show up as a second
    // intent row even before delivery.
    expect(
      await ctx.prisma.notificationLog.count({
        where: { requestId: id, template: { in: ['request-available', 'request-published'] } },
      }),
    ).toBe(2);

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id } });
    expect(row.approvedAt).toEqual(row.phoneVerifiedAt);
    expect(row.moderatedAt).toBeNull();
  });

  it('auto off + gate on: the wait is real before verification and an operator wait after it', async () => {
    process.env.REQUIRE_PHONE_VERIFICATION = 'true';
    const { id, cookie } = await createOwnedRequest();

    expect((await readMine(cookie, id)).awaitingPhoneVerification).toBe(true);

    await verifyPhone(cookie, id);

    const mine = await readMine(cookie, id);
    // Still SUBMITTED — but no longer for the customer's own proof.
    expect(mine.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(mine.awaitingPhoneVerification).toBe(false);
    await outbox.deliverPending();
    expect(await sentRows(id, 'request-available')).toHaveLength(0);
  });

  it('auto off + gate off: SUBMITTED for an operator, never for the customer', async () => {
    const { id, cookie } = await createOwnedRequest();

    const mine = await readMine(cookie, id);
    expect(mine.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(mine.awaitingPhoneVerification).toBe(false);
  });
});

describe('awaitingPhoneVerification — who may read it', () => {
  it('anonymous, another customer, a provider and an admin keep their existing refusals and never see the signal', async () => {
    await setAutoPublish(true);
    process.env.REQUIRE_PHONE_VERIFICATION = 'true';
    const { id, providerUser } = await createOwnedRequest();

    await request(ctx.server).get(`/service-requests/my/${id}`).expect(401);

    const other = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await request(ctx.server)
      .get(`/service-requests/my/${id}`)
      .set('Cookie', await loginAs(ctx.prisma, other.id))
      .expect(404);

    const providerCookie = await loginAs(ctx.prisma, providerUser.id);
    await request(ctx.server).get(`/service-requests/my/${id}`).set('Cookie', providerCookie).expect(403);
    // The provider's own discovery: the unverified request is not there, and
    // no row anywhere in that answer carries the customer's signal.
    const discovery = await request(ctx.server)
      .get(`/service-requests/${id}/offers`)
      .set('Cookie', providerCookie);
    expect(discovery.status).not.toBe(200);
    expect(JSON.stringify(discovery.body)).not.toContain('awaitingPhoneVerification');

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminRead = await request(ctx.server)
      .get(`/service-requests/${id}`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(200);
    expect(adminRead.body.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(adminRead.body).not.toHaveProperty('awaitingPhoneVerification');
  });
});
