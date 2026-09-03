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
const STARTING_CREDITS = 10;

/**
 * A live offer from a funded provider on an approved, customer-owned request.
 *
 * The offer is submitted through the API rather than written directly, so the
 * credit spend under test is the real one and the balance assertions mean
 * something.
 */
async function withdrawalFixture() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const customerCookie = await loginAs(ctx.prisma, customer.id);
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });
  const offer = await addOffer(category.id, serviceRequest.id);

  return { category, customer, customerCookie, serviceRequest, ...offer };
}

async function addOffer(categoryId: string, requestId: string) {
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId,
  });
  const cookie = await loginAs(ctx.prisma, ownerUser.id);
  await grantCredits(ctx.prisma, provider.id, STARTING_CREDITS);

  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${requestId}/offers`)
    .set('Cookie', cookie)
    .send(offerPayload())
    .expect(201);

  return { ownerUser, provider, cookie, offerId: created.body.id as string };
}

function withdrawUrl(providerId: string, offerId: string) {
  return `/providers/${providerId}/offers/${offerId}/withdraw`;
}

function acceptUrl(requestId: string, offerId: string) {
  return `/service-requests/${requestId}/offers/${offerId}/action`;
}

async function countRefunds() {
  return ctx.prisma.providerCreditTransaction.count({
    where: { type: CreditTransactionType.OFFER_REFUND },
  });
}

describe('provider offer withdrawal — the happy path', () => {
  it('withdraws a submitted offer without touching the ledger', async () => {
    const { provider, cookie, offerId } = await withdrawalFixture();
    const balanceBefore = await currentCreditBalance(ctx.prisma, provider.id);
    expect(balanceBefore).toBe(STARTING_CREDITS - CATEGORY_COST);

    const response = await request(ctx.server)
      .post(withdrawUrl(provider.id, offerId))
      .set('Cookie', cookie)
      .expect(201);

    expect(response.body.status).toBe(OfferStatus.WITHDRAWN);
    expect(response.body.withdrawnAt).not.toBeNull();

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.status).toBe(OfferStatus.WITHDRAWN);
    expect(stored.withdrawnAt).not.toBeNull();

    // The spend snapshot and the refund pointer are exactly as the offer left
    // them: withdrawing is not a refund and must not look like one.
    expect(stored.creditCost).toBe(CATEGORY_COST);
    expect(stored.creditSpentTransactionId).not.toBeNull();
    expect(stored.creditRefundedTransactionId).toBeNull();
    expect(stored.creditRefundedAt).toBeNull();

    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(balanceBefore);
    expect(await countRefunds()).toBe(0);
  });

  for (const status of [OfferStatus.VIEWED, OfferStatus.SHORTLISTED]) {
    it(`withdraws a ${status} offer`, async () => {
      const { provider, cookie, offerId } = await withdrawalFixture();
      await ctx.prisma.offer.update({
        where: { id: offerId },
        data: {
          status,
          ...(status === OfferStatus.VIEWED ? { viewedAt: new Date() } : {}),
        },
      });

      await request(ctx.server)
        .post(withdrawUrl(provider.id, offerId))
        .set('Cookie', cookie)
        .expect(201);

      const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
      expect(stored.status).toBe(OfferStatus.WITHDRAWN);
      expect(stored.withdrawnAt).not.toBeNull();
      expect(await countRefunds()).toBe(0);
    });
  }

  it('does not let the same provider offer on that request again', async () => {
    const { provider, cookie, offerId, serviceRequest } = await withdrawalFixture();

    await request(ctx.server)
      .post(withdrawUrl(provider.id, offerId))
      .set('Cookie', cookie)
      .expect(201);

    const balanceAfterWithdrawal = await currentCreditBalance(ctx.prisma, provider.id);

    await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(409);

    // The refused retry cost nothing and created nothing.
    expect(await ctx.prisma.offer.count({ where: { requestId: serviceRequest.id } })).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(balanceAfterWithdrawal);
  });
});

describe('provider offer withdrawal — who may withdraw', () => {
  it('refuses anonymous callers', async () => {
    const { provider, offerId } = await withdrawalFixture();

    await request(ctx.server).post(withdrawUrl(provider.id, offerId)).expect(401);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.status).toBe(OfferStatus.SUBMITTED);
  });

  it('refuses the customer who received the offer', async () => {
    const { provider, offerId, customerCookie } = await withdrawalFixture();

    await request(ctx.server)
      .post(withdrawUrl(provider.id, offerId))
      .set('Cookie', customerCookie)
      .expect(403);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.status).toBe(OfferStatus.SUBMITTED);
  });

  it('refuses another provider, on its own id and on the owner’s', async () => {
    const { category, serviceRequest, provider, offerId } = await withdrawalFixture();
    const stranger = await addOffer(category.id, serviceRequest.id);

    // Routed through the owner's provider id: the guard rejects it.
    await request(ctx.server)
      .post(withdrawUrl(provider.id, offerId))
      .set('Cookie', stranger.cookie)
      .expect(403);

    // Routed through its own provider id: the guard passes, and the service
    // answers 404 because the offer is not this provider's to see.
    await request(ctx.server)
      .post(withdrawUrl(stranger.provider.id, offerId))
      .set('Cookie', stranger.cookie)
      .expect(404);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.status).toBe(OfferStatus.SUBMITTED);
  });

  it('lets the owning provider through', async () => {
    const { provider, cookie, offerId } = await withdrawalFixture();

    await request(ctx.server)
      .post(withdrawUrl(provider.id, offerId))
      .set('Cookie', cookie)
      .expect(201);
  });
});

describe('provider offer withdrawal — states that refuse it', () => {
  for (const status of [
    OfferStatus.ACCEPTED,
    OfferStatus.REJECTED,
    OfferStatus.WITHDRAWN,
    OfferStatus.CANCELLED,
    OfferStatus.EXPIRED,
  ]) {
    it(`refuses a ${status} offer with a business rule, not a crash`, async () => {
      const { provider, cookie, offerId } = await withdrawalFixture();
      await ctx.prisma.offer.update({ where: { id: offerId }, data: { status } });

      const response = await request(ctx.server)
        .post(withdrawUrl(provider.id, offerId))
        .set('Cookie', cookie)
        .expect(409);
      expect(response.body.code).toBe('OFFER_NOT_WITHDRAWABLE');

      const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
      expect(stored.status).toBe(status);
      expect(await countRefunds()).toBe(0);
    });
  }

  for (const status of [
    ServiceRequestStatus.MATCHED,
    ServiceRequestStatus.COMPLETED,
    ServiceRequestStatus.CANCELLED,
    ServiceRequestStatus.EXPIRED,
  ]) {
    it(`refuses a live offer on a ${status} request`, async () => {
      const { provider, cookie, offerId, serviceRequest } = await withdrawalFixture();
      await ctx.prisma.serviceRequest.update({
        where: { id: serviceRequest.id },
        data: { status },
      });

      const response = await request(ctx.server)
        .post(withdrawUrl(provider.id, offerId))
        .set('Cookie', cookie)
        .expect(409);
      expect(response.body.code).toBe('OFFER_NOT_WITHDRAWABLE');

      const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
      expect(stored.status).toBe(OfferStatus.SUBMITTED);
      expect(stored.withdrawnAt).toBeNull();
    });
  }

  it('refuses an offer id that belongs to no offer', async () => {
    const { provider, cookie } = await withdrawalFixture();

    await request(ctx.server)
      .post(withdrawUrl(provider.id, 'no-such-offer'))
      .set('Cookie', cookie)
      .expect(404);
  });
});

describe('provider offer withdrawal — concurrency', () => {
  it('lets exactly one of two parallel withdrawals through', async () => {
    const { provider, cookie, offerId } = await withdrawalFixture();

    const results = await Promise.all([
      request(ctx.server).post(withdrawUrl(provider.id, offerId)).set('Cookie', cookie),
      request(ctx.server).post(withdrawUrl(provider.id, offerId)).set('Cookie', cookie),
    ]);

    for (const result of results) {
      expect(result.status).toBeLessThan(500);
    }

    const winners = results.filter((result) => result.status === 200 || result.status === 201);
    expect(winners).toHaveLength(1);

    // The loser reaches the business rule, never a leaked serialization abort.
    const loser = results.find((result) => result !== winners[0]);
    expect(loser?.status).toBe(409);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.status).toBe(OfferStatus.WITHDRAWN);
    expect(await countRefunds()).toBe(0);
  });

  it('never lets an acceptance and a withdrawal both land', async () => {
    const { provider, cookie, offerId, serviceRequest, customerCookie } =
      await withdrawalFixture();

    const [accept, withdraw] = await Promise.all([
      request(ctx.server)
        .post(acceptUrl(serviceRequest.id, offerId))
        .set('Cookie', customerCookie)
        .send(ACCEPT_OFFER),
      request(ctx.server).post(withdrawUrl(provider.id, offerId)).set('Cookie', cookie),
    ]);

    expect(accept.status).toBeLessThan(500);
    expect(withdraw.status).toBeLessThan(500);

    const succeeded = [accept, withdraw].filter(
      (result) => result.status === 200 || result.status === 201,
    );
    expect(succeeded).toHaveLength(1);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    const matchedRequest = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });

    if (stored.status === OfferStatus.ACCEPTED) {
      // The acceptance won: the request is matched to it, and the offer carries
      // no withdrawal timestamp.
      expect(withdraw.status).toBe(409);
      expect(stored.withdrawnAt).toBeNull();
      expect(matchedRequest.status).toBe(ServiceRequestStatus.MATCHED);
      expect(matchedRequest.matchedOfferId).toBe(offerId);
    } else {
      // The withdrawal won: the request never matched, so it is still open and
      // points at no offer at all.
      expect(stored.status).toBe(OfferStatus.WITHDRAWN);
      expect(stored.acceptedAt).toBeNull();
      expect(accept.status).toBe(409);
      expect(matchedRequest.status).toBe(ServiceRequestStatus.APPROVED);
      expect(matchedRequest.matchedOfferId).toBeNull();
    }

    expect(await countRefunds()).toBe(0);
  });

  it('never lets a rejection and a withdrawal both land', async () => {
    const { provider, cookie, offerId, serviceRequest, customerCookie } =
      await withdrawalFixture();

    const [reject, withdraw] = await Promise.all([
      request(ctx.server)
        .post(acceptUrl(serviceRequest.id, offerId))
        .set('Cookie', customerCookie)
        .send({ action: 'REJECT' }),
      request(ctx.server).post(withdrawUrl(provider.id, offerId)).set('Cookie', cookie),
    ]);

    expect(reject.status).toBeLessThan(500);
    expect(withdraw.status).toBeLessThan(500);

    const succeeded = [reject, withdraw].filter(
      (result) => result.status === 200 || result.status === 201,
    );
    expect(succeeded).toHaveLength(1);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect([OfferStatus.REJECTED, OfferStatus.WITHDRAWN]).toContain(stored.status);
    if (stored.status === OfferStatus.WITHDRAWN) {
      expect(stored.rejectedAt).toBeNull();
    } else {
      expect(stored.withdrawnAt).toBeNull();
    }
  });
});

describe('provider offer withdrawal — refunds', () => {
  it('reports NO_REFUND to the provider and to the admin', async () => {
    const { provider, cookie, offerId } = await withdrawalFixture();

    const withdrawn = await request(ctx.server)
      .post(withdrawUrl(provider.id, offerId))
      .set('Cookie', cookie)
      .expect(201);
    expect(withdrawn.body.refundEligibility.recommendedAction).toBe('NO_REFUND');
    expect(withdrawn.body.refundEligibility.eligible).toBe(false);

    const providerView = await request(ctx.server)
      .get(`/providers/${provider.id}/offers/${offerId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(providerView.body.refundEligibility.recommendedAction).toBe('NO_REFUND');

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    const adminView = await request(ctx.server)
      .get(`/offers/${offerId}`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(adminView.body.refundEligibility.recommendedAction).toBe('NO_REFUND');
    expect(adminView.body.withdrawnAt).not.toBeNull();
  });

  it('still refunds a self-withdrawn offer the customer never opened', async () => {
    const { provider, cookie, offerId } = await withdrawalFixture();

    await request(ctx.server)
      .post(withdrawUrl(provider.id, offerId))
      .set('Cookie', cookie)
      .expect(201);

    // Never viewed and past the window. Withdrawing used to disqualify the
    // offer; under the 48-hour rule it decides nothing — what the customer did
    // or did not do decides.
    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: { submittedAt: new Date(Date.now() - 72 * 60 * 60 * 1000) },
    });

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    const scan = await request(ctx.server)
      .get('/offers/refund-scan')
      .set('Cookie', adminCookie)
      .expect(200);
    expect((scan.body.items as Array<{ offerId: string }>).map((item) => item.offerId)).toContain(
      offerId,
    );

    await request(ctx.server)
      .post('/offers/refund-scan/execute')
      .set('Cookie', adminCookie)
      .send({})
      .expect(201);

    expect(await countRefunds()).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('never refunds a withdrawn offer the customer had already opened', async () => {
    const { provider, cookie, offerId, serviceRequest, customerCookie } = await withdrawalFixture();

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/offers/${offerId}/view`)
      .set('Cookie', customerCookie)
      .expect(201);

    await request(ctx.server)
      .post(withdrawUrl(provider.id, offerId))
      .set('Cookie', cookie)
      .expect(201);

    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: { submittedAt: new Date(Date.now() - 72 * 60 * 60 * 1000) },
    });

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    await request(ctx.server)
      .post('/offers/refund-scan/execute')
      .set('Cookie', adminCookie)
      .send({})
      .expect(201);

    expect(await countRefunds()).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(
      STARTING_CREDITS - CATEGORY_COST,
    );
  });

  it('lets an admin refund a withdrawn offer by hand, once, with an audit row', async () => {
    const { provider, cookie, offerId, serviceRequest, customerCookie } = await withdrawalFixture();

    // Viewed, so the automatic policy will never pay this one. The manual tool
    // is the remedy for exactly that: a case the rule cannot see.
    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/offers/${offerId}/view`)
      .set('Cookie', customerCookie)
      .expect(201);
    await request(ctx.server)
      .post(withdrawUrl(provider.id, offerId))
      .set('Cookie', cookie)
      .expect(201);

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', adminCookie)
      .send({ reasonCode: 'PLATFORM_ERROR', note: 'Dahili not' })
      .expect(201);

    expect(await countRefunds()).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);

    const audit = await ctx.prisma.manualOfferRefundAudit.findUniqueOrThrow({ where: { offerId } });
    expect(audit.performedById).toBe(admin.id);
    expect(audit.reasonCode).toBe('PLATFORM_ERROR');

    // And it is a one-off: a second attempt adds no credit.
    await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', adminCookie)
      .send({ reasonCode: 'PLATFORM_ERROR' })
      .expect(409);

    expect(await countRefunds()).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('does not disturb the competitor-closed verdict', async () => {
    const { category, serviceRequest, customerCookie, provider, cookie, offerId } =
      await withdrawalFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    const loser = await addOffer(category.id, serviceRequest.id);

    await request(ctx.server)
      .post(withdrawUrl(provider.id, offerId))
      .set('Cookie', cookie)
      .expect(201);

    await request(ctx.server)
      .post(acceptUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    const withdrawnOffer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(withdrawnOffer.status).toBe(OfferStatus.WITHDRAWN);
    expect(withdrawnOffer.rejectionReason).toBeNull();

    const losingOffer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: loser.offerId } });
    expect(losingOffer.status).toBe(OfferStatus.REJECTED);
    expect(losingOffer.rejectionReason).toBe(OfferRejectionReason.COMPETITOR_ACCEPTED);

    const loserView = await request(ctx.server)
      .get(`/providers/${loser.provider.id}/offers/${loser.offerId}`)
      .set('Cookie', loser.cookie)
      .expect(200);
    // Losing decides nothing about the credit: the loser was never opened and
    // is simply inside its window still.
    expect(loserView.body.refundEligibility.reasonCode).toBe('WAITING_VIEW_WINDOW');
    expect(loserView.body.refundEligibility.policyStatus).toBe('AWAITING_VIEW');

    expect(await countRefunds()).toBe(0);
  });
});

describe('provider offer withdrawal — what the customer sees', () => {
  it('drops the withdrawn offer from the customer’s active count', async () => {
    const { provider, cookie, offerId, serviceRequest, customerCookie, category } =
      await withdrawalFixture();
    const survivor = await addOffer(category.id, serviceRequest.id);

    const before = await request(ctx.server)
      .get('/service-requests/my')
      .set('Cookie', customerCookie)
      .expect(200);
    expect(
      (before.body as Array<{ id: string; offersCount: number }>).find(
        (item) => item.id === serviceRequest.id,
      )?.offersCount,
    ).toBe(2);

    await request(ctx.server)
      .post(withdrawUrl(provider.id, offerId))
      .set('Cookie', cookie)
      .expect(201);

    const after = await request(ctx.server)
      .get('/service-requests/my')
      .set('Cookie', customerCookie)
      .expect(200);
    expect(
      (after.body as Array<{ id: string; offersCount: number }>).find(
        (item) => item.id === serviceRequest.id,
      )?.offersCount,
    ).toBe(1);

    // The record itself is still there — the offer list keeps it so the screen
    // can show a neutral history line — it simply is not a live offer any more.
    const offers = await request(ctx.server)
      .get(`/service-requests/${serviceRequest.id}/offers`)
      .set('Cookie', customerCookie)
      .expect(200);
    const listed = offers.body as Array<{ id: string; status: string }>;
    expect(listed.find((item) => item.id === offerId)?.status).toBe(OfferStatus.WITHDRAWN);
    expect(listed.find((item) => item.id === survivor.offerId)?.status).toBe(
      OfferStatus.SUBMITTED,
    );
  });

  it('refuses every customer action on the withdrawn offer', async () => {
    const { provider, cookie, offerId, serviceRequest, customerCookie } =
      await withdrawalFixture();

    await request(ctx.server)
      .post(withdrawUrl(provider.id, offerId))
      .set('Cookie', cookie)
      .expect(201);

    for (const action of ['ACCEPT', 'SHORTLIST', 'REJECT']) {
      await request(ctx.server)
        .post(acceptUrl(serviceRequest.id, offerId))
        .set('Cookie', customerCookie)
        .send({ action })
        .expect(400);
    }

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.status).toBe(OfferStatus.WITHDRAWN);
    expect(stored.acceptedAt).toBeNull();
    expect(stored.rejectedAt).toBeNull();
  });
});
