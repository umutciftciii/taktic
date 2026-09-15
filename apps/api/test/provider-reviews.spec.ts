import { OfferStatus, ProviderStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeComment } from '../src/modules/provider-reviews/provider-review-comment';
import {
  toPublicSummary,
  toReviewSummary,
} from '../src/modules/provider-reviews/provider-review-aggregate';
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

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

const DAY_MS = 24 * 60 * 60 * 1000;

const reviewUrl = (id: string) => `/service-requests/${id}/review`;

async function setReviewsEnabled(enabled: boolean) {
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48, providerReviewsEnabled: enabled },
    update: { providerReviewsEnabled: enabled },
  });
}

async function enableReviews() {
  await setReviewsEnabled(true);
}

/**
 * A MATCHED request reached the real way: an approved request owned by a
 * signed-in customer, a provider's offer bought with credits through the
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
  const providerCookie = await loginAs(ctx.prisma, ownerUser.id);
  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
    .set('Cookie', providerCookie)
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

  return {
    category,
    customer,
    customerCookie,
    provider,
    providerCookie,
    serviceRequest,
    winner: { offerId, provider },
  };
}

async function completeAs(cookie: string, requestId: string) {
  await request(ctx.server)
    .post(`/service-requests/${requestId}/complete`)
    .set('Cookie', cookie)
    .expect(201);
}

async function completedRequest() {
  const fixture = await matchedRequest();
  await completeAs(fixture.customerCookie, fixture.serviceRequest.id);
  return fixture;
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

describe('normalizeComment', () => {
  it('trims, collapses blanks, drops control characters, caps blank lines and returns null for empty', () => {
    expect(normalizeComment(undefined)).toBeNull();
    expect(normalizeComment(null)).toBeNull();
    expect(normalizeComment('   ')).toBeNull();
    expect(normalizeComment('\u0000\u0007 \t ')).toBeNull();
    expect(normalizeComment('  Çok  memnun \t kaldım.  ')).toBe('Çok memnun kaldım.');
    expect(normalizeComment('a\r\nb')).toBe('a\nb');
    expect(normalizeComment('a\n\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeComment('x\u0007y\u007Fz')).toBe('xyz');
  });

  it('normalises every line ending to LF — a lone CR is a line break, never deleted', () => {
    expect(normalizeComment('a\rb')).toBe('a\nb');
    expect(normalizeComment('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    // CR-only blank lines are capped like LF ones, and a tab is still one space.
    expect(normalizeComment('a\r\r\r\rb')).toBe('a\n\nb');
    expect(normalizeComment('a\r\n\r\n\r\nb')).toBe('a\n\nb');
    expect(normalizeComment('a\t\tb')).toBe('a b');
    // The other C0 controls and DEL go; the letters around them touch.
    expect(normalizeComment('a\u0000b\u0008c\u000Bd\u000Ce\u000Ef\u001Fg\u007Fh')).toBe('abcdefgh');
  });
});

describe('toReviewSummary / toPublicSummary', () => {
  it('aggregates counts, a two-decimal average and a full distribution', () => {
    expect(toReviewSummary([])).toEqual({
      count: 0,
      average: null,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    });
    const summary = toReviewSummary([
      { rating: 5, count: 2 },
      { rating: 4, count: 1 },
    ]);
    expect(summary).toEqual({
      count: 3,
      average: 4.67,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 2 },
    });
  });

  it('hides the public summary below the minimum count', () => {
    expect(toPublicSummary(toReviewSummary([]))).toBeNull();
    expect(toPublicSummary(toReviewSummary([{ rating: 5, count: 1 }]))).toBeNull();
    const enough = toReviewSummary([{ rating: 3, count: 3 }]);
    expect(toPublicSummary(enough)).toEqual({ count: 3, average: 3 });
  });
});

describe('POST /service-requests/:id/review', () => {
  it('the owner rates the matched provider once after COMPLETED; provider is derived from the accepted offer', async () => {
    await enableReviews();
    const { customerCookie, serviceRequest, winner } = await matchedRequest();
    await completeAs(customerCookie, serviceRequest.id);

    const res = await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      // Ids in the body are ignored: the provider comes from the accepted offer.
      .send({ rating: 5, comment: '  Çok  memnun kaldım.  ' })
      .expect(201);

    expect(res.body.eligibility).toBe('already-reviewed');
    expect(res.body.provider).toEqual({ id: winner.provider.id, businessName: winner.provider.businessName });
    expect(res.body.review).toMatchObject({
      rating: 5,
      comment: 'Çok memnun kaldım.',
      commentRemoved: false,
      removed: false,
      removalReason: null,
    });
    expect(typeof res.body.windowEndsAt).toBe('string');
    // Nothing beyond the customer's own review leaks: no ids of other people.
    expect(Object.keys(res.body).sort()).toEqual(['eligibility', 'provider', 'review', 'windowEndsAt']);
    expect(Object.keys(res.body.review).sort()).toEqual(
      ['comment', 'commentRemoved', 'createdAt', 'id', 'rating', 'removalReason', 'removed'],
    );

    const stored = await ctx.prisma.providerReview.findUniqueOrThrow({
      where: { offerId: winner.offerId },
    });
    expect(stored.providerId).toBe(winner.provider.id);
    expect(stored.requestId).toBe(serviceRequest.id);
    expect(stored.comment).toBe('Çok memnun kaldım.');

    const dup = await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ rating: 1 })
      .expect(409);
    expect(dup.body.code).toBe('REVIEW_ALREADY_EXISTS');
    expect(await ctx.prisma.providerReview.count()).toBe(1);
  });

  it('refuses while MATCHED (409 REQUEST_NOT_COMPLETED), CANCELLED, and for a request that is not mine (403)', async () => {
    await enableReviews();
    const { customerCookie, serviceRequest } = await matchedRequest();

    const matched = await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ rating: 5 })
      .expect(409);
    expect(matched.body.code).toBe('REQUEST_NOT_COMPLETED');

    const state = await request(ctx.server)
      .get(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .expect(200);
    expect(state.body).toMatchObject({ eligibility: 'not-completed', windowEndsAt: null, review: null });

    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { status: ServiceRequestStatus.CANCELLED },
    });
    const cancelled = await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ rating: 5 })
      .expect(409);
    expect(cancelled.body.code).toBe('REQUEST_NOT_COMPLETED');

    const other = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const otherCookie = await loginAs(ctx.prisma, other.id);
    await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', otherCookie)
      .send({ rating: 5 })
      .expect(403);
    await request(ctx.server).get(reviewUrl(serviceRequest.id)).set('Cookie', otherCookie).expect(403);

    await request(ctx.server)
      .post(reviewUrl('does-not-exist'))
      .set('Cookie', customerCookie)
      .send({ rating: 5 })
      .expect(404);

    expect(await ctx.prisma.providerReview.count()).toBe(0);
  });

  it('refuses a provider, a super admin and an anonymous caller (403/401)', async () => {
    await enableReviews();
    const { providerCookie, serviceRequest } = await completedRequest();

    await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', providerCookie)
      .send({ rating: 5 })
      .expect(403);
    await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', await adminCookie())
      .send({ rating: 5 })
      .expect(403);
    await request(ctx.server).post(reviewUrl(serviceRequest.id)).send({ rating: 5 }).expect(401);

    // Reading is different: a provider is refused, an admin may look.
    await request(ctx.server).get(reviewUrl(serviceRequest.id)).set('Cookie', providerCookie).expect(403);
    const admin = await request(ctx.server)
      .get(reviewUrl(serviceRequest.id))
      .set('Cookie', await adminCookie())
      .expect(200);
    expect(admin.body.eligibility).toBe('ok');
    await request(ctx.server).get(reviewUrl(serviceRequest.id)).expect(401);

    expect(await ctx.prisma.providerReview.count()).toBe(0);
  });

  it('refuses after 90 days (409 REVIEW_WINDOW_CLOSED) and reports window-closed eligibility', async () => {
    await enableReviews();
    const { customerCookie, serviceRequest } = await completedRequest();
    const completedAt = new Date(Date.now() - 91 * DAY_MS);
    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { completedAt },
    });

    const res = await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ rating: 5 })
      .expect(409);
    expect(res.body.code).toBe('REVIEW_WINDOW_CLOSED');

    const state = await request(ctx.server)
      .get(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .expect(200);
    expect(state.body.eligibility).toBe('window-closed');
    expect(state.body.windowEndsAt).toBe(new Date(completedAt.getTime() + 90 * DAY_MS).toISOString());
    expect(state.body.review).toBeNull();
  });

  it('refuses rating 0, 6, 2.5, a 601-code-unit comment, and a comment with a phone number (400 CONTACT_DETAILS_IN_TEXT field=comment)', async () => {
    await enableReviews();
    const { customerCookie, serviceRequest } = await completedRequest();
    const post = (body: Record<string, unknown>) =>
      request(ctx.server).post(reviewUrl(serviceRequest.id)).set('Cookie', customerCookie).send(body);

    await post({ rating: 0 }).expect(400);
    await post({ rating: 6 }).expect(400);
    await post({ rating: 2.5 }).expect(400);
    await post({ rating: '5' }).expect(400);
    await post({}).expect(400);
    await post({ rating: 5, comment: 'a'.repeat(601) }).expect(400);
    // 600 emoji are 600 code points but 1200 code units: over the line.
    await post({ rating: 5, comment: '😀'.repeat(301) }).expect(400);
    // Unknown fields are refused by the global pipe — no id can be smuggled in.
    await post({ rating: 5, providerId: 'x' }).expect(400);

    const contact = await post({ rating: 5, comment: 'Beni arayın 0555 123 45 67' }).expect(400);
    expect(contact.body).toMatchObject({ code: 'CONTACT_DETAILS_IN_TEXT', field: 'comment' });
    expect(typeof contact.body.kind).toBe('string');

    expect(await ctx.prisma.providerReview.count()).toBe(0);

    // The boundary itself is accepted.
    await post({ rating: 5, comment: 'b'.repeat(600) }).expect(201);
  });

  it('stores a multi-line comment with LF endings, runs the contact filter on the normalised text, and keeps markup as literal text', async () => {
    await enableReviews();
    const { customerCookie, serviceRequest, winner } = await completedRequest();
    const post = (body: Record<string, unknown>) =>
      request(ctx.server).post(reviewUrl(serviceRequest.id)).set('Cookie', customerCookie).send(body);

    // A phone number that only reads as one once the CR is a line break is
    // still a phone number: the filter sees what will be stored.
    const hidden = await post({ rating: 5, comment: 'Ara:\r0532 123 45 67' }).expect(400);
    expect(hidden.body).toMatchObject({ code: 'CONTACT_DETAILS_IN_TEXT', field: 'comment' });
    expect(await ctx.prisma.providerReview.count()).toBe(0);

    const raw = 'Birinci satır.\r\nİkinci satır.\rÜçüncü <script>alert(1)</script> satır.';
    const expected = 'Birinci satır.\nİkinci satır.\nÜçüncü <script>alert(1)</script> satır.';
    expect(normalizeComment(raw)).toBe(expected);
    const created = await post({ rating: 5, comment: raw }).expect(201);
    expect(created.body.review.comment).toBe(expected);

    const stored = await ctx.prisma.providerReview.findUniqueOrThrow({ where: { offerId: winner.offerId } });
    expect(stored.comment).toBe(expected);
    expect(stored.comment).toContain('\n');
    expect(stored.comment).not.toContain('\r');

    // The API renders no HTML: the tag goes out exactly as it came in — as
    // text, neither stripped nor escaped. Escaping is the screen's job.
    const state = await request(ctx.server)
      .get(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .expect(200);
    expect(state.body.review.comment).toBe(expected);
    expect(state.body.review.comment).toContain('<script>alert(1)</script>');
  });

  it('is 404 REVIEWS_DISABLED while the switch is off and GET reports disabled', async () => {
    await setReviewsEnabled(false);
    const { customerCookie, serviceRequest } = await completedRequest();

    const res = await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ rating: 5 })
      .expect(404);
    expect(res.body.code).toBe('REVIEWS_DISABLED');

    const state = await request(ctx.server)
      .get(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .expect(200);
    expect(state.body).toMatchObject({ eligibility: 'disabled', review: null });

    // No settings row at all reads as off as well.
    await ctx.prisma.operationsSettings.deleteMany();
    const missing = await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ rating: 5 })
      .expect(404);
    expect(missing.body.code).toBe('REVIEWS_DISABLED');
    expect(await ctx.prisma.providerReview.count()).toBe(0);
  });

  it('ten parallel submissions leave exactly one row', async () => {
    await enableReviews();
    const { customerCookie, serviceRequest } = await completedRequest();

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        request(ctx.server).post(reviewUrl(serviceRequest.id)).set('Cookie', customerCookie).send({ rating: 4 }),
      ),
    );
    const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 500));
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.status === 409) {
        expect(result.value.body.code).toBe('REVIEW_ALREADY_EXISTS');
      }
    }
    expect(await ctx.prisma.providerReview.count()).toBe(1);
    expect(ctx.notifications.ofTemplate('review-received')).toHaveLength(1);
  });

  it('sends review-received to the provider after the commit', async () => {
    await enableReviews();
    const { customerCookie, serviceRequest, winner } = await completedRequest();

    await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ rating: 3, comment: 'İdare eder.' })
      .expect(201);

    const sent = ctx.notifications.ofTemplate('review-received');
    expect(sent).toHaveLength(1);
    const stored = await ctx.prisma.providerReview.findUniqueOrThrow({ where: { offerId: winner.offerId } });
    const logs = await ctx.prisma.notificationLog.findMany({ where: { template: 'review-received' } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.dedupeKey).toBe(`review-received:${stored.id}`);
    expect(logs[0]!.providerId).toBe(winner.provider.id);
  });

  it('GET eligibility for a SUSPENDED provider is still ok and creation succeeds', async () => {
    await enableReviews();
    const { customerCookie, serviceRequest, winner } = await completedRequest();
    await ctx.prisma.providerProfile.update({
      where: { id: winner.provider.id },
      data: { status: ProviderStatus.SUSPENDED },
    });

    const state = await request(ctx.server)
      .get(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .expect(200);
    expect(state.body).toMatchObject({
      eligibility: 'ok',
      review: null,
      provider: { id: winner.provider.id, businessName: winner.provider.businessName },
    });

    const res = await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ rating: 2 })
      .expect(201);
    expect(res.body.review.rating).toBe(2);
  });

  it('GET reports removed, with the reason of the latest removal, once an operator removed the review', async () => {
    await enableReviews();
    const { customer, customerCookie, serviceRequest, winner } = await completedRequest();
    await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ rating: 1, comment: 'Kötü.' })
      .expect(201);
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const stored = await ctx.prisma.providerReview.findUniqueOrThrow({ where: { offerId: winner.offerId } });
    await ctx.prisma.providerReview.update({
      where: { id: stored.id },
      data: {
        removedAt: new Date(),
        moderation: {
          create: { action: 'REMOVE_REVIEW', reason: 'OFFENSIVE', performedById: admin.id },
        },
      },
    });

    const state = await request(ctx.server)
      .get(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .expect(200);
    expect(state.body.eligibility).toBe('removed');
    expect(state.body.review).toMatchObject({ rating: 1, comment: 'Kötü.', removed: true, removalReason: 'OFFENSIVE' });
    expect(state.body.review.commentRemoved).toBe(false);
    expect(customer.id).toBe(stored.customerUserId);

    // A removed review still blocks a second one: the unique pair holds.
    const again = await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ rating: 5 })
      .expect(409);
    expect(again.body.code).toBe('REVIEW_ALREADY_EXISTS');
  });

  it('GET hides a removed comment from the customer while keeping the stars', async () => {
    await enableReviews();
    const { customerCookie, serviceRequest, winner } = await completedRequest();
    await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ rating: 4, comment: 'Yorum.' })
      .expect(201);
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await ctx.prisma.providerReview.update({
      where: { offerId: winner.offerId },
      data: {
        commentRemovedAt: new Date(),
        moderation: {
          create: { action: 'REMOVE_COMMENT', reason: 'CONTAINS_CONTACT_INFO', performedById: admin.id },
        },
      },
    });

    const state = await request(ctx.server)
      .get(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .expect(200);
    expect(state.body.eligibility).toBe('already-reviewed');
    expect(state.body.review).toMatchObject({
      rating: 4,
      comment: null,
      commentRemoved: true,
      removed: false,
      removalReason: 'CONTAINS_CONTACT_INFO',
    });
  });

  it('leaves the credit ledger and entitlements untouched', async () => {
    await enableReviews();
    const { customerCookie, serviceRequest, winner } = await completedRequest();
    const ledgerBefore = await ctx.prisma.providerCreditTransaction.count();
    const offerBefore = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: winner.offerId } });

    await request(ctx.server)
      .post(reviewUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .send({ rating: 5 })
      .expect(201);

    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(ledgerBefore);
    const offerAfter = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: winner.offerId } });
    expect(offerAfter).toEqual(offerBefore);
    expect(offerAfter.status).toBe(OfferStatus.ACCEPTED);
    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: serviceRequest.id } });
    expect(stored.status).toBe(ServiceRequestStatus.COMPLETED);
  });
});
