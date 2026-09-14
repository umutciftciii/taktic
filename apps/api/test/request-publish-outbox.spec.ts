import { NotificationStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestPublishOutbox } from '../src/modules/notifications/request-publish-outbox.service';
import { SchedulerRunRegistry } from '../src/modules/operations-settings/scheduler-run-registry.service';
import { SchedulerSettingsService } from '../src/modules/operations-settings/scheduler-settings.service';
import { RequestLifecycleSchedulerService } from '../src/modules/request-lifecycle/request-lifecycle-scheduler.service';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  resetDatabase,
  type TestContext,
} from './harness';

let ctx: TestContext;
let outbox: RequestPublishOutbox;

beforeAll(async () => {
  ctx = await createTestApp();
  outbox = ctx.app.get(RequestPublishOutbox);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

describe('RequestPublishOutbox', () => {
  it('enqueues one customer intent and one intent per matching provider, once', async () => {
    const category = await createCategory(ctx.prisma);
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      userId: providerUser.id,
    });
    // Outside the request's area: reached by nobody's rule, so not counted.
    await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      city: 'Ankara',
      district: 'Çankaya',
    });
    const approvedAt = new Date();
    const request = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      approvedAt,
    });

    const first = await ctx.prisma.$transaction((tx) => outbox.enqueue(tx, request.id, approvedAt));
    const second = await ctx.prisma.$transaction((tx) =>
      outbox.enqueue(tx, request.id, approvedAt),
    );

    expect(first).toEqual({ reached: 1, enqueued: 2 });
    expect(second.enqueued).toBe(0);

    const pending = await ctx.prisma.notificationLog.findMany({
      where: { requestId: request.id },
    });
    expect(pending.map((row) => row.template).sort()).toEqual([
      'request-available',
      'request-published',
    ]);
    expect(
      pending.every((row) => row.status === NotificationStatus.PENDING && row.attemptCount === 0),
    ).toBe(true);
    // Nothing is sent inside the transaction.
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('enqueues nothing for a request that is not live or is reserved for one vitrin business', async () => {
    const category = await createCategory(ctx.prisma);
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      userId: providerUser.id,
    });
    const approvedAt = new Date();
    const reserved = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      approvedAt,
    });
    await ctx.prisma.serviceRequest.update({
      where: { id: reserved.id },
      data: { directShowcaseProviderId: provider.id },
    });
    const inReview = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      approvedAt,
    });
    await ctx.prisma.serviceRequest.update({
      where: { id: inReview.id },
      data: { status: ServiceRequestStatus.IN_REVIEW },
    });

    const reservedResult = await ctx.prisma.$transaction((tx) =>
      outbox.enqueue(tx, reserved.id, approvedAt),
    );
    const notLiveResult = await ctx.prisma.$transaction((tx) =>
      outbox.enqueue(tx, inReview.id, approvedAt),
    );

    expect(reservedResult).toEqual({ reached: 0, enqueued: 0 });
    expect(notLiveResult).toEqual({ reached: 0, enqueued: 0 });
    expect(await ctx.prisma.notificationLog.count()).toBe(0);
  });

  it('delivers pending intents exactly once across two sweeps', async () => {
    const category = await createCategory(ctx.prisma);
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      userId: providerUser.id,
    });
    const approvedAt = new Date();
    const request = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      approvedAt,
    });
    await ctx.prisma.$transaction((tx) => outbox.enqueue(tx, request.id, approvedAt));

    const a = await outbox.deliverPending();
    const b = await outbox.deliverPending();

    expect(a).toEqual({ claimed: 2, sent: 2, failed: 0, unavailable: 0 });
    expect(b.claimed).toBe(0);
    expect(ctx.notifications.sent.filter((m) => m.template === 'request-available')).toHaveLength(
      1,
    );
    expect(ctx.notifications.sent.filter((m) => m.template === 'request-published')).toHaveLength(
      1,
    );
    expect(ctx.notifications.sent.find((m) => m.template === 'request-published')?.to).toBe(
      request.customerEmail,
    );
    expect(ctx.notifications.sent.find((m) => m.template === 'request-available')?.to).toBe(
      providerUser.email,
    );

    const rows = await ctx.prisma.notificationLog.findMany({ where: { requestId: request.id } });
    expect(
      rows.every((row) => row.status === NotificationStatus.SENT && row.attemptCount === 1),
    ).toBe(true);
  });

  it('settles an intent whose source is no longer live as FAILED without sending', async () => {
    const category = await createCategory(ctx.prisma);
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      userId: providerUser.id,
    });
    const approvedAt = new Date();
    const request = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      approvedAt,
    });
    await ctx.prisma.$transaction((tx) => outbox.enqueue(tx, request.id, approvedAt));
    await ctx.prisma.serviceRequest.update({
      where: { id: request.id },
      data: { status: ServiceRequestStatus.CANCELLED },
    });

    const result = await outbox.deliverPending();

    expect(result).toEqual({ claimed: 2, sent: 0, failed: 0, unavailable: 2 });
    expect(ctx.notifications.sent).toHaveLength(0);
    const rows = await ctx.prisma.notificationLog.findMany({ where: { requestId: request.id } });
    expect(rows.every((row) => row.status === NotificationStatus.FAILED)).toBe(true);
    expect(rows.every((row) => row.errorCode === 'SOURCE_UNAVAILABLE')).toBe(true);
  });

  it('is swept by the request-expiry tick, which reports publishSent', async () => {
    const category = await createCategory(ctx.prisma);
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      userId: providerUser.id,
    });
    const approvedAt = new Date();
    const request = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      approvedAt,
    });
    await ctx.prisma.$transaction((tx) => outbox.enqueue(tx, request.id, approvedAt));
    const operator = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await ctx.app.get(SchedulerSettingsService).setEnabled('request-expiry', true, operator.id);

    await ctx.app.get(RequestLifecycleSchedulerService).runScheduledExpiry();

    expect(ctx.notifications.sent.map((m) => m.template).sort()).toEqual([
      'request-available',
      'request-published',
    ]);
    const run = ctx.app.get(SchedulerRunRegistry).get('request-expiry');
    expect(run?.outcome).toBe('SUCCESS');
    expect(run?.summary).toContain('publishSent=2');
  });
});
