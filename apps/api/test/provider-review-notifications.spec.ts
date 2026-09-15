import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TransactionalMailService } from '../src/modules/notifications/transactional-mail.service';
import { DEFAULT_SUPPORT_INBOX_EMAIL } from '../src/modules/support-tickets/support-inbox.config';
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
  ctx.notifications.clear();
  delete process.env.SUPPORT_INBOX_EMAIL;
  await setReviewsEnabled(true);
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

/** A completed request with its accepted offer, written straight into the tables. */
async function completedJob() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    categoryId: category.id,
    userId: owner.id,
  });
  const req = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });
  await grantCredits(ctx.prisma, provider.id, 5);
  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${req.id}/offers`)
    .set('Cookie', await loginAs(ctx.prisma, owner.id))
    .send(offerPayload())
    .expect(201);
  await ctx.prisma.offer.update({
    where: { id: created.body.id },
    data: { status: 'ACCEPTED', acceptedAt: new Date() },
  });
  await ctx.prisma.serviceRequest.update({
    where: { id: req.id },
    data: {
      status: 'COMPLETED',
      matchedOfferId: created.body.id,
      matchedAt: new Date(),
      completedAt: new Date(),
    },
  });
  return { category, customer, owner, provider, request: req, offerId: created.body.id as string };
}

type Job = Awaited<ReturnType<typeof completedJob>>;

function ids(job: Job) {
  return {
    requestId: job.request.id,
    offerId: job.offerId,
    providerId: job.provider.id,
    customerUserId: job.customer.id,
  };
}

/** Everything a mail must never carry: the comment, the customer's name, phones and addresses. */
const LEAKS = /Harika|Ayşe|0555|example\.test|Müşteri|gizli not/;

describe('provider review notifications', () => {
  it('review-received goes to the provider once, without the comment or the customer', async () => {
    const job = await completedJob();
    const review = await ctx.prisma.providerReview.create({
      data: { ...ids(job), rating: 5, comment: 'Harika iş, teşekkürler Ayşe' },
    });
    const mail = ctx.app.get(TransactionalMailService);

    await mail.sendReviewReceived(review.id);
    await mail.sendReviewReceived(review.id);

    const sent = ctx.notifications.ofTemplate('review-received');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(job.owner.email);
    expect(JSON.stringify(sent[0]!.data)).not.toMatch(LEAKS);
    expect(sent[0]!.data?.rating).toBe('5');
    expect(sent[0]!.data?.fullName).toBe(job.provider.contactName);
    expect(sent[0]!.data?.requestNumber).toBe(job.request.requestNumber);
    expect(sent[0]!.data?.categoryName).toBe(job.category.name);
    expect(sent[0]!.data?.reviewsUrl).toContain(`/providers/${job.provider.id}/degerlendirmeler`);

    const logs = await ctx.prisma.notificationLog.findMany({
      where: { template: 'review-received' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.dedupeKey).toBe(`review-received:${review.id}`);
    expect(logs[0]!.requestId).toBe(job.request.id);
    expect(logs[0]!.providerId).toBe(job.provider.id);
  });

  it('review-received is not sent for a removed review', async () => {
    const job = await completedJob();
    const review = await ctx.prisma.providerReview.create({
      data: { ...ids(job), rating: 3, removedAt: new Date() },
    });
    await ctx.app.get(TransactionalMailService).sendReviewReceived(review.id);
    expect(ctx.notifications.ofTemplate('review-received')).toHaveLength(0);
  });

  it('review-removed carries the scope and a fixed label, is keyed on the removal instant, and does not rebuild after RESTORE', async () => {
    const job = await completedJob();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const removedAt = new Date('2026-09-15T10:00:00.000Z');
    const review = await ctx.prisma.providerReview.create({
      data: {
        ...ids(job),
        rating: 2,
        comment: 'Harika değil, ara beni 0555 123',
        commentRemovedAt: removedAt,
      },
    });
    await ctx.prisma.providerReviewModeration.create({
      data: {
        reviewId: review.id,
        action: 'REMOVE_COMMENT',
        reason: 'CONTAINS_CONTACT_INFO',
        note: 'gizli not',
        performedById: admin.id,
        createdAt: removedAt,
      },
    });
    const mail = ctx.app.get(TransactionalMailService);

    await mail.sendReviewRemoved(review.id, removedAt);
    await mail.sendReviewRemoved(review.id, removedAt);

    const sent = ctx.notifications.ofTemplate('review-removed');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(job.request.customerEmail);
    expect(sent[0]!.data?.scopeLabel).toBe('Yorumunuz');
    expect(sent[0]!.data?.reasonLabel).toBe('İletişim bilgisi içeriyor');
    expect(sent[0]!.data?.requestNumber).toBe(job.request.requestNumber);
    expect(sent[0]!.data?.supportUrl).toContain('/destek');
    expect(JSON.stringify(sent[0]!.data)).not.toMatch(/Harika|0555|gizli not|example\.test/);

    const key = `review-removed:${review.id}:${removedAt.toISOString()}`;
    const logs = await ctx.prisma.notificationLog.findMany({
      where: { template: 'review-removed' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.dedupeKey).toBe(key);

    // A second removal instant is a second notice; the rebuild reads the
    // latest removal's reason and scope back from the rows.
    const later = new Date('2026-09-16T10:00:00.000Z');
    await ctx.prisma.providerReview.update({
      where: { id: review.id },
      data: { removedAt: later },
    });
    await ctx.prisma.providerReviewModeration.create({
      data: {
        reviewId: review.id,
        action: 'REMOVE_REVIEW',
        reason: 'OFFENSIVE',
        performedById: admin.id,
        createdAt: later,
      },
    });
    await mail.sendReviewRemoved(review.id, later);
    expect(ctx.notifications.ofTemplate('review-removed')).toHaveLength(2);
    const rebuilt = await mail.composeRetryMessage('review-removed', key);
    expect(rebuilt?.to).toBe(job.request.customerEmail);
    expect(rebuilt?.data?.scopeLabel).toBe('Değerlendirmeniz');
    expect(rebuilt?.data?.reasonLabel).toBe('Hakaret veya uygunsuz dil');

    // RESTORE: nothing stands any more, so nothing can be re-sent.
    await ctx.prisma.providerReview.update({
      where: { id: review.id },
      data: { removedAt: null, commentRemovedAt: null },
    });
    await ctx.prisma.providerReviewModeration.create({
      data: { reviewId: review.id, action: 'RESTORE', performedById: admin.id },
    });
    expect(await mail.composeRetryMessage('review-removed', key)).toBeNull();
    await mail.sendReviewRemoved(review.id, new Date());
    expect(ctx.notifications.ofTemplate('review-removed')).toHaveLength(2);
  });

  it('review-report-new-for-support goes to the support inbox without the note', async () => {
    const job = await completedJob();
    const reporter = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const reporterProfile = await createDiscoverableProvider(ctx.prisma, {
      categoryId: (await createCategory(ctx.prisma, 'Boya', { offerCreditCost: 1 })).id,
      userId: reporter.id,
    });
    const review = await ctx.prisma.providerReview.create({
      data: { ...ids(job), rating: 1, comment: 'Harika değil' },
    });
    const report = await ctx.prisma.providerReviewReport.create({
      data: {
        reviewId: review.id,
        reporterProviderId: reporterProfile.id,
        reason: 'SUSPECTED_FAKE',
        note: 'gizli not: bu müşteri hiç gelmedi',
      },
    });
    const mail = ctx.app.get(TransactionalMailService);

    await mail.sendReviewReportNewForSupport(report.id);
    await mail.sendReviewReportNewForSupport(report.id);

    const sent = ctx.notifications.ofTemplate('review-report-new-for-support');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
    expect(sent[0]!.data?.fullName).toBe('Destek Ekibi');
    expect(sent[0]!.data?.reasonLabel).toBe('Sahte şüphesi');
    expect(sent[0]!.data?.businessName).toBe(job.provider.businessName);
    expect(sent[0]!.data?.requestNumber).toBe(job.request.requestNumber);
    expect(sent[0]!.data?.adminReviewUrl).toContain(`/provider-reviews/${review.id}`);
    expect(sent[0]!.data?.accountUrl).toBeNull();
    expect(JSON.stringify(sent[0]!.data)).not.toMatch(LEAKS);

    const logs = await ctx.prisma.notificationLog.findMany({
      where: { template: 'review-report-new-for-support' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.dedupeKey).toBe(`review-report-new:${report.id}`);
    expect(logs[0]!.providerId).toBe(reporterProfile.id);
    expect(logs[0]!.requestId).toBe(job.request.id);
  });

  it('composeRetryMessage rebuilds each of the four from its key and returns null when the source no longer supports it', async () => {
    const job = await completedJob();
    const mail = ctx.app.get(TransactionalMailService);

    // review-invitation: rebuilt from the request alone, while the window is
    // open, no review exists and the switch is on.
    const invitationKey = `review-invitation:${job.request.id}`;
    const invitation = await mail.composeRetryMessage('review-invitation', invitationKey);
    expect(invitation?.to).toBe(job.request.customerEmail);
    expect(invitation?.template).toBe('review-invitation');
    expect(invitation?.data?.reviewUrl).toContain(`/requests/${job.request.id}/degerlendir`);
    expect(invitation?.data?.businessName).toBe(job.provider.businessName);
    expect(invitation?.data?.categoryName).toBe(job.category.name);
    expect(invitation?.data?.requestNumber).toBe(job.request.requestNumber);
    expect(invitation?.data?.fullName).toBe(job.request.customerName);
    expect(invitation?.data?.windowEndsAt).toMatch(/^\d{1,2} \S+ \d{4}$/);
    expect(invitation?.data?.accountUrl).toContain('/account');
    expect(JSON.stringify(invitation?.data)).not.toMatch(/0555|example\.test/);

    await setReviewsEnabled(false);
    expect(await mail.composeRetryMessage('review-invitation', invitationKey)).toBeNull();
    await setReviewsEnabled(true);

    await ctx.prisma.serviceRequest.update({
      where: { id: job.request.id },
      data: { completedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) },
    });
    expect(await mail.composeRetryMessage('review-invitation', invitationKey)).toBeNull();
    await ctx.prisma.serviceRequest.update({
      where: { id: job.request.id },
      data: { completedAt: new Date() },
    });
    expect(await mail.composeRetryMessage('review-invitation', invitationKey)).not.toBeNull();

    const review = await ctx.prisma.providerReview.create({
      data: { ...ids(job), rating: 4, comment: 'Harika' },
    });
    expect(await mail.composeRetryMessage('review-invitation', invitationKey)).toBeNull();

    // review-received: from the review; null once it is removed.
    const receivedKey = `review-received:${review.id}`;
    const received = await mail.composeRetryMessage('review-received', receivedKey);
    expect(received?.to).toBe(job.owner.email);
    expect(received?.data?.rating).toBe('4');
    expect(JSON.stringify(received?.data)).not.toMatch(LEAKS);

    // review-report-new-for-support: from the report row; null for an unknown id.
    const report = await ctx.prisma.providerReviewReport.create({
      data: {
        reviewId: review.id,
        reporterProviderId: job.provider.id,
        reason: 'OTHER',
        note: 'gizli not',
      },
    });
    const forSupport = await mail.composeRetryMessage(
      'review-report-new-for-support',
      `review-report-new:${report.id}`,
    );
    expect(forSupport?.to).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
    expect(forSupport?.data?.reasonLabel).toBe('Diğer');
    expect(JSON.stringify(forSupport?.data)).not.toMatch(LEAKS);
    expect(
      await mail.composeRetryMessage('review-report-new-for-support', 'review-report-new:nope'),
    ).toBeNull();
    // A key under another template's prefix is refused before any lookup.
    expect(
      await mail.composeRetryMessage('review-report-new-for-support', receivedKey),
    ).toBeNull();

    // review-removed: null while nothing is removed, rebuilt once something is.
    const key = `review-removed:${review.id}:2026-09-15T10:00:00.000Z`;
    expect(await mail.composeRetryMessage('review-removed', key)).toBeNull();
    await ctx.prisma.providerReview.update({
      where: { id: review.id },
      data: { removedAt: new Date() },
    });
    const removed = await mail.composeRetryMessage('review-removed', key);
    expect(removed?.to).toBe(job.request.customerEmail);
    expect(removed?.data?.scopeLabel).toBe('Değerlendirmeniz');
    // No moderation row (a direct write): the reason floors to OTHER's label.
    expect(removed?.data?.reasonLabel).toBe('Platform kurallarına aykırı');
    expect(await mail.composeRetryMessage('review-received', receivedKey)).toBeNull();
  });
});
