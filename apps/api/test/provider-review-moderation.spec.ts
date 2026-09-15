import { OfferStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SUPPORT_INBOX_EMAIL } from '../src/modules/support-tickets/support-inbox.config';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The reviewed business reporting a comment, and the operator deciding what
 * to do about it.
 *
 * Three invariants these cases guard beyond the happy paths. **A report hides
 * nothing**: only an operator's decision changes what anybody sees. **A
 * decision is one transaction with a state predicate**: two operators acting
 * on the same review get one success and one 409, and a repeated action is a
 * 409, never a second removal. **Nothing about the reporter or the operator's
 * notes reaches the customer**: the removal mail carries the reason's fixed
 * label and nothing else about why.
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
  delete process.env.SUPPORT_INBOX_EMAIL;
  await setReviewsEnabled(true);
});

async function setReviewsEnabled(enabled: boolean) {
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48, providerReviewsEnabled: enabled },
    update: { providerReviewsEnabled: enabled },
  });
}

type ProviderFixture = Awaited<ReturnType<typeof providerFixture>>;

/** An APPROVED provider with a signed-in owner, in one category. */
async function providerFixture(categoryId?: string) {
  const category = categoryId
    ? { id: categoryId }
    : await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 });
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    categoryId: category.id,
    userId: owner.id,
  });
  const ownerCookie = await loginAs(ctx.prisma, owner.id);
  return { category, owner, ownerCookie, provider };
}

/** A COMPLETED request with its ACCEPTED offer, written straight into the tables. */
async function completedJob(fixture: ProviderFixture) {
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: fixture.category.id,
    customerId: customer.id,
  });
  const offer = await ctx.prisma.offer.create({
    data: {
      requestId: serviceRequest.id,
      providerId: fixture.provider.id,
      status: OfferStatus.ACCEPTED,
      acceptedAt: new Date(),
      priceAmount: 1000,
      message: 'Teklif',
    },
  });
  await ctx.prisma.serviceRequest.update({
    where: { id: serviceRequest.id },
    data: {
      status: ServiceRequestStatus.COMPLETED,
      matchedOfferId: offer.id,
      matchedAt: new Date(),
      completedAt: new Date(),
    },
  });
  return { customer, serviceRequest, offer };
}

/** One review on a fresh completed job for the fixture's provider. */
async function review(
  fixture: ProviderFixture,
  data: { rating: number; comment?: string | null; createdAt?: Date },
) {
  const job = await completedJob(fixture);
  const row = await ctx.prisma.providerReview.create({
    data: {
      requestId: job.serviceRequest.id,
      offerId: job.offer.id,
      providerId: fixture.provider.id,
      customerUserId: job.customer.id,
      rating: data.rating,
      comment: data.comment ?? null,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
  return { ...job, review: row };
}

async function adminSession() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { admin, cookie: await loginAs(ctx.prisma, admin.id) };
}

const reportUrl = (providerId: string, reviewId: string) =>
  `/providers/${providerId}/reviews/${reviewId}/reports`;
const panelUrl = (providerId: string) => `/providers/${providerId}/reviews`;
const summaryUrl = (providerId: string) => `/providers/${providerId}/reviews/summary`;
const publicUrl = (providerId: string) => `/providers/${providerId}/reviews/public`;
const adminUrl = (reviewId: string) => `/provider-reviews/${reviewId}`;
const moderateUrl = (reviewId: string) => `/provider-reviews/${reviewId}/moderate`;
const dismissUrl = (reviewId: string) => `/provider-reviews/${reviewId}/reports/dismiss`;
const queueUrl = '/provider-reviews/reports';

function report(fixture: ProviderFixture, reviewId: string, body: Record<string, unknown>) {
  return request(ctx.server)
    .post(reportUrl(fixture.provider.id, reviewId))
    .set('Cookie', fixture.ownerCookie)
    .send(body);
}

/** The strings every fixture plants that must never reach a customer or a provider. */
const LEAKS = /Müşteri |0555|@example\.test|User |gizli/;

describe('provider review reports', () => {
  it('only the reviewed provider can report, once while open; a super admin is 403, a rival is 404; no comment is 409 REVIEW_NOT_REPORTABLE', async () => {
    const owner = await providerFixture();
    const rival = await providerFixture(owner.category.id);
    const admin = await adminSession();
    const commented = await review(owner, { rating: 1, comment: 'Berbat, hiç gelmedi.' });
    const bare = await review(owner, { rating: 2 });

    // A report is the reviewed business's own statement, so an operator —
    // who may act for a provider on every other panel route — is refused
    // here, and before the review is even looked up.
    const adminTry = await request(ctx.server)
      .post(reportUrl(owner.provider.id, commented.review.id))
      .set('Cookie', admin.cookie)
      .send({ reason: 'OFFENSIVE' });
    expect(adminTry.status).toBe(403);
    const adminMissing = await request(ctx.server)
      .post(reportUrl(owner.provider.id, 'no-such-review'))
      .set('Cookie', admin.cookie)
      .send({ reason: 'OFFENSIVE' });
    expect(adminMissing.status).toBe(403);
    expect(await ctx.prisma.providerReviewReport.count()).toBe(0);

    // The operator's other panel reads are untouched.
    await request(ctx.server).get(panelUrl(owner.provider.id)).set('Cookie', admin.cookie).expect(200);

    // The rival cannot tell this review from a non-existent one.
    const rivalTry = await report(rival, commented.review.id, { reason: 'OFFENSIVE' });
    expect(rivalTry.status).toBe(404);
    expect(await ctx.prisma.providerReviewReport.count()).toBe(0);

    const created = await report(owner, commented.review.id, {
      reason: 'SUSPECTED_FAKE',
      note: '  gizli not  ',
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      reason: 'SUSPECTED_FAKE',
      createdAt: expect.any(String),
    });
    const stored = await ctx.prisma.providerReviewReport.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(stored.reporterProviderId).toBe(owner.provider.id);
    expect(stored.note).toBe('gizli not');
    expect(stored.resolvedAt).toBeNull();

    const again = await report(owner, commented.review.id, { reason: 'OTHER' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('REVIEW_REPORT_ALREADY_EXISTS');

    const noComment = await report(owner, bare.review.id, { reason: 'OTHER' });
    expect(noComment.status).toBe(409);
    expect(noComment.body.code).toBe('REVIEW_NOT_REPORTABLE');

    // A bad reason is the DTO's business, not the service's.
    const badReason = await report(owner, commented.review.id, { reason: 'NOPE' });
    expect(badReason.status).toBe(400);

    // The provider's own list shows the report they filed and nothing more.
    const list = await request(ctx.server)
      .get(panelUrl(owner.provider.id))
      .set('Cookie', owner.ownerCookie)
      .expect(200);
    const mine = list.body.items.find((item: { id: string }) => item.id === commented.review.id);
    expect(mine.myReport).toEqual({
      reason: 'SUSPECTED_FAKE',
      createdAt: expect.any(String),
      resolution: null,
    });
    expect(JSON.stringify(list.body)).not.toMatch(LEAKS);
  });

  it('a report hides nothing: the public list still shows the comment', async () => {
    const owner = await providerFixture();
    const reported = await review(owner, { rating: 1, comment: 'Berbat, hiç gelmedi.' });
    await review(owner, { rating: 5, comment: 'Harika iş.' });
    await review(owner, { rating: 4, comment: 'İyi.' });

    await report(owner, reported.review.id, { reason: 'OFFENSIVE' }).expect(201);

    const pub = await request(ctx.server).get(publicUrl(owner.provider.id)).expect(200);
    expect(pub.body.summary).toEqual({ count: 3, average: 3.33 });
    const shown = pub.body.items.find((item: { id: string }) => item.id === reported.review.id);
    expect(shown.comment).toBe('Berbat, hiç gelmedi.');

    const summary = await request(ctx.server)
      .get(summaryUrl(owner.provider.id))
      .set('Cookie', owner.ownerCookie)
      .expect(200);
    expect(summary.body.count).toBe(3);

    const row = await ctx.prisma.providerReview.findUniqueOrThrow({ where: { id: reported.review.id } });
    expect(row.commentRemovedAt).toBeNull();
    expect(row.removedAt).toBeNull();
  });

  it('caps a provider at 20 review reports per day (429 REVIEW_REPORT_RATE_LIMITED)', async () => {
    const owner = await providerFixture();
    const admin = await adminSession();
    const target = await review(owner, { rating: 1, comment: 'Yorum.' });
    const fresh = await review(owner, { rating: 1, comment: 'Başka yorum.' });

    // Twenty decided reports today — only one may be open per review, but the
    // daily cap counts every report the provider filed, decided or not.
    const today = new Date();
    await ctx.prisma.providerReviewReport.createMany({
      data: Array.from({ length: 20 }, (_, index) => ({
        reviewId: target.review.id,
        reporterProviderId: owner.provider.id,
        reason: 'OTHER' as const,
        createdAt: new Date(today.getTime() - index * 60_000),
        resolvedAt: today,
        resolvedByUserId: admin.admin.id,
        resolution: 'DISMISSED' as const,
      })),
    });

    const capped = await report(owner, fresh.review.id, { reason: 'OTHER' });
    expect(capped.status).toBe(429);
    expect(capped.body).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      code: 'REVIEW_REPORT_RATE_LIMITED',
      message: expect.any(String),
    });

    // Yesterday's reports do not count.
    await ctx.prisma.providerReviewReport.updateMany({
      where: { reporterProviderId: owner.provider.id },
      data: { createdAt: new Date(today.getTime() - 25 * 60 * 60 * 1000) },
    });
    await report(owner, fresh.review.id, { reason: 'OTHER' }).expect(201);
  });

  it('review-report-new-for-support reaches the support inbox once, without the note', async () => {
    const owner = await providerFixture();
    const reported = await review(owner, { rating: 1, comment: 'Berbat.' });

    const created = await report(owner, reported.review.id, {
      reason: 'CONTAINS_CONTACT_INFO',
      note: 'gizli not: numarasını yazmış',
    }).expect(201);

    const sent = ctx.notifications.ofTemplate('review-report-new-for-support');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
    expect(sent[0]!.data?.reasonLabel).toBe('İletişim bilgisi');
    expect(sent[0]!.data?.businessName).toBe(owner.provider.businessName);
    expect(sent[0]!.data?.adminReviewUrl).toContain(`/provider-reviews/${reported.review.id}`);
    expect(JSON.stringify(sent[0]!.data)).not.toMatch(LEAKS);

    const logs = await ctx.prisma.notificationLog.findMany({
      where: { template: 'review-report-new-for-support' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.dedupeKey).toBe(`review-report-new:${created.body.id}`);
  });
});

describe('operator moderation', () => {
  it('REMOVE_COMMENT resolves the open report as COMMENT_REMOVED, writes a moderation row, keeps the star, mails review-removed with scope COMMENT', async () => {
    const owner = await providerFixture();
    const admin = await adminSession();
    const reported = await review(owner, { rating: 2, comment: 'Ara beni 0555 123, gizli' });
    const open = await report(owner, reported.review.id, { reason: 'CONTAINS_CONTACT_INFO' }).expect(201);
    ctx.notifications.clear();

    const decided = await request(ctx.server)
      .post(moderateUrl(reported.review.id))
      .set('Cookie', admin.cookie)
      .send({ action: 'REMOVE_COMMENT', reason: 'CONTAINS_CONTACT_INFO', note: ' operatör notu ' })
      .expect(201);

    expect(decided.body.id).toBe(reported.review.id);
    expect(decided.body.commentRemoved).toBe(true);
    expect(decided.body.removed).toBe(false);
    expect(decided.body.rating).toBe(2);
    // The operator still sees the text; every other projection treats it as gone.
    expect(decided.body.comment).toBe('Ara beni 0555 123, gizli');
    expect(decided.body.reports).toHaveLength(1);
    expect(decided.body.reports[0]).toMatchObject({
      id: open.body.id,
      reason: 'CONTAINS_CONTACT_INFO',
      resolution: 'COMMENT_REMOVED',
      resolutionNote: 'operatör notu',
      resolvedBy: { id: admin.admin.id, name: admin.admin.name },
      reporter: { id: owner.provider.id, businessName: owner.provider.businessName },
    });
    expect(decided.body.reports[0].resolvedAt).toEqual(expect.any(String));
    expect(decided.body.moderation).toHaveLength(1);
    expect(decided.body.moderation[0]).toMatchObject({
      action: 'REMOVE_COMMENT',
      reason: 'CONTAINS_CONTACT_INFO',
      note: 'operatör notu',
      performedBy: { id: admin.admin.id, name: admin.admin.name },
    });
    expect(decided.body.request).toMatchObject({
      id: reported.serviceRequest.id,
      requestNumber: reported.serviceRequest.requestNumber,
      customerName: reported.serviceRequest.customerName,
      city: 'İstanbul',
      district: 'Kadıköy',
    });

    // The star stays in the aggregate; the provider's list shows a removed comment.
    const summary = await request(ctx.server)
      .get(summaryUrl(owner.provider.id))
      .set('Cookie', owner.ownerCookie)
      .expect(200);
    expect(summary.body.count).toBe(1);
    const list = await request(ctx.server)
      .get(panelUrl(owner.provider.id))
      .set('Cookie', owner.ownerCookie)
      .expect(200);
    expect(list.body.items[0]).toMatchObject({
      id: reported.review.id,
      comment: null,
      commentRemoved: true,
      myReport: { reason: 'CONTAINS_CONTACT_INFO', resolution: 'COMMENT_REMOVED' },
    });
    expect(JSON.stringify(list.body)).not.toMatch(/operatör notu|gizli/);

    const sent = ctx.notifications.ofTemplate('review-removed');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(reported.serviceRequest.customerEmail);
    expect(sent[0]!.data?.scopeLabel).toBe('Yorumunuz');
    expect(sent[0]!.data?.reasonLabel).toBe('İletişim bilgisi içeriyor');
    expect(JSON.stringify(sent[0]!.data)).not.toMatch(/operatör notu|gizli|0555 123|businessName/);
    expect(ctx.notifications.ofTemplate('review-report-new-for-support')).toHaveLength(0);
  });

  it('REMOVE_REVIEW drops the row from the aggregate and the provider list; the customer still sees it as removed with the fixed reason', async () => {
    const owner = await providerFixture();
    const admin = await adminSession();
    const kept = await review(owner, { rating: 5, comment: 'Harika.' });
    const doomed = await review(owner, { rating: 1, comment: 'Sahte gibi.' });
    await report(owner, doomed.review.id, { reason: 'SUSPECTED_FAKE' }).expect(201);
    ctx.notifications.clear();

    const decided = await request(ctx.server)
      .post(moderateUrl(doomed.review.id))
      .set('Cookie', admin.cookie)
      .send({ action: 'REMOVE_REVIEW', reason: 'SUSPECTED_FAKE' })
      .expect(201);
    expect(decided.body.removed).toBe(true);
    expect(decided.body.commentRemoved).toBe(false);
    expect(decided.body.reports[0].resolution).toBe('REVIEW_REMOVED');

    const summary = await request(ctx.server)
      .get(summaryUrl(owner.provider.id))
      .set('Cookie', owner.ownerCookie)
      .expect(200);
    expect(summary.body).toEqual({
      count: 1,
      average: 5,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 1 },
    });
    const list = await request(ctx.server)
      .get(panelUrl(owner.provider.id))
      .set('Cookie', owner.ownerCookie)
      .expect(200);
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([kept.review.id]);

    const customerCookie = await loginAs(ctx.prisma, doomed.customer.id);
    const mine = await request(ctx.server)
      .get(`/service-requests/${doomed.serviceRequest.id}/review`)
      .set('Cookie', customerCookie)
      .expect(200);
    expect(mine.body.eligibility).toBe('removed');
    expect(mine.body.review).toMatchObject({
      id: doomed.review.id,
      removed: true,
      removalReason: 'SUSPECTED_FAKE',
    });

    const sent = ctx.notifications.ofTemplate('review-removed');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(doomed.serviceRequest.customerEmail);
    expect(sent[0]!.data?.scopeLabel).toBe('Değerlendirmeniz');
    expect(sent[0]!.data?.reasonLabel).toBe('Gerçek bir deneyime dayanmıyor');
  });

  it('RESTORE clears both stamps without a mail; a repeated REMOVE_REVIEW after restore is a new removal with a new dedupe key', async () => {
    const owner = await providerFixture();
    const admin = await adminSession();
    const target = await review(owner, { rating: 3, comment: 'Şöyle böyle.' });

    await request(ctx.server)
      .post(moderateUrl(target.review.id))
      .set('Cookie', admin.cookie)
      .send({ action: 'REMOVE_COMMENT', reason: 'OTHER' })
      .expect(201);
    await request(ctx.server)
      .post(moderateUrl(target.review.id))
      .set('Cookie', admin.cookie)
      .send({ action: 'REMOVE_REVIEW', reason: 'OFFENSIVE' })
      .expect(201);
    expect(ctx.notifications.ofTemplate('review-removed')).toHaveLength(2);
    ctx.notifications.clear();

    const restored = await request(ctx.server)
      .post(moderateUrl(target.review.id))
      .set('Cookie', admin.cookie)
      .send({ action: 'RESTORE', note: 'yanlışlıkla' })
      .expect(201);
    expect(restored.body.removed).toBe(false);
    expect(restored.body.commentRemoved).toBe(false);
    expect(restored.body.comment).toBe('Şöyle böyle.');
    expect(restored.body.moderation.map((row: { action: string }) => row.action)).toEqual([
      'REMOVE_COMMENT',
      'REMOVE_REVIEW',
      'RESTORE',
    ]);
    expect(restored.body.moderation[2].reason).toBeNull();
    expect(ctx.notifications.ofTemplate('review-removed')).toHaveLength(0);

    const row = await ctx.prisma.providerReview.findUniqueOrThrow({ where: { id: target.review.id } });
    expect(row.removedAt).toBeNull();
    expect(row.commentRemovedAt).toBeNull();

    // The customer sees a live review again, with no reason attached.
    const customerCookie = await loginAs(ctx.prisma, target.customer.id);
    const mine = await request(ctx.server)
      .get(`/service-requests/${target.serviceRequest.id}/review`)
      .set('Cookie', customerCookie)
      .expect(200);
    expect(mine.body.eligibility).toBe('already-reviewed');
    expect(mine.body.review).toMatchObject({ removed: false, commentRemoved: false, removalReason: null });

    // Removed again: a second notice under a second key.
    await request(ctx.server)
      .post(moderateUrl(target.review.id))
      .set('Cookie', admin.cookie)
      .send({ action: 'REMOVE_REVIEW', reason: 'SUSPECTED_FAKE' })
      .expect(201);
    expect(ctx.notifications.ofTemplate('review-removed')).toHaveLength(1);
    const logs = await ctx.prisma.notificationLog.findMany({
      where: { template: 'review-removed' },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs).toHaveLength(3);
    expect(new Set(logs.map((log) => log.dedupeKey)).size).toBe(3);
    for (const log of logs) {
      expect(log.dedupeKey).toMatch(new RegExp(`^review-removed:${target.review.id}:`));
    }
  });

  it('moderating twice is 409 REVIEW_MODERATION_NOOP; REMOVE_* without reason is 400; dismiss with no open report is 409', async () => {
    const owner = await providerFixture();
    const admin = await adminSession();
    const target = await review(owner, { rating: 3, comment: 'Yorum.' });
    const bare = await review(owner, { rating: 4 });

    const noReason = await request(ctx.server)
      .post(moderateUrl(target.review.id))
      .set('Cookie', admin.cookie)
      .send({ action: 'REMOVE_COMMENT' });
    expect(noReason.status).toBe(400);
    expect(await ctx.prisma.providerReviewModeration.count()).toBe(0);

    // A review that is still live cannot be restored.
    const nothingToRestore = await request(ctx.server)
      .post(moderateUrl(target.review.id))
      .set('Cookie', admin.cookie)
      .send({ action: 'RESTORE' });
    expect(nothingToRestore.status).toBe(409);
    expect(nothingToRestore.body.code).toBe('REVIEW_MODERATION_NOOP');

    // A review with no comment has no comment to remove.
    const nothingToHide = await request(ctx.server)
      .post(moderateUrl(bare.review.id))
      .set('Cookie', admin.cookie)
      .send({ action: 'REMOVE_COMMENT', reason: 'OTHER' });
    expect(nothingToHide.status).toBe(409);
    expect(nothingToHide.body.code).toBe('REVIEW_MODERATION_NOOP');

    // Two operators on one review at the same instant: exactly one removal.
    const race = await Promise.all([
      request(ctx.server)
        .post(moderateUrl(target.review.id))
        .set('Cookie', admin.cookie)
        .send({ action: 'REMOVE_COMMENT', reason: 'OTHER' }),
      request(ctx.server)
        .post(moderateUrl(target.review.id))
        .set('Cookie', admin.cookie)
        .send({ action: 'REMOVE_COMMENT', reason: 'OFFENSIVE' }),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(race.find((r) => r.status === 409)!.body.code).toBe('REVIEW_MODERATION_NOOP');
    expect(await ctx.prisma.providerReviewModeration.count({ where: { reviewId: target.review.id } })).toBe(1);
    expect(ctx.notifications.ofTemplate('review-removed')).toHaveLength(1);

    const again = await request(ctx.server)
      .post(moderateUrl(target.review.id))
      .set('Cookie', admin.cookie)
      .send({ action: 'REMOVE_COMMENT', reason: 'OTHER' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('REVIEW_MODERATION_NOOP');

    // A comment already gone cannot be reported either.
    const late = await report(owner, target.review.id, { reason: 'OTHER' });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('REVIEW_NOT_REPORTABLE');

    const nothingOpen = await request(ctx.server)
      .post(dismissUrl(target.review.id))
      .set('Cookie', admin.cookie)
      .send({ resolutionNote: 'x' });
    expect(nothingOpen.status).toBe(409);
    expect(nothingOpen.body.code).toBe('NO_OPEN_REVIEW_REPORT');

    await request(ctx.server).get(adminUrl('missing-review')).set('Cookie', admin.cookie).expect(404);
    await request(ctx.server)
      .post(moderateUrl('missing-review'))
      .set('Cookie', admin.cookie)
      .send({ action: 'REMOVE_REVIEW', reason: 'OTHER' })
      .expect(404);

    // The provider's cookie opens none of the operator doors.
    await request(ctx.server).get(queueUrl).set('Cookie', owner.ownerCookie).expect(403);
    await request(ctx.server).get(adminUrl(target.review.id)).set('Cookie', owner.ownerCookie).expect(403);
    await request(ctx.server)
      .post(moderateUrl(target.review.id))
      .set('Cookie', owner.ownerCookie)
      .send({ action: 'RESTORE' })
      .expect(403);
  });

  it('the queue lists open reports oldest first with a cursor and shows the last decision under resolved', async () => {
    const owner = await providerFixture();
    const other = await providerFixture(owner.category.id);
    const admin = await adminSession();
    const first = await review(owner, { rating: 1, comment: 'A'.repeat(200) });
    const second = await review(other, { rating: 2, comment: 'İkinci yorum.' });
    const third = await review(owner, { rating: 3, comment: 'Üçüncü yorum.' });

    const base = Date.now();
    const rows = await Promise.all(
      [
        { fixture: owner, job: first, offset: 0 },
        { fixture: other, job: second, offset: 1 },
        { fixture: owner, job: third, offset: 2 },
      ].map(({ fixture, job, offset }) =>
        ctx.prisma.providerReviewReport.create({
          data: {
            reviewId: job.review.id,
            reporterProviderId: fixture.provider.id,
            reason: 'OTHER',
            note: 'gizli not',
            createdAt: new Date(base + offset * 1000),
          },
        }),
      ),
    );

    const pageOne = await request(ctx.server)
      .get(queueUrl)
      .query({ limit: 2 })
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(pageOne.body.items.map((item: { report: { id: string } }) => item.report.id)).toEqual([
      rows[0]!.id,
      rows[1]!.id,
    ]);
    expect(pageOne.body.nextCursor).toBe(rows[1]!.id);
    expect(pageOne.body.items[0]).toEqual({
      report: {
        id: rows[0]!.id,
        reason: 'OTHER',
        note: 'gizli not',
        createdAt: expect.any(String),
        resolvedAt: null,
        resolution: null,
      },
      review: {
        id: first.review.id,
        rating: 1,
        commentExcerpt: 'A'.repeat(160),
        commentRemoved: false,
        removed: false,
        createdAt: expect.any(String),
      },
      provider: { id: owner.provider.id, businessName: owner.provider.businessName },
      request: {
        id: first.serviceRequest.id,
        requestNumber: first.serviceRequest.requestNumber,
        categoryName: expect.any(String),
      },
      lastDecision: null,
    });

    const pageTwo = await request(ctx.server)
      .get(queueUrl)
      .query({ limit: 2, cursor: pageOne.body.nextCursor })
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(pageTwo.body.items.map((item: { report: { id: string } }) => item.report.id)).toEqual([rows[2]!.id]);
    expect(pageTwo.body.nextCursor).toBeNull();

    // One dismissed, one removed: both leave the open queue and appear under
    // resolved with their decision.
    const dismissed = await request(ctx.server)
      .post(dismissUrl(second.review.id))
      .set('Cookie', admin.cookie)
      .send({ resolutionNote: 'sorun yok' })
      .expect(201);
    expect(dismissed.body.reports[0]).toMatchObject({
      resolution: 'DISMISSED',
      resolutionNote: 'sorun yok',
      resolvedBy: { id: admin.admin.id },
    });
    expect(dismissed.body.removed).toBe(false);
    expect(dismissed.body.commentRemoved).toBe(false);
    await request(ctx.server)
      .post(moderateUrl(third.review.id))
      .set('Cookie', admin.cookie)
      .send({ action: 'REMOVE_COMMENT', reason: 'OFFENSIVE' })
      .expect(201);

    const open = await request(ctx.server).get(queueUrl).set('Cookie', admin.cookie).expect(200);
    expect(open.body.items.map((item: { report: { id: string } }) => item.report.id)).toEqual([rows[0]!.id]);

    const resolved = await request(ctx.server)
      .get(queueUrl)
      .query({ state: 'resolved' })
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(resolved.body.items.map((item: { report: { id: string } }) => item.report.id)).toEqual([
      rows[1]!.id,
      rows[2]!.id,
    ]);
    expect(resolved.body.items[0].report.resolution).toBe('DISMISSED');
    expect(resolved.body.items[0].lastDecision).toBeNull();
    expect(resolved.body.items[1].report.resolution).toBe('COMMENT_REMOVED');
    expect(resolved.body.items[1].review.commentRemoved).toBe(true);
    expect(resolved.body.items[1].lastDecision).toEqual({
      action: 'REMOVE_COMMENT',
      reason: 'OFFENSIVE',
      createdAt: expect.any(String),
    });

    // A decided report frees the review for a new one from the same provider.
    await report(owner, first.review.id, { reason: 'OTHER' }).expect(409);
    await request(ctx.server)
      .post(dismissUrl(first.review.id))
      .set('Cookie', admin.cookie)
      .send({})
      .expect(201);
    await report(owner, first.review.id, { reason: 'SUSPECTED_FAKE' }).expect(201);
    const detail = await request(ctx.server)
      .get(adminUrl(first.review.id))
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(detail.body.reports.map((row: { resolution: string | null }) => row.resolution)).toEqual([
      'DISMISSED',
      null,
    ]);
  });
});
