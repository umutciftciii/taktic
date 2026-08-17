import {
  NotificationChannel,
  NotificationStatus,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestExpiryService } from '../src/modules/request-lifecycle/request-expiry.service';
import {
  isRequestExpirySchedulerEnabled,
  isRequestReminderSchedulerEnabled,
  readRequestExpiryCron,
  readRequestLifecycleScanLimit,
  readRequestReminderCron,
} from '../src/modules/request-lifecycle/request-lifecycle.constants';
import { RequestReminderService } from '../src/modules/request-lifecycle/request-reminder.service';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  daysAgo,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  type TestContext,
} from './harness';

let ctx: TestContext;
let expiry: RequestExpiryService;
let reminder: RequestReminderService;

beforeAll(async () => {
  ctx = await createTestApp();
  expiry = ctx.app.get(RequestExpiryService);
  reminder = ctx.app.get(RequestReminderService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

const CATEGORY_COST = 2;

async function pricedCategory() {
  return createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
}

/** An approved request owned by a signed-in customer, approved `days` ago. */
async function approvedRequest(options: { days: number | null; withCustomer?: boolean } = { days: 7 }) {
  const category = await pricedCategory();
  const customer = options.withCustomer === false
    ? null
    : await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer?.id ?? null,
    approvedAt: options.days === null ? null : daysAgo(options.days),
  });

  return { category, customer, serviceRequest };
}

/** Adds a real offer, bought with real credits, through the provider endpoint. */
async function addOffer(categoryId: string, requestId: string) {
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId,
  });
  const cookie = await loginAs(ctx.prisma, ownerUser.id);
  await grantCredits(ctx.prisma, provider.id, 10);

  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${requestId}/offers`)
    .set('Cookie', cookie)
    .send(offerPayload())
    .expect(201);

  return { provider, cookie, offerId: created.body.id as string };
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

async function storedRequest(id: string) {
  return ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id } });
}

describe('approval timestamp', () => {
  it('stamps approvedAt in the transition that writes APPROVED', async () => {
    const category = await pricedCategory();
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { status: ServiceRequestStatus.SUBMITTED },
    });
    const cookie = await adminCookie();

    const before = Date.now();
    await request(ctx.server)
      .patch(`/service-requests/${serviceRequest.id}/status`)
      .set('Cookie', cookie)
      .send({ status: ServiceRequestStatus.APPROVED })
      .expect(200);
    const after = Date.now();

    const stored = await storedRequest(serviceRequest.id);
    expect(stored.status).toBe(ServiceRequestStatus.APPROVED);
    expect(stored.approvedAt).not.toBeNull();
    expect(stored.approvedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(stored.approvedAt!.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it('leaves approvedAt untouched by a non-approving moderation transition', async () => {
    const category = await pricedCategory();
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { status: ServiceRequestStatus.SUBMITTED },
    });
    const cookie = await adminCookie();

    await request(ctx.server)
      .patch(`/service-requests/${serviceRequest.id}/status`)
      .set('Cookie', cookie)
      .send({ status: ServiceRequestStatus.IN_REVIEW })
      .expect(200);

    expect((await storedRequest(serviceRequest.id)).approvedAt).toBeNull();
  });

  it('keeps approvedAt through MATCHED, COMPLETED and CANCELLED', async () => {
    const category = await pricedCategory();
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
    });
    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { status: ServiceRequestStatus.SUBMITTED },
    });

    await request(ctx.server)
      .patch(`/service-requests/${serviceRequest.id}/status`)
      .set('Cookie', await adminCookie())
      .send({ status: ServiceRequestStatus.APPROVED })
      .expect(200);
    const approvedAt = (await storedRequest(serviceRequest.id)).approvedAt;
    expect(approvedAt).not.toBeNull();

    const winner = await addOffer(category.id, serviceRequest.id);
    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/offers/${winner.offerId}/action`)
      .set('Cookie', customerCookie)
      .send({ action: 'ACCEPT' })
      .expect(201);

    const matched = await storedRequest(serviceRequest.id);
    expect(matched.status).toBe(ServiceRequestStatus.MATCHED);
    expect(matched.approvedAt?.getTime()).toBe(approvedAt!.getTime());

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/complete`)
      .set('Cookie', customerCookie)
      .expect(201);

    const completed = await storedRequest(serviceRequest.id);
    expect(completed.status).toBe(ServiceRequestStatus.COMPLETED);
    expect(completed.approvedAt?.getTime()).toBe(approvedAt!.getTime());

    // A cancellation on a separate request must keep its stamp too.
    const other = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
      approvedAt: daysAgo(1),
    });
    await request(ctx.server)
      .post(`/service-requests/${other.id}/cancel`)
      .set('Cookie', customerCookie)
      .expect(201);

    const cancelled = await storedRequest(other.id);
    expect(cancelled.status).toBe(ServiceRequestStatus.CANCELLED);
    expect(cancelled.approvedAt).not.toBeNull();
  });

  it('never picks up a request whose approval time is unknown', async () => {
    const category = await pricedCategory();
    // The shape of every request approved before approvedAt existed: long past
    // both windows on every other clock the row carries, and still untouchable.
    const legacy = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    await ctx.prisma.serviceRequest.update({
      where: { id: legacy.id },
      data: { submittedAt: daysAgo(90), createdAt: daysAgo(90), moderatedAt: daysAgo(89) },
    });

    expect(await expiry.execute()).toMatchObject({ processed: 0, expired: 0 });
    expect(await reminder.execute()).toMatchObject({ processed: 0, reminded: 0 });

    const stored = await storedRequest(legacy.id);
    expect(stored.status).toBe(ServiceRequestStatus.APPROVED);
    expect(stored.expiredAt).toBeNull();
    expect(stored.reminderSentAt).toBeNull();
    expect(await ctx.prisma.notificationLog.count()).toBe(0);
  });
});

describe('expiry job', () => {
  it('leaves a request approved 13 days ago open', async () => {
    const { serviceRequest } = await approvedRequest({ days: 13 });

    expect(await expiry.execute()).toMatchObject({ processed: 0, expired: 0 });

    const stored = await storedRequest(serviceRequest.id);
    expect(stored.status).toBe(ServiceRequestStatus.APPROVED);
    expect(stored.expiredAt).toBeNull();
  });

  it('expires a request approved 14 days ago exactly once', async () => {
    const { serviceRequest } = await approvedRequest({ days: 14 });

    expect(await expiry.execute()).toMatchObject({ processed: 1, expired: 1, skipped: 0 });

    const first = await storedRequest(serviceRequest.id);
    expect(first.status).toBe(ServiceRequestStatus.EXPIRED);
    expect(first.expiredAt).not.toBeNull();

    // A second run finds the row, re-evaluates the predicate and writes nothing.
    expect(await expiry.execute()).toMatchObject({ expired: 0 });

    const second = await storedRequest(serviceRequest.id);
    expect(second.expiredAt!.getTime()).toBe(first.expiredAt!.getTime());
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });

  it('expires a long-overdue request as well', async () => {
    const { serviceRequest } = await approvedRequest({ days: 40 });

    expect(await expiry.execute()).toMatchObject({ expired: 1 });
    expect((await storedRequest(serviceRequest.id)).status).toBe(ServiceRequestStatus.EXPIRED);
  });

  it('produces one expiry when two runs overlap on the same request', async () => {
    const { serviceRequest } = await approvedRequest({ days: 20 });

    const [first, second] = await Promise.all([expiry.execute(), expiry.execute()]);
    expect(first.expired + second.expired).toBe(1);
    expect(first.failed + second.failed).toBe(0);

    expect((await storedRequest(serviceRequest.id)).status).toBe(ServiceRequestStatus.EXPIRED);
  });

  for (const status of [
    ServiceRequestStatus.MATCHED,
    ServiceRequestStatus.COMPLETED,
    ServiceRequestStatus.CANCELLED,
    ServiceRequestStatus.REJECTED,
  ]) {
    it(`never expires a ${status} request`, async () => {
      const { serviceRequest } = await approvedRequest({ days: 30 });
      await ctx.prisma.serviceRequest.update({
        where: { id: serviceRequest.id },
        data: { status },
      });

      expect(await expiry.execute()).toMatchObject({ processed: 0, expired: 0 });

      const stored = await storedRequest(serviceRequest.id);
      expect(stored.status).toBe(status);
      expect(stored.expiredAt).toBeNull();
    });
  }

  it('closes an expired request to new offers', async () => {
    const { category, serviceRequest } = await approvedRequest({ days: 15 });

    await expiry.execute();
    expect((await storedRequest(serviceRequest.id)).status).toBe(ServiceRequestStatus.EXPIRED);

    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: ownerUser.id,
      categoryId: category.id,
    });
    const cookie = await loginAs(ctx.prisma, ownerUser.id);
    await grantCredits(ctx.prisma, provider.id, 10);

    await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(404);

    expect(await ctx.prisma.offer.count({ where: { requestId: serviceRequest.id } })).toBe(0);
  });

  it('is not reachable through the admin moderation endpoint', async () => {
    const { serviceRequest } = await approvedRequest({ days: 30 });

    await request(ctx.server)
      .patch(`/service-requests/${serviceRequest.id}/status`)
      .set('Cookie', await adminCookie())
      .send({ status: ServiceRequestStatus.EXPIRED })
      .expect(409);

    expect((await storedRequest(serviceRequest.id)).status).toBe(ServiceRequestStatus.APPROVED);
  });
});

describe('reminder job', () => {
  async function reminderLogs() {
    return ctx.prisma.notificationLog.findMany({ where: { template: 'request-expiring' } });
  }

  it('sends one reminder for an offer-less request approved 7 days ago', async () => {
    const { customer, serviceRequest } = await approvedRequest({ days: 7 });

    expect(await reminder.execute()).toMatchObject({ processed: 1, reminded: 1, failedToSend: 0 });

    const stored = await storedRequest(serviceRequest.id);
    expect(stored.reminderSentAt).not.toBeNull();
    // The reminder is a nudge, not a lifecycle event.
    expect(stored.status).toBe(ServiceRequestStatus.APPROVED);
    expect(stored.expiredAt).toBeNull();

    const logs = await reminderLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.channel).toBe(NotificationChannel.EMAIL);
    expect(logs[0]!.status).toBe(NotificationStatus.SENT);
    expect(logs[0]!.requestId).toBe(serviceRequest.id);
    expect(logs[0]!.userId).toBe(customer!.id);

    const sent = ctx.notifications.ofTemplate('request-expiring');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(serviceRequest.customerEmail);
    // States that the window is closing — and promises nothing else.
    expect(sent[0]!.subject).toContain('süre');
    expect(sent[0]!.actionUrl).toBeUndefined();
    const payload = JSON.stringify(sent[0]);
    expect(payload).not.toContain('doğrulanmış');
    expect(payload).not.toContain('garanti');
  });

  it('leaves a request approved 6 days ago alone', async () => {
    const { serviceRequest } = await approvedRequest({ days: 6 });

    expect(await reminder.execute()).toMatchObject({ processed: 0, reminded: 0 });
    expect((await storedRequest(serviceRequest.id)).reminderSentAt).toBeNull();
    expect(await reminderLogs()).toHaveLength(0);
  });

  it('never reminds a request that already has an offer', async () => {
    const { category, serviceRequest } = await approvedRequest({ days: 10 });
    await addOffer(category.id, serviceRequest.id);

    expect(await reminder.execute()).toMatchObject({ processed: 0, reminded: 0 });
    expect((await storedRequest(serviceRequest.id)).reminderSentAt).toBeNull();
    expect(await reminderLogs()).toHaveLength(0);
  });

  it('never reminds a request whose only offer was withdrawn', async () => {
    const { category, serviceRequest } = await approvedRequest({ days: 10 });
    const offer = await addOffer(category.id, serviceRequest.id);
    await ctx.prisma.offer.update({
      where: { id: offer.offerId },
      data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
    });

    // The customer heard from somebody; "no offers yet" would be untrue.
    expect(await reminder.execute()).toMatchObject({ reminded: 0 });
    expect(await reminderLogs()).toHaveLength(0);
  });

  it('does not remind twice', async () => {
    const { serviceRequest } = await approvedRequest({ days: 9 });

    await reminder.execute();
    const first = await storedRequest(serviceRequest.id);

    expect(await reminder.execute()).toMatchObject({ processed: 0, reminded: 0 });

    const second = await storedRequest(serviceRequest.id);
    expect(second.reminderSentAt!.getTime()).toBe(first.reminderSentAt!.getTime());
    expect(await reminderLogs()).toHaveLength(1);
    expect(ctx.notifications.ofTemplate('request-expiring')).toHaveLength(1);
  });

  it('produces one reminder when two runs overlap on the same request', async () => {
    const { serviceRequest } = await approvedRequest({ days: 8 });

    const [first, second] = await Promise.all([reminder.execute(), reminder.execute()]);
    expect(first.reminded + second.reminded).toBe(1);

    expect((await storedRequest(serviceRequest.id)).reminderSentAt).not.toBeNull();
    expect(await reminderLogs()).toHaveLength(1);
    expect(ctx.notifications.ofTemplate('request-expiring')).toHaveLength(1);
  });

  for (const status of [
    ServiceRequestStatus.MATCHED,
    ServiceRequestStatus.COMPLETED,
    ServiceRequestStatus.CANCELLED,
    ServiceRequestStatus.REJECTED,
    ServiceRequestStatus.EXPIRED,
  ]) {
    it(`never reminds a ${status} request`, async () => {
      const { serviceRequest } = await approvedRequest({ days: 10 });
      await ctx.prisma.serviceRequest.update({
        where: { id: serviceRequest.id },
        data: { status },
      });

      expect(await reminder.execute()).toMatchObject({ processed: 0, reminded: 0 });
      expect((await storedRequest(serviceRequest.id)).reminderSentAt).toBeNull();
      expect(await reminderLogs()).toHaveLength(0);
    });
  }

  it('keeps the claim and the FAILED audit row when the transport is down', async () => {
    const { serviceRequest } = await approvedRequest({ days: 10 });
    ctx.notifications.failNextSend = true;

    expect(await reminder.execute()).toMatchObject({ reminded: 1, failedToSend: 1 });

    const stored = await storedRequest(serviceRequest.id);
    // The claim stands, so the customer is not re-mailed on every later run…
    expect(stored.reminderSentAt).not.toBeNull();
    // …and the request itself is untouched by the failure.
    expect(stored.status).toBe(ServiceRequestStatus.APPROVED);
    expect(stored.expiredAt).toBeNull();

    const logs = await reminderLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe(NotificationStatus.FAILED);
    expect(logs[0]!.failedAt).not.toBeNull();
    expect(logs[0]!.errorCode).toBe('TRANSPORT_UNAVAILABLE');

    // The failure never re-opens the request for a second attempt.
    expect(await reminder.execute()).toMatchObject({ processed: 0, reminded: 0 });
    expect(await reminderLogs()).toHaveLength(1);
    expect(ctx.notifications.ofTemplate('request-expiring')).toHaveLength(0);
  });

  it('leaves nothing replayable or identifying in the audit row', async () => {
    const { serviceRequest } = await approvedRequest({ days: 10 });

    await reminder.execute();

    const log = (await reminderLogs())[0]!;
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain(serviceRequest.customerEmail);
    expect(serialized).not.toContain(serviceRequest.customerPhone);
    expect(serialized).not.toContain(serviceRequest.customerName);
    expect(serialized).not.toContain('http');
    expect(log.maskedRecipient).toContain('*');
  });

  it('skips a request with no e-mail address instead of claiming it', async () => {
    const category = await pricedCategory();
    const serviceRequest = await ctx.prisma.serviceRequest.create({
      data: {
        categoryId: category.id,
        requestNumber: 'TR-TEST-NOMAIL',
        customerName: 'Müşteri',
        customerPhone: '05554443322',
        customerEmail: null,
        city: 'İstanbul',
        district: 'Kadıköy',
        status: ServiceRequestStatus.APPROVED,
        approvedAt: daysAgo(10),
        qualityScore: 80,
      },
    });

    expect(await reminder.execute()).toMatchObject({ processed: 1, reminded: 0, skipped: 1 });

    // Unclaimed, so the request becomes reachable again once an address exists.
    expect((await storedRequest(serviceRequest.id)).reminderSentAt).toBeNull();
    expect(await reminderLogs()).toHaveLength(0);
  });

  it('does not stop the expiry job from closing a reminded request later', async () => {
    const { serviceRequest } = await approvedRequest({ days: 14 });

    await reminder.execute();
    expect((await storedRequest(serviceRequest.id)).reminderSentAt).not.toBeNull();

    expect(await expiry.execute()).toMatchObject({ expired: 1 });
    expect((await storedRequest(serviceRequest.id)).status).toBe(ServiceRequestStatus.EXPIRED);
  });

  it('reminds an unclaimed request created without an account holder', async () => {
    const { serviceRequest } = await approvedRequest({ days: 7, withCustomer: false });

    expect(await reminder.execute()).toMatchObject({ reminded: 1 });

    const log = (await reminderLogs())[0]!;
    expect(log.userId).toBeNull();
    expect(log.requestId).toBe(serviceRequest.id);
  });
});

describe('scheduler configuration', () => {
  const KEYS = [
    'REQUEST_EXPIRY_SCHEDULER_ENABLED',
    'REQUEST_REMINDER_SCHEDULER_ENABLED',
    'REQUEST_EXPIRY_SCHEDULER_CRON',
    'REQUEST_REMINDER_SCHEDULER_CRON',
    'REQUEST_LIFECYCLE_SCAN_LIMIT',
  ] as const;

  const original = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of KEYS) {
      original.set(key, process.env[key]);
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = original.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('defaults both jobs to disabled', () => {
    for (const key of KEYS) {
      delete process.env[key];
    }

    expect(isRequestExpirySchedulerEnabled()).toBe(false);
    expect(isRequestReminderSchedulerEnabled()).toBe(false);
    expect(readRequestExpiryCron()).toBe('15 * * * *');
    expect(readRequestReminderCron()).toBe('45 * * * *');
    expect(readRequestLifecycleScanLimit()).toBe(200);
  });

  it('keeps both jobs disabled in the test environment', () => {
    // The suite drives the services directly; no cron may act on its fixtures.
    expect(isRequestExpirySchedulerEnabled()).toBe(false);
    expect(isRequestReminderSchedulerEnabled()).toBe(false);
  });

  it('refuses a flag that is not exactly true or false', () => {
    process.env.REQUEST_EXPIRY_SCHEDULER_ENABLED = 'yes';
    expect(() => isRequestExpirySchedulerEnabled()).toThrow(/must be exactly "true" or "false"/);

    process.env.REQUEST_REMINDER_SCHEDULER_ENABLED = '1';
    expect(() => isRequestReminderSchedulerEnabled()).toThrow(/must be exactly "true" or "false"/);
  });

  it('refuses an unreadable cron expression instead of falling back', () => {
    process.env.REQUEST_EXPIRY_SCHEDULER_CRON = 'every hour please';
    expect(() => readRequestExpiryCron()).toThrow(/not a valid cron expression/);

    process.env.REQUEST_REMINDER_SCHEDULER_CRON = '99 99 * * *';
    expect(() => readRequestReminderCron()).toThrow(/not a valid cron expression/);
  });

  it('refuses a scan limit outside its range', () => {
    for (const value of ['0', '-5', '1001', 'many', '1.5']) {
      process.env.REQUEST_LIFECYCLE_SCAN_LIMIT = value;
      expect(() => readRequestLifecycleScanLimit()).toThrow(/between 1 and 1000/);
    }

    process.env.REQUEST_LIFECYCLE_SCAN_LIMIT = '50';
    expect(readRequestLifecycleScanLimit()).toBe(50);
  });

  it('honours the scan limit when the job runs', async () => {
    const category = await pricedCategory();
    for (let index = 0; index < 3; index += 1) {
      await createApprovedRequest(ctx.prisma, {
        categoryId: category.id,
        approvedAt: daysAgo(20 + index),
      });
    }

    expect(await expiry.execute({ limit: 2 })).toMatchObject({ processed: 2, expired: 2 });
    expect(
      await ctx.prisma.serviceRequest.count({ where: { status: ServiceRequestStatus.APPROVED } }),
    ).toBe(1);
  });
});
