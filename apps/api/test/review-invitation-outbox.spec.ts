import { NotificationStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { intentRow } from '../src/modules/notifications/notification-intents';
import { ReviewInvitationOutbox } from '../src/modules/notifications/review-invitation-outbox.service';
import { SchedulerRunRegistry } from '../src/modules/operations-settings/scheduler-run-registry.service';
import { SchedulerSettingsService } from '../src/modules/operations-settings/scheduler-settings.service';
import { RequestLifecycleSchedulerService } from '../src/modules/request-lifecycle/request-lifecycle-scheduler.service';
import {
  ACCEPT_OFFER,
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
let outbox: ReviewInvitationOutbox;

beforeAll(async () => {
  ctx = await createTestApp();
  outbox = ctx.app.get(ReviewInvitationOutbox);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

async function setReviewsEnabled(enabled: boolean) {
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      unviewedOfferRefundWindowHours: 48,
      providerReviewsEnabled: enabled,
    },
    update: { providerReviewsEnabled: enabled },
  });
}

async function enableReviews() {
  await setReviewsEnabled(true);
}

/**
 * A MATCHED request, reached the way a real one is: an approved request owned
 * by a signed-in customer, a provider's offer bought with credits through the
 * provider endpoint, and the customer accepting it through the action endpoint.
 */
async function matchedRequest() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const customerCookie = await loginAs(ctx.prisma, customer.id);
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });

  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId: category.id,
  });
  await grantCredits(ctx.prisma, provider.id, 5);
  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
    .set('Cookie', await loginAs(ctx.prisma, ownerUser.id))
    .send(offerPayload())
    .expect(201);
  const offerId = created.body.id as string;

  await request(ctx.server)
    .post(`/service-requests/${serviceRequest.id}/offers/${offerId}/action`)
    .set('Cookie', customerCookie)
    .send(ACCEPT_OFFER)
    .expect(201);

  const matched = await ctx.prisma.serviceRequest.findUniqueOrThrow({
    where: { id: serviceRequest.id },
  });
  expect(matched.status).toBe(ServiceRequestStatus.MATCHED);

  return { category, customer, customerCookie, provider, serviceRequest, offerId };
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

async function invitationLogs(requestId: string) {
  return ctx.prisma.notificationLog.findMany({
    where: { template: 'review-invitation', requestId },
  });
}

describe('ReviewInvitationOutbox', () => {
  it('completing a request writes one review-invitation intent inside the transaction and delivers it once', async () => {
    await enableReviews();
    const { customer, customerCookie, serviceRequest } = await matchedRequest();

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/complete`)
      .set('Cookie', customerCookie)
      .expect(201);

    // The intent is a row before anything is delivered; waiting out the
    // post-commit sweep is what makes the count below deterministic.
    await outbox.deliverPending();

    const logs = await ctx.prisma.notificationLog.findMany({
      where: { template: 'review-invitation' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      dedupeKey: `review-invitation:${serviceRequest.id}`,
      status: NotificationStatus.SENT,
      requestId: serviceRequest.id,
      userId: customer.id,
      providerId: null,
    });

    const sent = ctx.notifications.ofTemplate('review-invitation');
    expect(sent).toHaveLength(1);
    expect((sent[0]!.data as { reviewUrl: string }).reviewUrl).toContain(
      `/requests/${serviceRequest.id}/degerlendir`,
    );

    // A second sweep finds nothing owed.
    const again = await outbox.deliverPending();
    expect(again.claimed).toBe(0);
    expect(ctx.notifications.ofTemplate('review-invitation')).toHaveLength(1);
  });

  it('a second /complete is 409 and adds no intent; two parallel completes leave exactly one intent', async () => {
    await enableReviews();
    const { customerCookie, serviceRequest } = await matchedRequest();

    const post = () =>
      request(ctx.server)
        .post(`/service-requests/${serviceRequest.id}/complete`)
        .set('Cookie', customerCookie);

    const results = await Promise.allSettled([post(), post()]);
    const statuses = results
      .map((result) => (result.status === 'fulfilled' ? result.value.status : -1))
      .sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    // A third, sequential attempt is the plain conflict path, unchanged.
    const third = await post();
    expect(third.status).toBe(409);
    expect(third.body.message).toBe('Only a matched request can be completed');

    await outbox.deliverPending();

    expect(await invitationLogs(serviceRequest.id)).toHaveLength(1);
    expect(ctx.notifications.ofTemplate('review-invitation')).toHaveLength(1);
  });

  it('writes no intent while the switch is off', async () => {
    await setReviewsEnabled(false);
    const { customerCookie, serviceRequest } = await matchedRequest();

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/complete`)
      .set('Cookie', customerCookie)
      .expect(201);
    await outbox.deliverPending();

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(ServiceRequestStatus.COMPLETED);
    expect(await invitationLogs(serviceRequest.id)).toHaveLength(0);
    expect(ctx.notifications.ofTemplate('review-invitation')).toHaveLength(0);
  });

  it('writes no intent when no settings row exists yet, without disturbing the completion', async () => {
    // No operationsSettings row at all: the transactional read fails closed
    // on a missing row exactly as it does on a false column, and the
    // completion itself still commits.
    expect(await ctx.prisma.operationsSettings.count()).toBe(0);
    const { customerCookie, serviceRequest } = await matchedRequest();

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/complete`)
      .set('Cookie', customerCookie)
      .expect(201);
    await outbox.deliverPending();

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(ServiceRequestStatus.COMPLETED);
    expect(await invitationLogs(serviceRequest.id)).toHaveLength(0);
  });

  it("an admin completing on the customer's behalf still invites the customer", async () => {
    await enableReviews();
    const { customer, serviceRequest } = await matchedRequest();

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/complete`)
      .set('Cookie', await adminCookie())
      .expect(201);
    await outbox.deliverPending();

    const logs = await invitationLogs(serviceRequest.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      status: NotificationStatus.SENT,
      userId: customer.id,
      providerId: null,
    });
    const sent = ctx.notifications.ofTemplate('review-invitation');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(serviceRequest.customerEmail);
  });

  it('enqueues nothing for a request that is not COMPLETED', async () => {
    await enableReviews();
    const { serviceRequest } = await matchedRequest();

    const result = await ctx.prisma.$transaction((tx) =>
      outbox.enqueue(tx, serviceRequest.id, new Date()),
    );

    expect(result).toEqual({ enqueued: 0 });
    expect(await invitationLogs(serviceRequest.id)).toHaveLength(0);
  });

  it('the scheduler tick sweeps an intent a crashed delivery left behind', async () => {
    await enableReviews();
    const { customer, serviceRequest } = await matchedRequest();
    // The status change landed but the process died before the post-commit
    // delivery: the row is exactly what the transaction wrote, untouched.
    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { status: ServiceRequestStatus.COMPLETED, completedAt: new Date() },
    });
    await ctx.prisma.notificationLog.create({
      data: intentRow({
        template: 'review-invitation',
        to: serviceRequest.customerEmail!,
        dedupeKey: `review-invitation:${serviceRequest.id}`,
        requestId: serviceRequest.id,
        userId: customer.id,
        providerId: null,
      }),
    });
    const operator = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await ctx.app.get(SchedulerSettingsService).setEnabled('request-expiry', true, operator.id);

    await ctx.app.get(RequestLifecycleSchedulerService).runScheduledExpiry();

    const logs = await invitationLogs(serviceRequest.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe(NotificationStatus.SENT);
    expect(ctx.notifications.ofTemplate('review-invitation')).toHaveLength(1);
    const run = ctx.app.get(SchedulerRunRegistry).get('request-expiry');
    expect(run?.outcome).toBe('SUCCESS');
    expect(run?.summary).toContain('reviewInvitationsSent=1');
  });
});
