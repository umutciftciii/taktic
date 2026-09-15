import {
  OfferStatus,
  ProviderStatus,
  ServiceCategoryKind,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * Where a provider's rating is *shown*, as opposed to where it is computed.
 *
 * Four projections carry it: the customer's offer previews and offer detail,
 * the vitrin feed and the public card, the provider's own dashboard, and the
 * customer's request list (their own review, not the aggregate). Everything
 * else about those projections — their keys, their order, their prices — is
 * asserted unchanged, because a rating that quietly re-sorted a shelf a
 * business paid for would be a product change disguised as a display one.
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
async function providerFixture(categoryId: string) {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    categoryId,
    userId: owner.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const ownerCookie = await loginAs(ctx.prisma, owner.id);
  return { category: { id: categoryId }, owner, ownerCookie, provider };
}

/**
 * A COMPLETED request with its ACCEPTED offer, written straight into the
 * tables — the fixture the aggregate spec uses.
 */
async function completedJob(fixture: ProviderFixture, customerId?: string) {
  const customer = customerId
    ? { id: customerId }
    : await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
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
  data: { rating: number; comment?: string | null; removedAt?: Date | null },
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
      ...(data.removedAt ? { removedAt: data.removedAt } : {}),
    },
  });
  return { ...job, review: row };
}

/** Three live reviews — the public threshold — all at `rating`. */
async function threeReviews(fixture: ProviderFixture, rating: number, comment = 'Yorum metni.') {
  for (let index = 0; index < 3; index += 1) {
    await review(fixture, { rating, comment });
  }
}

/** A live vitrin placement for the fixture's provider; `paidAt` fixes its slot. */
async function placeCard(fixture: ProviderFixture, paidAt: Date, title: string) {
  const pkg = await createShowcasePackage(ctx.prisma);
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
    providerId: fixture.provider.id,
    categoryId: fixture.category.id,
    title,
    areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    listedServicePriceAmount: 150_000,
  });
  await createLiveShowcasePlacement(ctx, {
    providerId: fixture.provider.id,
    cardId: card.id,
    versionId: version.id,
    packageId: pkg.id,
    paidAt,
  });
  return card;
}

async function customerSession() {
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  return { customer, cookie: await loginAs(ctx.prisma, customer.id) };
}

/** A pending offer from the fixture's provider on `requestId`, `submittedAt` fixed. */
async function pendingOffer(fixture: ProviderFixture, requestId: string, submittedAt: Date) {
  return ctx.prisma.offer.create({
    data: {
      requestId,
      providerId: fixture.provider.id,
      status: OfferStatus.SUBMITTED,
      priceAmount: 2500,
      message: 'Teklif',
      submittedAt,
    },
  });
}

const offersUrl = (requestId: string) => `/service-requests/${requestId}/offers`;
const offerUrl = (requestId: string, offerId: string) =>
  `/service-requests/${requestId}/offers/${offerId}`;
const feedUrl = '/showcase/feed';
const cardUrl = (cardId: string) => `/showcase/cards/${cardId}`;
const dashboardUrl = '/providers/me/dashboard';
const panelSummaryUrl = (providerId: string) => `/providers/${providerId}/reviews/summary`;
const myRequestsUrl = '/service-requests/my';

/** The strings every fixture plants that must never reach a public body. */
const REVIEW_BODY_PATTERN = /Yorum metni|Müşteri |0555|@example\.test|TR-TEST/;

/** The customer offer preview's keys before this change. */
const OFFER_PREVIEW_KEYS = [
  'id',
  'offerNumber',
  'provider',
  'status',
  'priceAmount',
  'currency',
  'estimatedStartDate',
  'estimatedCompletionDate',
  'message',
  'warrantyNote',
  'creditCost',
  'creditRefundedAt',
  'submittedAt',
];

/** A SERVICE feed card's keys before this change. */
const FEED_CARD_KEYS = [
  'cardId',
  'kind',
  'title',
  'summary',
  'scopeIncluded',
  'scopeExcluded',
  'imageUrl',
  'responseSlaUrgentHours',
  'responseSlaNormalHours',
  'category',
  'areaLabel',
  'areaScope',
  'areas',
  'priceTerms',
  'provider',
  'listedServicePriceAmount',
  'listedServiceCurrency',
];

const sortedKeys = (value: object) => Object.keys(value).sort();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Rows keyed by `key`, with a throw rather than an `undefined` on a miss. */
function indexBy(rows: Row[], key: string) {
  const map = new Map<string, Row>(rows.map((row) => [row[key] as string, row]));
  return (id: string): Row => {
    const row = map.get(id);
    if (!row) throw new Error(`No row with ${key}=${id}`);
    return row;
  };
}

describe('offer previews', () => {
  it('carry the provider id and a public summary (null under three)', async () => {
    await setReviewsEnabled(true);
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 });
    const rated = await providerFixture(category.id);
    const unrated = await providerFixture(category.id);
    await threeReviews(rated, 5);
    await review(unrated, { rating: 1 });
    await review(unrated, { rating: 1 });

    const { customer, cookie } = await customerSession();
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
    });
    const ratedOffer = await pendingOffer(rated, serviceRequest.id, new Date(Date.now() - 60_000));
    const unratedOffer = await pendingOffer(unrated, serviceRequest.id, new Date());

    const response = await request(ctx.server)
      .get(offersUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body).toHaveLength(2);
    const byId = indexBy(response.body, 'id');
    expect(byId(ratedOffer.id).provider).toEqual({
      id: rated.provider.id,
      businessName: rated.provider.businessName,
      city: rated.provider.city,
      district: rated.provider.district,
      reviewSummary: { count: 3, average: 5 },
    });
    expect(byId(unratedOffer.id).provider).toEqual({
      id: unrated.provider.id,
      businessName: unrated.provider.businessName,
      city: unrated.provider.city,
      district: unrated.provider.district,
      reviewSummary: null,
    });

    // The offer detail is the same customer looking at one of the same cards,
    // and must say the same thing about the provider.
    const detail = await request(ctx.server)
      .get(offerUrl(serviceRequest.id, ratedOffer.id))
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.provider).toEqual(byId(ratedOffer.id).provider);

    // Switch off: null for everybody, the id stays.
    await setReviewsEnabled(false);
    const off = await request(ctx.server)
      .get(offersUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .expect(200);
    for (const offer of off.body) {
      expect(offer.provider.reviewSummary).toBeNull();
      expect(typeof offer.provider.id).toBe('string');
    }
    const offDetail = await request(ctx.server)
      .get(offerUrl(serviceRequest.id, ratedOffer.id))
      .set('Cookie', cookie)
      .expect(200);
    expect(offDetail.body.provider.reviewSummary).toBeNull();
  });
});

describe('public summaries and provider visibility', () => {
  it('a provider the public list would 404 for has no summary on the offer preview or detail, while the panel keeps the exact count', async () => {
    await setReviewsEnabled(true);
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 });
    const fixture = await providerFixture(category.id);
    await threeReviews(fixture, 5);

    const { customer, cookie } = await customerSession();
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
    });
    const offer = await pendingOffer(fixture, serviceRequest.id, new Date());

    // APPROVED: the same summary on both customer surfaces.
    const approved = await request(ctx.server)
      .get(offersUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .expect(200);
    expect(approved.body).toHaveLength(1);
    expect(approved.body[0].provider.reviewSummary).toEqual({ count: 3, average: 5 });
    const approvedDetail = await request(ctx.server)
      .get(offerUrl(serviceRequest.id, offer.id))
      .set('Cookie', cookie)
      .expect(200);
    expect(approvedDetail.body.provider.reviewSummary).toEqual({ count: 3, average: 5 });

    // SUSPENDED: the public list answers "Provider not found", so the offer
    // card must not carry a rating for the same provider. The offer itself
    // is still shown — the card's other fields are not this feature's to
    // change.
    await ctx.prisma.providerProfile.update({
      where: { id: fixture.provider.id },
      data: { status: ProviderStatus.SUSPENDED },
    });
    const suspended = await request(ctx.server)
      .get(offersUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .expect(200);
    expect(suspended.body).toHaveLength(1);
    expect(suspended.body[0].provider).toEqual({
      id: fixture.provider.id,
      businessName: fixture.provider.businessName,
      city: fixture.provider.city,
      district: fixture.provider.district,
      reviewSummary: null,
    });
    const suspendedDetail = await request(ctx.server)
      .get(offerUrl(serviceRequest.id, offer.id))
      .set('Cookie', cookie)
      .expect(200);
    expect(suspendedDetail.body.provider.reviewSummary).toBeNull();
    expect(suspendedDetail.body.provider.id).toBe(fixture.provider.id);

    // The provider's own panel is not a public surface: the numbers stay.
    const panel = await request(ctx.server)
      .get(panelSummaryUrl(fixture.provider.id))
      .set('Cookie', fixture.ownerCookie)
      .expect(200);
    expect(panel.body).toEqual({
      count: 3,
      average: 5,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 3 },
    });
  });
});

describe('the vitrin feed and the public card', () => {
  it('carry provider.reviewSummary, and never a review body', async () => {
    await setReviewsEnabled(true);
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    const rated = await providerFixture(category.id);
    const unrated = await providerFixture(category.id);
    await threeReviews(rated, 4);
    await review(unrated, { rating: 5, comment: 'Yorum metni.' });

    const ratedCard = await placeCard(rated, new Date(Date.now() - 120_000), 'Puanlı');
    const unratedCard = await placeCard(unrated, new Date(Date.now() - 60_000), 'Puansız');

    const feed = await request(ctx.server).get(feedUrl).expect(200);
    const cards = indexBy(feed.body.cards, 'cardId');
    expect(cards(ratedCard.id).provider).toEqual({
      id: rated.provider.id,
      businessName: rated.provider.businessName,
      city: rated.provider.city,
      district: rated.provider.district,
      reviewSummary: { count: 3, average: 4 },
    });
    expect(cards(unratedCard.id).provider.reviewSummary).toBeNull();
    expect(JSON.stringify(feed.body)).not.toMatch(REVIEW_BODY_PATTERN);

    const card = await request(ctx.server).get(cardUrl(ratedCard.id)).expect(200);
    expect(card.body.provider).toEqual(cards(ratedCard.id).provider);
    expect(JSON.stringify(card.body)).not.toMatch(REVIEW_BODY_PATTERN);

    // Switch off: null everywhere public, nothing else changes.
    await setReviewsEnabled(false);
    const offFeed = await request(ctx.server).get(feedUrl).expect(200);
    for (const entry of offFeed.body.cards) {
      expect(entry.provider.reviewSummary).toBeNull();
    }
    const offCard = await request(ctx.server).get(cardUrl(ratedCard.id)).expect(200);
    expect(offCard.body.provider.reviewSummary).toBeNull();
    expect(offCard.body.provider.id).toBe(rated.provider.id);
  });
});

describe('the provider dashboard', () => {
  it('carries the exact summary even with one review, switch on or off', async () => {
    await setReviewsEnabled(false);
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 });
    const fixture = await providerFixture(category.id);
    await review(fixture, { rating: 4 });
    // Removed rows leave the aggregate on the provider's own screen too.
    await review(fixture, { rating: 1, removedAt: new Date() });

    const response = await request(ctx.server)
      .get(dashboardUrl)
      .set('Cookie', fixture.ownerCookie)
      .expect(200);

    expect(response.body.reviewSummary).toEqual({
      count: 1,
      average: 4,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 0 },
    });
    // The existing figures are still there.
    expect(response.body.provider.id).toBe(fixture.provider.id);
    expect(response.body).toMatchObject({
      creditBalance: 0,
      activeOffersCount: 0,
      recentOffersCount: 2,
    });

    await setReviewsEnabled(true);
    const on = await request(ctx.server)
      .get(dashboardUrl)
      .set('Cookie', fixture.ownerCookie)
      .expect(200);
    expect(on.body.reviewSummary).toEqual(response.body.reviewSummary);
  });
});

describe('the customer list', () => {
  it('carries review { id, rating, removedAt } per request, and no raw reviews array', async () => {
    await setReviewsEnabled(true);
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 });
    const fixture = await providerFixture(category.id);
    const { customer, cookie } = await customerSession();

    const reviewed = await completedJob(fixture, customer.id);
    const written = await ctx.prisma.providerReview.create({
      data: {
        requestId: reviewed.serviceRequest.id,
        offerId: reviewed.offer.id,
        providerId: fixture.provider.id,
        customerUserId: customer.id,
        rating: 5,
        comment: 'Yorum metni.',
      },
    });
    const removed = await completedJob(fixture, customer.id);
    const removedAt = new Date('2026-09-01T10:00:00.000Z');
    const removedReview = await ctx.prisma.providerReview.create({
      data: {
        requestId: removed.serviceRequest.id,
        offerId: removed.offer.id,
        providerId: fixture.provider.id,
        customerUserId: customer.id,
        rating: 2,
        removedAt,
      },
    });
    const unreviewed = await completedJob(fixture, customer.id);

    const response = await request(ctx.server)
      .get(myRequestsUrl)
      .set('Cookie', cookie)
      .expect(200);

    const rows = indexBy(response.body, 'id');
    expect(rows(reviewed.serviceRequest.id).review).toEqual({
      id: written.id,
      rating: 5,
      removedAt: null,
    });
    expect(rows(removed.serviceRequest.id).review).toEqual({
      id: removedReview.id,
      rating: 2,
      removedAt: removedAt.toISOString(),
    });
    expect(rows(unreviewed.serviceRequest.id).review).toBeNull();
    for (const row of response.body) {
      expect(row).not.toHaveProperty('reviews');
      // The comment is the customer's own, but the list is not where it lives.
      expect(JSON.stringify(row.review)).not.toContain('Yorum metni');
    }
  });
});

describe('what the projections do not change', () => {
  it('feed and offer projections add reviewSummary and nothing else: keys, prices and ordering are as before', async () => {
    await setReviewsEnabled(true);
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
      offerCreditCost: 1,
    });
    const rated = await providerFixture(category.id);
    const unrated = await providerFixture(category.id);
    await threeReviews(rated, 5);

    // Vitrin: the unrated card was bought first, so it stays first — a rating
    // is not a field in the sort key.
    const unratedCard = await placeCard(unrated, new Date(Date.now() - 120_000), 'Önce');
    const ratedCard = await placeCard(rated, new Date(Date.now() - 60_000), 'Sonra');

    const feed = await request(ctx.server).get(feedUrl).expect(200);
    expect(feed.body.cards.map((card: { cardId: string }) => card.cardId)).toEqual([
      unratedCard.id,
      ratedCard.id,
    ]);
    for (const card of feed.body.cards) {
      expect(sortedKeys(card)).toEqual([...FEED_CARD_KEYS].sort());
      expect(sortedKeys(card.provider)).toEqual(
        ['id', 'businessName', 'city', 'district', 'reviewSummary'].sort(),
      );
      expect(card.listedServicePriceAmount).toBe(150_000);
      expect(card.listedServiceCurrency).toBe('TRY');
    }

    // Offers: newest first, whatever the rating.
    const { customer, cookie } = await customerSession();
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
    });
    const ratedOffer = await pendingOffer(rated, serviceRequest.id, new Date(Date.now() - 60_000));
    const unratedOffer = await pendingOffer(unrated, serviceRequest.id, new Date());

    const offers = await request(ctx.server)
      .get(offersUrl(serviceRequest.id))
      .set('Cookie', cookie)
      .expect(200);
    expect(offers.body.map((offer: { id: string }) => offer.id)).toEqual([
      unratedOffer.id,
      ratedOffer.id,
    ]);
    for (const offer of offers.body) {
      expect(sortedKeys(offer)).toEqual([...OFFER_PREVIEW_KEYS].sort());
      expect(sortedKeys(offer.provider)).toEqual(
        ['id', 'businessName', 'city', 'district', 'reviewSummary'].sort(),
      );
      expect(offer.priceAmount).toBe(2500);
    }
  });
});
