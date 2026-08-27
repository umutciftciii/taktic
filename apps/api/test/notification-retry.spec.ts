import {
  NotificationChannel,
  NotificationStatus,
  OfferStatus,
  ProviderStatus,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TransactionalMailService } from '../src/modules/notifications/transactional-mail.service';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * The admin re-send of a failed transactional e-mail.
 *
 * Three properties are what this suite exists for, and each of them is a way
 * the feature could quietly become something else:
 *
 * 1. A retry acts on the row that already exists. No second audit row, no
 *    second dedupe key, no second notification identity.
 * 2. Only a settled failure whose message can be composed again is offered.
 *    Anything carrying a one-time token is refused at the endpoint, not merely
 *    hidden in the interface.
 * 3. The message is rebuilt from live domain data through the same builders the
 *    first attempt used — so a retry can neither be steered by its caller nor
 *    say something the original would not have said.
 */

let ctx: TestContext;
let mail: TransactionalMailService;

beforeAll(async () => {
  ctx = await createTestApp();
  mail = ctx.app.get(TransactionalMailService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

/**
 * A real FAILED row for a provider application receipt: the production send
 * path runs, the transport refuses once, and the dispatcher records the
 * failure. Nothing about the row is hand-written, so the dedupe key and the
 * masked recipient are the ones the application really writes.
 */
async function failedApplicationReceipt(overrides: { email?: string } = {}) {
  const provider = await createProviderProfile(ctx.prisma, {
    status: ProviderStatus.PENDING_REVIEW,
    email: overrides.email ?? `applicant-${uniqueSuffix()}@example.test`,
  });

  ctx.notifications.failNextSend = true;
  await mail.sendProviderApplicationReceived(provider.id);
  ctx.notifications.clear();

  const log = await ctx.prisma.notificationLog.findFirstOrThrow({
    where: { template: 'provider-application-received' },
  });

  expect(log.status).toBe(NotificationStatus.FAILED);
  return { provider, log };
}

/** The configuration failures this feature was built to recover from. */
async function markErrorCode(logId: string, errorCode: string) {
  await ctx.prisma.notificationLog.update({ where: { id: logId }, data: { errorCode } });
}

/**
 * Marks the fan-out's invitation row failed.
 *
 * The fan-out mails the customer first, so making "the next send" fail would
 * fail the wrong message. The invitation's failure is stated directly instead —
 * these cases are about what a retry does with a failed row, not about how the
 * row came to be failed.
 */
async function failInvitation() {
  const row = await ctx.prisma.notificationLog.findFirstOrThrow({
    where: { template: 'request-available' },
  });

  return ctx.prisma.notificationLog.update({
    where: { id: row.id },
    data: {
      status: NotificationStatus.FAILED,
      sentAt: null,
      failedAt: new Date(),
      providerMessageId: null,
      errorCode: 'TRANSPORT_UNAVAILABLE',
    },
  });
}

async function seedLog(overrides: {
  channel?: NotificationChannel;
  template: string;
  status?: NotificationStatus;
  dedupeKey?: string | null;
  maskedRecipient?: string;
}) {
  return ctx.prisma.notificationLog.create({
    data: {
      channel: overrides.channel ?? NotificationChannel.EMAIL,
      template: overrides.template,
      maskedRecipient: overrides.maskedRecipient ?? 'u***@example.test',
      status: overrides.status ?? NotificationStatus.FAILED,
      dedupeKey: overrides.dedupeKey === undefined ? null : overrides.dedupeKey,
    },
  });
}

describe('retry eligibility', () => {
  it('offers a retry for a failed, reproducible transactional e-mail', async () => {
    const { log } = await failedApplicationReceipt();
    await markErrorCode(log.id, 'EMAIL_BRANDING_INCOMPLETE');
    const cookie = await adminCookie();

    const response = await request(ctx.server)
      .get(`/notification-logs/${log.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.retryable).toBe(true);
    expect(response.body.retryBlock).toBeNull();
    expect(response.body.errorCode).toBe('EMAIL_BRANDING_INCOMPLETE');
    expect(response.body.attemptCount).toBe(1);
    // The key that makes the rebuild possible stays inside the API.
    expect(response.body).not.toHaveProperty('dedupeKey');
  });

  it.each([
    'password-reset',
    'email-verification',
    'customer-activation',
    'provider-claim',
  ])('refuses %s, which carried a single-use token', async (template) => {
    // A key is invented on purpose: even given one, a token-bearing template is
    // refused on the template alone.
    const log = await seedLog({ template, dedupeKey: `${template}:whatever` });
    const cookie = await adminCookie();

    const detail = await request(ctx.server)
      .get(`/notification-logs/${log.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.retryable).toBe(false);
    expect(detail.body.retryBlock).toBe('TEMPLATE_NOT_REPRODUCIBLE');

    await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .expect(400);

    expect(ctx.notifications.sent).toHaveLength(0);
    expect(await ctx.prisma.notificationLog.count()).toBe(1);
  });

  it.each([NotificationStatus.SENT, NotificationStatus.PENDING])(
    'refuses a %s row as a conflict',
    async (status) => {
      const log = await seedLog({
        template: 'request-received',
        status,
        dedupeKey: `request-received:${uniqueSuffix()}`,
      });
      const cookie = await adminCookie();

      const detail = await request(ctx.server)
        .get(`/notification-logs/${log.id}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(detail.body.retryable).toBe(false);
      expect(detail.body.retryBlock).toBe('STATUS_NOT_FAILED');

      // 409 rather than 400: unlike a token-bearing template, this row is
      // refused because of the state it is in right now, and that state is
      // decided by the claim rather than by a read.
      await request(ctx.server)
        .post(`/notification-logs/${log.id}/retry`)
        .set('Cookie', cookie)
        .expect(409);

      expect(ctx.notifications.sent).toHaveLength(0);
    },
  );

  it('refuses an SMS row', async () => {
    const log = await seedLog({
      channel: NotificationChannel.SMS,
      template: 'phone-verification-code',
      maskedRecipient: '+90 *** *** ** 34',
    });
    const cookie = await adminCookie();

    const detail = await request(ctx.server)
      .get(`/notification-logs/${log.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.retryable).toBe(false);
    expect(detail.body.retryBlock).toBe('CHANNEL_NOT_EMAIL');

    await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .expect(400);
  });

  it('refuses a row that names no transition', async () => {
    const log = await seedLog({ template: 'request-received', dedupeKey: null });
    const cookie = await adminCookie();

    const detail = await request(ctx.server)
      .get(`/notification-logs/${log.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.retryBlock).toBe('NO_SOURCE_TRANSITION');

    await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .expect(400);
  });
});

describe('retry authorization', () => {
  it('answers 401 without a session', async () => {
    const { log } = await failedApplicationReceipt();

    await request(ctx.server).post(`/notification-logs/${log.id}/retry`).expect(401);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it.each([UserRole.CUSTOMER, UserRole.PROVIDER])('answers 403 for %s', async (role) => {
    const { log } = await failedApplicationReceipt();
    const user = await createUser(ctx.prisma, { role });
    const cookie = await loginAs(ctx.prisma, user.id);

    await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .expect(403);

    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('takes only a log id — no recipient, template or body', async () => {
    const { log } = await failedApplicationReceipt();
    const cookie = await adminCookie();

    // forbidNonWhitelisted is global, but the point is stronger than validation:
    // the route has no body parameter at all, so an attempt to steer it is
    // simply ignored rather than partially honoured.
    await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .send({ to: 'attacker@example.test', subject: 'hi', template: 'password-reset' })
      .expect(200);

    expect(ctx.notifications.sent).toHaveLength(1);
    expect(ctx.notifications.sent[0]!.template).toBe('provider-application-received');
    expect(ctx.notifications.sent[0]!.to).not.toBe('attacker@example.test');
  });
});

describe('retrying a failed message', () => {
  it('sends once, on the same row, once the settings are valid again', async () => {
    const { provider, log } = await failedApplicationReceipt();
    await markErrorCode(log.id, 'EMAIL_PUBLIC_URL_INVALID');
    const cookie = await adminCookie();

    const response = await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.id).toBe(log.id);
    expect(response.body.status).toBe('SENT');
    expect(response.body.attemptCount).toBe(2);
    expect(response.body.errorCode).toBeNull();
    expect(response.body.lastAttemptAt).not.toBeNull();
    // Settled and sent, so the control is gone.
    expect(response.body.retryable).toBe(false);

    const sent = ctx.notifications.sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(provider.email);
    expect(sent[0]!.template).toBe('provider-application-received');

    // No new notification identity: one row, one dedupe key, still unique.
    const rows = await ctx.prisma.notificationLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupeKey).toBe(`application-received:${provider.id}`);
  });

  it('produces one send when the same retry is issued twice at once', async () => {
    const { log } = await failedApplicationReceipt();
    const cookie = await adminCookie();

    const responses = await Promise.all([
      request(ctx.server).post(`/notification-logs/${log.id}/retry`).set('Cookie', cookie),
      request(ctx.server).post(`/notification-logs/${log.id}/retry`).set('Cookie', cookie),
    ]);

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(ctx.notifications.sent).toHaveLength(1);
    expect(await ctx.prisma.notificationLog.count()).toBe(1);

    const row = await ctx.prisma.notificationLog.findUniqueOrThrow({ where: { id: log.id } });
    expect(row.status).toBe(NotificationStatus.SENT);
    expect(row.attemptCount).toBe(2);
  });

  it('produces one send when the retry is issued twice in a row', async () => {
    const { log } = await failedApplicationReceipt();
    const cookie = await adminCookie();

    await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .expect(200);

    // The row is SENT now, so the second click loses the claim — the same
    // answer a simultaneous second click gets, rather than a different one.
    await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .expect(409);

    expect(ctx.notifications.sent).toHaveLength(1);
  });

  it('records a settled failure when the transport fails again', async () => {
    const { log } = await failedApplicationReceipt();
    const cookie = await adminCookie();
    ctx.notifications.failNextSend = true;

    const response = await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.status).toBe('FAILED');
    expect(response.body.errorCode).toBe('TRANSPORT_UNAVAILABLE');
    expect(response.body.attemptCount).toBe(2);
    // Still failed and still reproducible, so it may be tried again.
    expect(response.body.retryable).toBe(true);
    expect(ctx.notifications.sent).toHaveLength(0);
  });
});

describe('rebuilding from live data', () => {
  it('fails safely when the source row is gone', async () => {
    const log = await seedLog({
      template: 'offer-received',
      dedupeKey: `offer-received:${uniqueSuffix()}`,
    });
    const cookie = await adminCookie();

    const response = await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.status).toBe('FAILED');
    expect(response.body.errorCode).toBe('SOURCE_UNAVAILABLE');
    expect(response.body.attemptCount).toBe(2);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('refuses to deliver to an address the row was never addressed to', async () => {
    const { provider, log } = await failedApplicationReceipt();
    await ctx.prisma.providerProfile.update({
      where: { id: provider.id },
      data: { email: `somebody-else-${uniqueSuffix()}@example.test` },
    });
    const cookie = await adminCookie();

    const response = await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.status).toBe('FAILED');
    expect(response.body.errorCode).toBe('SOURCE_UNAVAILABLE');
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('re-applies the transition guard: a suspended application is not told it was approved', async () => {
    const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    const approvedAt = new Date();

    ctx.notifications.failNextSend = true;
    await mail.sendProviderApplicationApproved(provider.id, approvedAt);
    ctx.notifications.clear();

    await ctx.prisma.providerProfile.update({
      where: { id: provider.id },
      data: { status: ProviderStatus.SUSPENDED },
    });

    const log = await ctx.prisma.notificationLog.findFirstOrThrow({
      where: { template: 'provider-application-approved' },
    });
    const cookie = await adminCookie();

    const response = await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.errorCode).toBe('SOURCE_UNAVAILABLE');
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('does not mail a request to a provider who no longer matches it', async () => {
    const category = await createCategory(ctx.prisma, `Klima ${uniqueSuffix()}`, {
      offerCreditCost: 2,
    });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });

    await mail.fanOutApprovedRequest(serviceRequest.id, new Date());
    ctx.notifications.clear();
    const available = await failInvitation();

    await ctx.prisma.providerProfile.update({
      where: { id: provider.id },
      data: { status: ProviderStatus.SUSPENDED },
    });

    const cookie = await adminCookie();
    const response = await request(ctx.server)
      .post(`/notification-logs/${available.id}/retry`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.errorCode).toBe('SOURCE_UNAVAILABLE');
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('re-renders a matching request without any customer contact detail', async () => {
    const category = await createCategory(ctx.prisma, `Klima ${uniqueSuffix()}`, {
      offerCreditCost: 2,
    });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { neighborhood: 'Caferağa', addressNote: 'Kapı no 7' },
    });
    await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });

    await mail.fanOutApprovedRequest(serviceRequest.id, new Date());
    ctx.notifications.clear();
    const available = await failInvitation();
    const cookie = await adminCookie();

    await request(ctx.server)
      .post(`/notification-logs/${available.id}/retry`)
      .set('Cookie', cookie)
      .expect(200);

    expect(ctx.notifications.sent).toHaveLength(1);
    const body = JSON.stringify(ctx.notifications.sent[0]!.data);
    expect(body).toContain('Kadıköy');
    for (const secret of [
      serviceRequest.customerEmail,
      serviceRequest.customerPhone,
      serviceRequest.customerName,
      'Caferağa',
      'Kapı no 7',
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it('re-renders a match without contact details when disclosure never opened', async () => {
    const category = await createCategory(ctx.prisma, `Klima ${uniqueSuffix()}`, {
      offerCreditCost: 2,
    });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    const offer = await ctx.prisma.offer.create({
      data: {
        requestId: serviceRequest.id,
        providerId: provider.id,
        status: OfferStatus.ACCEPTED,
        priceAmount: 250000,
        message: 'Teklifim',
        acceptedAt: new Date(),
      },
    });
    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { status: ServiceRequestStatus.MATCHED, matchedOfferId: offer.id },
    });

    ctx.notifications.failNextSend = true;
    await mail.sendMatchNotifications(offer.id);
    ctx.notifications.clear();

    const log = await ctx.prisma.notificationLog.findFirstOrThrow({
      where: { template: 'match-customer', status: NotificationStatus.FAILED },
    });
    const cookie = await adminCookie();

    await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .expect(200);

    expect(ctx.notifications.sent).toHaveLength(1);
    const message = ctx.notifications.sent[0]!;
    expect(message.template).toBe('match-customer');
    // No ContactRevealEvent, so the disclosure rows are absent on the retry for
    // exactly the reason they were absent on the first attempt.
    expect(message.data?.contactName).toBeNull();
    expect(message.data?.contactPhone).toBeNull();
    expect(JSON.stringify(message.data)).not.toContain(provider.phone);
  });
});
