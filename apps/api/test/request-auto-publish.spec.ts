import { NotificationStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestPublishOutbox } from '../src/modules/notifications/request-publish-outbox.service';
import type { CreateServiceRequestDto } from '../src/modules/service-requests/dto/create-service-request.dto';
import { ServiceRequestsService } from '../src/modules/service-requests/service-requests.service';
import {
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';

let ctx: TestContext;
let outbox: RequestPublishOutbox;

beforeAll(async () => {
  ctx = await createTestApp();
  outbox = ctx.app.get(RequestPublishOutbox);
});

afterAll(async () => {
  // The settings singleton survives resetDatabase; leave the switch off for
  // whichever spec file runs next.
  await setAutoPublish(false);
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  await setAutoPublish(false);
  process.env.REQUIRE_PHONE_VERIFICATION = 'false';
});

afterEach(() => {
  process.env.REQUIRE_PHONE_VERIFICATION = 'false';
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

function sendUrl(requestId: string) {
  return `/service-requests/${requestId}/phone-verification`;
}

function verifyUrl(requestId: string) {
  return `/service-requests/${requestId}/phone-verification/verify`;
}

describe('marketplace auto-publish', () => {
  it('switch off: the request waits at SUBMITTED and the customer gets request-received', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');

    const res = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(201);

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(row.approvedAt).toBeNull();

    const received = ctx.notifications.ofTemplate('request-received');
    expect(received).toHaveLength(1);
    expect(received[0]!.data?.nextStep).toBe('review');

    // Nothing is owed to anybody until an operator approves it.
    await outbox.deliverPending();
    expect(await ctx.prisma.notificationLog.count({ where: { requestId: row.id } })).toBe(1);
  });

  it('switch on: the request is born APPROVED, visible to a matching provider, and fanned out', async () => {
    await setAutoPublish(true);
    const category = await createCategory(ctx.prisma, 'Klima');
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      userId: providerUser.id,
    });

    const res = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(201);

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.status).toBe(ServiceRequestStatus.APPROVED);
    expect(row.approvedAt).toEqual(row.submittedAt);
    // Nobody moderated it: that pair is how a row says "auto-published".
    expect(row.moderatedAt).toBeNull();

    const cookie = await loginAs(ctx.prisma, providerUser.id);
    const list = await request(ctx.server)
      .get(`/providers/${provider.id}/requests`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.map((item: { id: string }) => item.id)).toContain(row.id);

    // The creation path fires delivery without waiting for it; the explicit
    // sweep is what makes this assertion deterministic.
    await outbox.deliverPending();
    expect(await sentRows(row.id, 'request-available')).toHaveLength(1);
    expect(await sentRows(row.id, 'request-published')).toHaveLength(1);
    expect(ctx.notifications.ofTemplate('request-available').map((m) => m.to)).toEqual([
      providerUser.email,
    ]);
    expect(ctx.notifications.ofTemplate('request-published')).toHaveLength(1);
    // Live already: the customer is told "yayında", never "alındı".
    expect(ctx.notifications.ofTemplate('request-received')).toHaveLength(0);
  });

  it('switch on: a vitrin lead is never auto-published by the marketplace path', async () => {
    await setAutoPublish(true);
    // Even with the gate on: the lead's number was proven before it existed
    // and its own flow publishes it, so its receipt never asks for a
    // verification.
    process.env.REQUIRE_PHONE_VERIFICATION = 'true';
    const category = await createCategory(ctx.prisma, 'Klima');
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      userId: providerUser.id,
    });
    const service = ctx.app.get(ServiceRequestsService);

    const created = await service.createServiceRequest(
      serviceRequestPayload(category.slug) as CreateServiceRequestDto,
      null,
      { directShowcaseProviderId: provider.id, phoneVerifiedAt: new Date() },
    );

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(row.approvedAt).toBeNull();
    expect(ctx.notifications.ofTemplate('request-received')[0]!.data?.nextStep).toBe('review');
    await outbox.deliverPending();
    expect(ctx.notifications.ofTemplate('request-available')).toHaveLength(0);
    expect(ctx.notifications.ofTemplate('request-published')).toHaveLength(0);
  });

  it('switch on + verification required: SUBMITTED until verifyCode, then APPROVED without an admin', async () => {
    await setAutoPublish(true);
    process.env.REQUIRE_PHONE_VERIFICATION = 'true';
    const category = await createCategory(ctx.prisma, 'Klima');
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      userId: providerUser.id,
    });
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      phone: '05551112233',
      email: 'v@example.test',
      name: 'V',
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

    let row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(row.approvedAt).toBeNull();
    const received = ctx.notifications.ofTemplate('request-received');
    expect(received).toHaveLength(1);
    expect(received[0]!.data?.nextStep).toBe('verify');

    await request(ctx.server).post(sendUrl(row.id)).set('Cookie', cookie).expect(201);
    await request(ctx.server)
      .post(verifyUrl(row.id))
      .set('Cookie', cookie)
      .send({ code: ctx.sms.lastCode() })
      .expect(201);

    row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(row.status).toBe(ServiceRequestStatus.APPROVED);
    expect(row.phoneVerifiedAt).not.toBeNull();
    expect(row.approvedAt).toEqual(row.phoneVerifiedAt);
    expect(row.moderatedAt).toBeNull();

    await outbox.deliverPending();
    expect(await sentRows(row.id, 'request-available')).toHaveLength(1);
    expect(await sentRows(row.id, 'request-published')).toHaveLength(1);
  });

  it('switch off + verification required: verifyCode leaves the request for the operator', async () => {
    process.env.REQUIRE_PHONE_VERIFICATION = 'true';
    const category = await createCategory(ctx.prisma, 'Klima');
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
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
    expect(ctx.notifications.ofTemplate('request-received')[0]!.data?.nextStep).toBe('review');

    await request(ctx.server).post(sendUrl(res.body.id)).set('Cookie', cookie).expect(201);
    await request(ctx.server)
      .post(verifyUrl(res.body.id))
      .set('Cookie', cookie)
      .send({ code: ctx.sms.lastCode() })
      .expect(201);

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(row.phoneVerifiedAt).not.toBeNull();
    expect(row.approvedAt).toBeNull();
  });
});

describe('moderation approval through the outbox', () => {
  it('enqueues the fan-out in the approval transaction and delivers it after the commit', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      userId: providerUser.id,
    });
    const res = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(201);
    ctx.notifications.clear();

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    await request(ctx.server)
      .patch(`/service-requests/${res.body.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ServiceRequestStatus.APPROVED })
      .expect(200);

    // Both intents exist as rows the moment the approval is committed — that
    // is the guarantee the outbox adds over the old synchronous send.
    const rows = await ctx.prisma.notificationLog.findMany({
      where: { requestId: res.body.id, template: { in: ['request-published', 'request-available'] } },
    });
    expect(rows.map((r) => r.template).sort()).toEqual(['request-available', 'request-published']);

    await outbox.deliverPending();
    expect(await sentRows(res.body.id, 'request-available')).toHaveLength(1);
    expect(await sentRows(res.body.id, 'request-published')).toHaveLength(1);
    expect(ctx.notifications.ofTemplate('request-available')).toHaveLength(1);
    expect(ctx.notifications.ofTemplate('request-published')).toHaveLength(1);
  });
});
