import {
  OfferStatus,
  ProviderReviewReportReason,
  ProviderStatus,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderReviewsService } from '../src/modules/provider-reviews/provider-reviews.service';
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

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

const MINUTE_MS = 60 * 1000;

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

/**
 * A COMPLETED request with its ACCEPTED offer, written straight into the
 * tables — the fixture the schema spec uses, minus the HTTP round trip.
 */
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
  data: {
    rating: number;
    comment?: string | null;
    createdAt?: Date;
    removedAt?: Date | null;
    commentRemovedAt?: Date | null;
  },
) {
  const job = await completedJob(fixture);
  return ctx.prisma.providerReview.create({
    data: {
      requestId: job.serviceRequest.id,
      offerId: job.offer.id,
      providerId: fixture.provider.id,
      customerUserId: job.customer.id,
      rating: data.rating,
      comment: data.comment ?? null,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      ...(data.removedAt ? { removedAt: data.removedAt } : {}),
      ...(data.commentRemovedAt ? { commentRemovedAt: data.commentRemovedAt } : {}),
    },
  });
}

const panelUrl = (providerId: string) => `/providers/${providerId}/reviews`;
const summaryUrl = (providerId: string) => `/providers/${providerId}/reviews/summary`;
const publicUrl = (providerId: string) => `/providers/${providerId}/reviews/public`;

/** The strings every fixture plants that must never reach a public body. */
const PII_PATTERN = /Müşteri |0555|@example\.test|TR-TEST|User /;

describe('provider review aggregate', () => {
  it('averages live rows only, to two decimals, with a distribution', async () => {
    const fixture = await providerFixture();
    await review(fixture, { rating: 5 });
    await review(fixture, { rating: 4 });
    await review(fixture, { rating: 3 });
    // A removed review keeps its row but leaves the aggregate.
    await review(fixture, { rating: 1, removedAt: new Date() });

    const summary = await request(ctx.server)
      .get(summaryUrl(fixture.provider.id))
      .set('Cookie', fixture.ownerCookie)
      .expect(200);
    expect(summary.body).toEqual({
      count: 3,
      average: 4,
      distribution: { '1': 0, '2': 0, '3': 1, '4': 1, '5': 1 },
    });

    await review(fixture, { rating: 5 });
    const rounded = await request(ctx.server)
      .get(summaryUrl(fixture.provider.id))
      .set('Cookie', fixture.ownerCookie)
      .expect(200);
    expect(rounded.body.count).toBe(4);
    expect(rounded.body.average).toBe(4.25);
  });

  it('summariesForProviders keys every requested id and never mixes providers', async () => {
    const first = await providerFixture();
    const second = await providerFixture(first.category.id);
    await review(first, { rating: 5 });
    await review(first, { rating: 2 });
    await review(second, { rating: 1 });

    const service = ctx.app.get(ProviderReviewsService);
    const summaries = await service.summariesForProviders([
      first.provider.id,
      second.provider.id,
      'missing-provider',
    ]);

    expect(summaries.get(first.provider.id)).toEqual({
      count: 2,
      average: 3.5,
      distribution: { '1': 0, '2': 1, '3': 0, '4': 0, '5': 1 },
    });
    expect(summaries.get(second.provider.id)).toEqual({
      count: 1,
      average: 1,
      distribution: { '1': 1, '2': 0, '3': 0, '4': 0, '5': 0 },
    });
    expect(summaries.get('missing-provider')).toEqual({
      count: 0,
      average: null,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    });
    expect(await service.summariesForProviders([])).toEqual(new Map());
  });

  it('public summary is null below three live reviews and appears at three', async () => {
    await setReviewsEnabled(true);
    const fixture = await providerFixture();
    await review(fixture, { rating: 5, comment: 'Harika iş.' });
    await review(fixture, { rating: 4, comment: 'İyi.' });

    const below = await request(ctx.server).get(publicUrl(fixture.provider.id)).expect(200);
    expect(below.body).toEqual({ summary: null, items: [], nextCursor: null });

    await review(fixture, { rating: 3, comment: 'Orta.' });

    const at = await request(ctx.server).get(publicUrl(fixture.provider.id)).expect(200);
    expect(at.body.summary).toEqual({ count: 3, average: 4 });
    expect(at.body.items).toHaveLength(3);
    expect(at.body.nextCursor).toBeNull();
  });

  it('publicSummariesForProviders applies the threshold per id and fails closed when the switch is off', async () => {
    await setReviewsEnabled(true);
    const rich = await providerFixture();
    const thin = await providerFixture(rich.category.id);
    for (const rating of [5, 5, 4]) await review(rich, { rating });
    await review(thin, { rating: 5 });
    await review(thin, { rating: 5 });

    const service = ctx.app.get(ProviderReviewsService);
    const on = await service.publicSummariesForProviders([rich.provider.id, thin.provider.id]);
    expect(on.get(rich.provider.id)).toEqual({ count: 3, average: 4.67 });
    expect(on.get(thin.provider.id)).toBeNull();

    await setReviewsEnabled(false);
    const off = await service.publicSummariesForProviders([rich.provider.id, thin.provider.id]);
    expect(off.get(rich.provider.id)).toBeNull();
    expect(off.get(thin.provider.id)).toBeNull();
    expect(off.size).toBe(2);

    // The provider's own summary is not gated by the switch.
    const own = await service.summariesForProviders([rich.provider.id]);
    expect(own.get(rich.provider.id)?.count).toBe(3);
  });

  it('REMOVE_COMMENT keeps the star, REMOVE_REVIEW drops it, RESTORE brings it back', async () => {
    await setReviewsEnabled(true);
    const fixture = await providerFixture();
    await review(fixture, { rating: 5, comment: 'Bir.' });
    await review(fixture, { rating: 4, comment: 'İki.' });
    const target = await review(fixture, { rating: 3, comment: 'Üç.' });

    const count = async () =>
      (await request(ctx.server).get(publicUrl(fixture.provider.id)).expect(200)).body as {
        summary: { count: number } | null;
        items: { id: string }[];
      };

    expect((await count()).summary?.count).toBe(3);

    // Moderation endpoints are Task 9; the row transitions are what matter here.
    await ctx.prisma.providerReview.update({
      where: { id: target.id },
      data: { commentRemovedAt: new Date() },
    });
    const commentRemoved = await count();
    expect(commentRemoved.summary?.count).toBe(3);
    expect(commentRemoved.items.map((item) => item.id)).not.toContain(target.id);

    await ctx.prisma.providerReview.update({
      where: { id: target.id },
      data: { removedAt: new Date() },
    });
    expect((await count()).summary).toBeNull();
    expect((await count()).items).toEqual([]);

    await ctx.prisma.providerReview.update({
      where: { id: target.id },
      data: { removedAt: null, commentRemovedAt: null },
    });
    const restored = await count();
    expect(restored.summary?.count).toBe(3);
    expect(restored.items.map((item) => item.id)).toContain(target.id);
  });

  it('public items carry only rating, comment, month and category — never a name, phone, e-mail or request number', async () => {
    await setReviewsEnabled(true);
    const fixture = await providerFixture();
    await review(fixture, { rating: 5, comment: 'Zamanında geldi.' });
    await review(fixture, { rating: 4, comment: 'Temiz çalıştı.' });
    await review(fixture, { rating: 3 });

    const body = (await request(ctx.server).get(publicUrl(fixture.provider.id)).expect(200)).body;
    expect(body.summary).toEqual({ count: 3, average: 4 });
    // The comment-less review counts but has nothing to list.
    expect(body.items).toHaveLength(2);
    expect(Object.keys(body.items[0]).sort()).toEqual([
      'categoryName',
      'comment',
      'id',
      'month',
      'rating',
    ]);
    expect(body.items[0].month).toMatch(/^\d{4}-\d{2}$/);
    expect(body.items[0].categoryName).toMatch(/^Klima /);
    expect(JSON.stringify(body)).not.toMatch(PII_PATTERN);
  });

  it('public list is 404 for a non-APPROVED provider and while the switch is off; provider panel still lists its own', async () => {
    await setReviewsEnabled(true);
    const fixture = await providerFixture();
    for (const rating of [5, 4, 3]) await review(fixture, { rating, comment: 'Yorum.' });

    await request(ctx.server).get(publicUrl(fixture.provider.id)).expect(200);
    await request(ctx.server).get(publicUrl('no-such-provider')).expect(404);

    await ctx.prisma.providerProfile.update({
      where: { id: fixture.provider.id },
      data: { status: ProviderStatus.SUSPENDED },
    });
    const suspended = await request(ctx.server).get(publicUrl(fixture.provider.id)).expect(404);
    expect(suspended.body.message).toBe('Provider not found');

    const panelWhileSuspended = await request(ctx.server)
      .get(panelUrl(fixture.provider.id))
      .set('Cookie', fixture.ownerCookie)
      .expect(200);
    expect(panelWhileSuspended.body.items).toHaveLength(3);

    await ctx.prisma.providerProfile.update({
      where: { id: fixture.provider.id },
      data: { status: ProviderStatus.APPROVED },
    });
    await request(ctx.server).get(publicUrl(fixture.provider.id)).expect(200);

    await setReviewsEnabled(false);
    const off = await request(ctx.server).get(publicUrl(fixture.provider.id)).expect(404);
    expect(off.body.message).toBe('Provider not found');

    const panelWhileOff = await request(ctx.server)
      .get(panelUrl(fixture.provider.id))
      .set('Cookie', fixture.ownerCookie)
      .expect(200);
    expect(panelWhileOff.body.summary.count).toBe(3);
    expect(panelWhileOff.body.items).toHaveLength(3);
  });

  it('provider panel list hides the removed review, marks commentRemoved, exposes myReport, and never carries the customer', async () => {
    const fixture = await providerFixture();
    const other = await providerFixture(fixture.category.id);
    const plain = await review(fixture, { rating: 5, comment: 'Açık yorum.' });
    const hidden = await review(fixture, {
      rating: 2,
      comment: 'Kaldırılan yorum.',
      commentRemovedAt: new Date(),
    });
    const removed = await review(fixture, {
      rating: 1,
      comment: 'Silinen.',
      removedAt: new Date(),
    });
    const reported = await review(fixture, { rating: 3, comment: 'Şikayet edilen.' });
    await ctx.prisma.providerReviewReport.create({
      data: {
        reviewId: reported.id,
        reporterProviderId: fixture.provider.id,
        reason: ProviderReviewReportReason.OFFENSIVE,
        note: 'Gizli not',
      },
    });
    // Another provider's report on the same review is not "my" report.
    await ctx.prisma.providerReviewReport.create({
      data: {
        reviewId: plain.id,
        reporterProviderId: other.provider.id,
        reason: ProviderReviewReportReason.OTHER,
        resolvedAt: new Date(),
        resolution: 'DISMISSED',
      },
    });

    const res = await request(ctx.server)
      .get(panelUrl(fixture.provider.id))
      .set('Cookie', fixture.ownerCookie)
      .expect(200);

    const body = res.body as {
      summary: { count: number };
      items: Array<Record<string, unknown> & { id: string }>;
      nextCursor: string | null;
    };
    expect(body.summary.count).toBe(3);
    expect(body.nextCursor).toBeNull();
    const ids = body.items.map((item) => item.id);
    expect(ids).not.toContain(removed.id);
    expect(ids).toHaveLength(3);

    const byId = new Map(body.items.map((item) => [item.id, item]));
    expect(Object.keys(byId.get(plain.id)!).sort()).toEqual([
      'comment',
      'commentRemoved',
      'createdAt',
      'id',
      'myReport',
      'rating',
      'request',
    ]);
    expect(byId.get(plain.id)).toMatchObject({
      rating: 5,
      comment: 'Açık yorum.',
      commentRemoved: false,
      myReport: null,
    });
    expect(byId.get(plain.id)!.request).toEqual({
      id: expect.any(String),
      requestNumber: expect.stringMatching(/^TR-TEST-/),
      categoryName: expect.stringMatching(/^Klima /),
    });
    expect(byId.get(hidden.id)).toMatchObject({ comment: null, commentRemoved: true });
    expect(byId.get(reported.id)!.myReport).toEqual({
      reason: 'OFFENSIVE',
      createdAt: expect.any(String),
      resolution: null,
    });

    const text = JSON.stringify(body);
    expect(text).not.toMatch(/Müşteri |0555|@example\.test|User |Gizli not|customer/i);

    // The owner alone (or a SUPER_ADMIN) may look at the panel.
    await request(ctx.server)
      .get(panelUrl(fixture.provider.id))
      .set('Cookie', other.ownerCookie)
      .expect(403);
    await request(ctx.server).get(panelUrl(fixture.provider.id)).expect(401);
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await request(ctx.server)
      .get(summaryUrl(fixture.provider.id))
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(200);
  });

  it('cursor pagination walks the provider list in createdAt desc, id desc order', async () => {
    const fixture = await providerFixture();
    const base = Date.now() - 60 * MINUTE_MS;
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const row = await review(fixture, {
        rating: 5,
        comment: `Yorum ${i}`,
        createdAt: new Date(base + i * MINUTE_MS),
      });
      created.push(row.id);
    }
    const expected = [...created].reverse();

    const first = await request(ctx.server)
      .get(panelUrl(fixture.provider.id))
      .query({ limit: 2 })
      .set('Cookie', fixture.ownerCookie)
      .expect(200);
    expect(first.body.items.map((item: { id: string }) => item.id)).toEqual(expected.slice(0, 2));
    expect(first.body.nextCursor).toBe(expected[1]);

    const second = await request(ctx.server)
      .get(panelUrl(fixture.provider.id))
      .query({ limit: 2, cursor: first.body.nextCursor })
      .set('Cookie', fixture.ownerCookie)
      .expect(200);
    expect(second.body.items.map((item: { id: string }) => item.id)).toEqual(expected.slice(2, 4));
    expect(second.body.nextCursor).toBe(expected[3]);

    const third = await request(ctx.server)
      .get(panelUrl(fixture.provider.id))
      .query({ limit: 2, cursor: second.body.nextCursor })
      .set('Cookie', fixture.ownerCookie)
      .expect(200);
    expect(third.body.items.map((item: { id: string }) => item.id)).toEqual(expected.slice(4));
    expect(third.body.nextCursor).toBeNull();

    // An unusable limit falls back to the default; the public list caps at its own maximum.
    const fallback = await request(ctx.server)
      .get(panelUrl(fixture.provider.id))
      .query({ limit: 'abc' })
      .set('Cookie', fixture.ownerCookie)
      .expect(200);
    expect(fallback.body.items).toHaveLength(5);
  });

  it('public cursor pagination walks the same order and stops', async () => {
    await setReviewsEnabled(true);
    const fixture = await providerFixture();
    const base = Date.now() - 60 * MINUTE_MS;
    const created: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const row = await review(fixture, {
        rating: 4,
        comment: `Yorum ${i}`,
        createdAt: new Date(base + i * MINUTE_MS),
      });
      created.push(row.id);
    }
    const expected = [...created].reverse();

    const first = await request(ctx.server)
      .get(publicUrl(fixture.provider.id))
      .query({ limit: 2 })
      .expect(200);
    expect(first.body.items.map((item: { id: string }) => item.id)).toEqual(expected.slice(0, 2));
    expect(first.body.nextCursor).toBe(expected[1]);

    const second = await request(ctx.server)
      .get(publicUrl(fixture.provider.id))
      .query({ limit: 2, cursor: first.body.nextCursor })
      .expect(200);
    expect(second.body.items.map((item: { id: string }) => item.id)).toEqual(expected.slice(2));
    expect(second.body.nextCursor).toBeNull();
    expect(second.body.summary).toEqual({ count: 3, average: 4 });
  });
});
