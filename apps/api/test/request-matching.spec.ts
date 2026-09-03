import {
  CreditTransactionType,
  OfferRejectionReason,
  OfferStatus,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  backdateOfferSubmission,
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  currentCreditBalance,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  type TestContext,
  ACCEPT_OFFER,
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

const CATEGORY_COST = 2;

/**
 * An approved request owned by a signed-in customer, in a priced category.
 * Offers are added by {@link addOffer}, each from its own funded provider, so
 * every offer is a real credit spend rather than a hand-written row.
 */
async function matchingFixture() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });
  const customerCookie = await loginAs(ctx.prisma, customer.id);

  return { category, customer, customerCookie, serviceRequest };
}

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

function actionUrl(requestId: string, offerId: string) {
  return `/service-requests/${requestId}/offers/${offerId}/action`;
}

describe('offer acceptance — one winner per request', () => {
  it('lets exactly one of two concurrent accepts through', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const first = await addOffer(category.id, serviceRequest.id);
    const second = await addOffer(category.id, serviceRequest.id);

    const results = await Promise.all([
      request(ctx.server)
        .post(actionUrl(serviceRequest.id, first.offerId))
        .set('Cookie', customerCookie)
        .send(ACCEPT_OFFER),
      request(ctx.server)
        .post(actionUrl(serviceRequest.id, second.offerId))
        .set('Cookie', customerCookie)
        .send(ACCEPT_OFFER),
    ]);

    for (const result of results) {
      expect(result.status).toBeLessThan(500);
    }

    const winners = results.filter((result) => result.status === 200 || result.status === 201);
    expect(winners).toHaveLength(1);

    // The loser reaches the business rule, never a leaked serialization abort.
    const loser = results.find((result) => result !== winners[0]);
    expect(loser?.status).toBe(409);

    const accepted = await ctx.prisma.offer.findMany({
      where: { requestId: serviceRequest.id, status: OfferStatus.ACCEPTED },
    });
    expect(accepted).toHaveLength(1);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(ServiceRequestStatus.MATCHED);
    expect(stored.matchedOfferId).toBe(accepted[0]?.id);
    expect(stored.matchedAt).not.toBeNull();
  });

  it('closes the competing offers and leaves terminal ones alone', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    const submitted = await addOffer(category.id, serviceRequest.id);
    const viewed = await addOffer(category.id, serviceRequest.id);
    const shortlisted = await addOffer(category.id, serviceRequest.id);
    const withdrawn = await addOffer(category.id, serviceRequest.id);

    await ctx.prisma.offer.update({
      where: { id: viewed.offerId },
      data: { status: OfferStatus.VIEWED, viewedAt: new Date() },
    });
    await ctx.prisma.offer.update({
      where: { id: shortlisted.offerId },
      data: { status: OfferStatus.SHORTLISTED },
    });
    await ctx.prisma.offer.update({
      where: { id: withdrawn.offerId },
      data: { status: OfferStatus.WITHDRAWN, withdrawnAt: new Date() },
    });

    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    for (const closed of [submitted, viewed, shortlisted]) {
      const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: closed.offerId } });
      expect(offer.status).toBe(OfferStatus.REJECTED);
      expect(offer.rejectionReason).toBe(OfferRejectionReason.COMPETITOR_ACCEPTED);
      expect(offer.rejectedAt).not.toBeNull();
    }

    const untouched = await ctx.prisma.offer.findUniqueOrThrow({
      where: { id: withdrawn.offerId },
    });
    expect(untouched.status).toBe(OfferStatus.WITHDRAWN);
    expect(untouched.rejectionReason).toBeNull();
  });
});

describe('offer acceptance — credits', () => {
  it('refunds nothing when competitors are closed', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    const loser = await addOffer(category.id, serviceRequest.id);
    const balanceBefore = await currentCreditBalance(ctx.prisma, loser.provider.id);

    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    const refunds = await ctx.prisma.providerCreditTransaction.count({
      where: { type: CreditTransactionType.OFFER_REFUND },
    });
    expect(refunds).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, loser.provider.id)).toBe(balanceBefore);
    expect(balanceBefore).toBe(10 - CATEGORY_COST);
  });

  it('refunds a competitor-closed offer the customer never opened', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    const loser = await addOffer(category.id, serviceRequest.id);
    const loserBalanceBefore = await currentCreditBalance(ctx.prisma, loser.provider.id);

    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    // The loser was closed by the cascade and never opened by anyone. Losing
    // the request is not what the policy charges for — being read is.
    await backdateOfferSubmission(ctx.prisma, loser.offerId, 72);

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    const scan = await request(ctx.server)
      .get('/offers/refund-scan')
      .set('Cookie', adminCookie)
      .expect(200);
    expect((scan.body.items as Array<{ offerId: string }>).map((item) => item.offerId)).toContain(
      loser.offerId,
    );

    await request(ctx.server)
      .post('/offers/refund-scan/execute')
      .set('Cookie', adminCookie)
      .send({})
      .expect(201);

    const refunded = await ctx.prisma.providerCreditTransaction.findMany({
      where: { type: CreditTransactionType.OFFER_REFUND },
      select: { referenceId: true },
    });
    expect(refunded.map((row) => row.referenceId)).toEqual([loser.offerId]);
    expect(await currentCreditBalance(ctx.prisma, loser.provider.id)).toBe(
      loserBalanceBefore + CATEGORY_COST,
    );
  });

  it('never refunds the accepted offer, because accepting is reading it', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);

    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    await backdateOfferSubmission(ctx.prisma, winner.offerId, 72);

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    await request(ctx.server)
      .post('/offers/refund-scan/execute')
      .set('Cookie', adminCookie)
      .send({})
      .expect(201);

    expect(
      await ctx.prisma.providerCreditTransaction.count({
        where: { type: CreditTransactionType.OFFER_REFUND, referenceId: winner.offerId },
      }),
    ).toBe(0);
  });
});

describe('matched requests are closed to new offers', () => {
  it('drops the request from the provider matching list once matched', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);

    const onlookerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const onlooker = await createDiscoverableProvider(ctx.prisma, {
      userId: onlookerUser.id,
      categoryId: category.id,
    });
    const onlookerCookie = await loginAs(ctx.prisma, onlookerUser.id);
    await grantCredits(ctx.prisma, onlooker.id, 10);

    const before = await request(ctx.server)
      .get(`/providers/${onlooker.id}/requests`)
      .set('Cookie', onlookerCookie)
      .expect(200);
    expect((before.body as Array<{ id: string }>).map((item) => item.id)).toContain(
      serviceRequest.id,
    );

    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    const after = await request(ctx.server)
      .get(`/providers/${onlooker.id}/requests`)
      .set('Cookie', onlookerCookie)
      .expect(200);
    expect((after.body as Array<{ id: string }>).map((item) => item.id)).not.toContain(
      serviceRequest.id,
    );

    await request(ctx.server)
      .post(`/providers/${onlooker.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', onlookerCookie)
      .send(offerPayload())
      .expect(404);
  });

  for (const status of [
    ServiceRequestStatus.MATCHED,
    ServiceRequestStatus.COMPLETED,
    ServiceRequestStatus.CANCELLED,
    ServiceRequestStatus.EXPIRED,
  ]) {
    it(`refuses a new offer on a ${status} request`, async () => {
      const category = await createCategory(ctx.prisma, 'Klima', {
        offerCreditCost: CATEGORY_COST,
      });
      const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
      await ctx.prisma.serviceRequest.update({ where: { id: serviceRequest.id }, data: { status } });

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
  }
});

describe('request completion', () => {
  async function matchedFixture() {
    const fixture = await matchingFixture();
    const winner = await addOffer(fixture.category.id, fixture.serviceRequest.id);

    await request(ctx.server)
      .post(actionUrl(fixture.serviceRequest.id, winner.offerId))
      .set('Cookie', fixture.customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    return { ...fixture, winner };
  }

  it('lets the owning customer complete a matched request', async () => {
    const { customerCookie, serviceRequest } = await matchedFixture();

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/complete`)
      .set('Cookie', customerCookie)
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(ServiceRequestStatus.COMPLETED);
    expect(stored.completedAt).not.toBeNull();
  });

  it('refuses another customer and every provider', async () => {
    const { serviceRequest, winner } = await matchedFixture();

    const stranger = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/complete`)
      .set('Cookie', await loginAs(ctx.prisma, stranger.id))
      .expect(403);

    // Even the provider whose offer was accepted cannot declare its own job done.
    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/complete`)
      .set('Cookie', winner.cookie)
      .expect(403);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(ServiceRequestStatus.MATCHED);
  });

  it('lets SUPER_ADMIN complete and refuses a second completion', async () => {
    const { serviceRequest } = await matchedFixture();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/complete`)
      .set('Cookie', adminCookie)
      .expect(201);

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/complete`)
      .set('Cookie', adminCookie)
      .expect(409);

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/cancel`)
      .set('Cookie', adminCookie)
      .expect(409);
  });

  it('refuses to complete a request that was never matched', async () => {
    const { customerCookie, serviceRequest } = await matchingFixture();

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/complete`)
      .set('Cookie', customerCookie)
      .expect(409);
  });

  it('lets the owning customer cancel and then blocks further transitions', async () => {
    const { customerCookie, serviceRequest } = await matchingFixture();

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/cancel`)
      .set('Cookie', customerCookie)
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(ServiceRequestStatus.CANCELLED);
    expect(stored.cancelledAt).not.toBeNull();

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/cancel`)
      .set('Cookie', customerCookie)
      .expect(409);
  });

  it('refuses to write matching statuses through the moderation endpoint', async () => {
    const { serviceRequest } = await matchingFixture();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    for (const status of [
      ServiceRequestStatus.MATCHED,
      ServiceRequestStatus.COMPLETED,
      ServiceRequestStatus.EXPIRED,
    ]) {
      await request(ctx.server)
        .patch(`/service-requests/${serviceRequest.id}/status`)
        .set('Cookie', adminCookie)
        .send({ status })
        .expect(409);
    }

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(ServiceRequestStatus.APPROVED);
  });
});

describe('matching leaks no contact details', () => {
  it('keeps both offer projections free of phone and e-mail after acceptance', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    const loser = await addOffer(category.id, serviceRequest.id);

    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    const customerView = await request(ctx.server)
      .get(`/service-requests/${serviceRequest.id}/offers/${winner.offerId}`)
      .set('Cookie', customerCookie)
      .expect(200);
    const customerBody = JSON.stringify(customerView.body);
    expect(customerBody).not.toContain('phone');
    expect(customerBody).not.toContain('email');

    // The winning provider still sees no customer contact in this phase.
    const winnerView = await request(ctx.server)
      .get(`/providers/${winner.provider.id}/offers/${winner.offerId}`)
      .set('Cookie', winner.cookie)
      .expect(200);
    const winnerBody = JSON.stringify(winnerView.body);
    expect(winnerBody).not.toContain('customerPhone');
    expect(winnerBody).not.toContain('customerEmail');
    expect(winnerBody).not.toContain('customerName');

    // And the losing provider learns nothing about who won, not even the reason.
    const loserView = await request(ctx.server)
      .get(`/providers/${loser.provider.id}/offers/${loser.offerId}`)
      .set('Cookie', loser.cookie)
      .expect(200);
    const loserBody = JSON.stringify(loserView.body);
    expect(loserBody).not.toContain('COMPETITOR');
    expect(loserBody).not.toContain('rejectionReason');
    expect(loserBody).not.toContain('customerPhone');
    // What it does get is the neutral verdict, with no hint of a rival.
    // Nothing about a rival, and nothing invented: the offer is simply unviewed
    // and still inside its window.
    expect(loserView.body.refundEligibility.reasonCode).toBe('WAITING_VIEW_WINDOW');
    expect(loserView.body.refundEligibility.policyStatusLabel).toBe('Görüntülenme bekleniyor');

    // The admin, by contrast, still sees the precise internal reason.
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminView = await request(ctx.server)
      .get(`/offers/${loser.offerId}`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(200);
    expect(adminView.body.rejectionReason).toBe(OfferRejectionReason.COMPETITOR_ACCEPTED);
  });
});
