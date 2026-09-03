import {
  CreditTransactionType,
  OfferStatus,
  PackagePurchaseStatus,
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
  uniqueSuffix,
  type TestContext,
} from './harness';
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';

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

/**
 * Builds an approved provider owned by a signed-in account, plus an approved
 * request it is allowed to see. Everything the offer endpoint checks — provider
 * status, category overlap, service area, request status — is satisfied.
 */
async function offerFixture(
  options: { credits?: number; categoryCost?: number | null; categoryActive?: boolean } = {},
) {
  // Every fixture states its own category price; nothing falls back to a
  // default, so an expectation can never accidentally assert the old flat cost.
  const categoryCost = options.categoryCost === undefined ? 1 : options.categoryCost;
  const category = await createCategory(ctx.prisma, 'Klima', {
    offerCreditCost: categoryCost,
    isActive: options.categoryActive ?? true,
  });
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId: category.id,
  });
  const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
  const cookie = await loginAs(ctx.prisma, ownerUser.id);

  if (options.credits) {
    await grantCredits(ctx.prisma, provider.id, options.credits);
  }

  return { category, categoryCost, ownerUser, provider, serviceRequest, cookie };
}

function offerUrl(providerId: string, requestId: string) {
  return `/providers/${providerId}/requests/${requestId}/offers`;
}

describe('offer creation — insufficient credit', () => {
  it('returns 402, creates no offer and writes no spend row', async () => {
    const { provider, serviceRequest, cookie } = await offerFixture({ categoryCost: 2 });
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);

    await request(ctx.server)
      .post(offerUrl(provider.id, serviceRequest.id))
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(402);

    expect(await ctx.prisma.offer.count({ where: { providerId: provider.id } })).toBe(0);
    expect(
      await ctx.prisma.providerCreditTransaction.count({
        where: { providerId: provider.id, type: CreditTransactionType.OFFER_SPEND },
      }),
    ).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
  });
});

describe('offer creation — one offer per provider per request', () => {
  it('accepts the first offer, rejects the second with 409, and charges once', async () => {
    const CREDITS = 5;
    const COST = 2;
    const { provider, serviceRequest, cookie } = await offerFixture({
      credits: CREDITS,
      categoryCost: COST,
    });

    await request(ctx.server)
      .post(offerUrl(provider.id, serviceRequest.id))
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);

    await request(ctx.server)
      .post(offerUrl(provider.id, serviceRequest.id))
      .set('Cookie', cookie)
      .send(offerPayload({ priceAmount: 200000 }))
      .expect(409);

    expect(await ctx.prisma.offer.count({ where: { providerId: provider.id } })).toBe(1);

    const spends = await ctx.prisma.providerCreditTransaction.findMany({
      where: { providerId: provider.id, type: CreditTransactionType.OFFER_SPEND },
    });
    expect(spends).toHaveLength(1);
    expect(spends[0]?.amount).toBe(-COST);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(CREDITS - COST);
  });
});

describe('offer creation — concurrent requests against a single credit', () => {
  it('lets exactly one through and never drives the balance negative', async () => {
    const COST = 3;
    const { category, provider, cookie } = await offerFixture({
      credits: COST,
      categoryCost: COST,
    });

    // Two *different* requests: the provider+request unique constraint would
    // otherwise decide the race before the credit logic ever runs.
    const first = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const second = await createApprovedRequest(ctx.prisma, { categoryId: category.id });

    const [a, b] = await Promise.all([
      request(ctx.server)
        .post(offerUrl(provider.id, first.id))
        .set('Cookie', cookie)
        .send(offerPayload()),
      request(ctx.server)
        .post(offerUrl(provider.id, second.id))
        .set('Cookie', cookie)
        .send(offerPayload()),
    ]);

    const statuses = [a.status, b.status].sort();
    const succeeded = statuses.filter((status) => status === 201);
    const failed = statuses.filter((status) => status !== 201);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    // The loser gets the designed insufficient-credit answer, not a leaked
    // serialization error: the Serializable transaction serialises the two
    // balance reads, so the second one genuinely sees a zero balance.
    expect(failed[0]).toBe(402);

    const offers = await ctx.prisma.offer.count({ where: { providerId: provider.id } });
    const spends = await ctx.prisma.providerCreditTransaction.count({
      where: { providerId: provider.id, type: CreditTransactionType.OFFER_SPEND },
    });
    const balance = await currentCreditBalance(ctx.prisma, provider.id);

    expect(offers).toBe(1);
    expect(spends).toBe(1);
    expect(balance).toBe(0);
    expect(balance).toBeGreaterThanOrEqual(0);
  });

  it('keeps the ledger consistent with the offer rows', async () => {
    const COST = 2;
    const CREDITS = 6;
    const { category, provider, cookie } = await offerFixture({
      credits: CREDITS,
      categoryCost: COST,
    });

    const requests = await Promise.all([
      createApprovedRequest(ctx.prisma, { categoryId: category.id }),
      createApprovedRequest(ctx.prisma, { categoryId: category.id }),
      createApprovedRequest(ctx.prisma, { categoryId: category.id }),
      createApprovedRequest(ctx.prisma, { categoryId: category.id }),
      createApprovedRequest(ctx.prisma, { categoryId: category.id }),
    ]);

    await Promise.all(
      requests.map((serviceRequest) =>
        request(ctx.server)
          .post(offerUrl(provider.id, serviceRequest.id))
          .set('Cookie', cookie)
          .send(offerPayload()),
      ),
    );

    const offers = await ctx.prisma.offer.findMany({ where: { providerId: provider.id } });
    const spends = await ctx.prisma.providerCreditTransaction.findMany({
      where: { providerId: provider.id, type: CreditTransactionType.OFFER_SPEND },
    });
    const balance = await currentCreditBalance(ctx.prisma, provider.id);

    // Never more offers than the budget allows, one spend row per offer, and the
    // balance is exactly what the ledger says it should be.
    expect(offers.length).toBeLessThanOrEqual(Math.floor(CREDITS / COST));
    expect(spends).toHaveLength(offers.length);
    expect(balance).toBe(CREDITS - offers.length * COST);
    expect(balance).toBeGreaterThanOrEqual(0);
    for (const offer of offers) {
      expect(offer.creditSpentTransactionId).not.toBeNull();
    }
  });
});

describe('offer credit refund — idempotency', () => {
  /**
   * The only refund path there is: an offer the customer never opened, older
   * than the window, refunded by the worker. The manual admin endpoint these
   * cases used to drive was removed with the policy it belonged to.
   */
  async function unviewedRefundableOffer(credits: number, cost: number) {
    const { provider, serviceRequest, cookie } = await offerFixture({
      credits,
      categoryCost: cost,
    });

    const created = await request(ctx.server)
      .post(offerUrl(provider.id, serviceRequest.id))
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);

    const offerId = created.body.id as string;
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(credits - cost);

    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: { submittedAt: new Date(Date.now() - 72 * 60 * 60 * 1000) },
    });

    return { provider, offerId, worker: ctx.app.get(UnviewedOfferRefundService) };
  }

  it('refunds once and does nothing on the next run', async () => {
    const CREDITS = 6;
    const COST = 4;
    const { provider, offerId, worker } = await unviewedRefundableOffer(CREDITS, COST);

    expect((await worker.execute()).refunded).toBe(1);
    expect((await worker.execute()).refunded).toBe(0);

    const refunds = await ctx.prisma.providerCreditTransaction.findMany({
      where: { providerId: provider.id, type: CreditTransactionType.OFFER_REFUND },
    });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.amount).toBe(COST);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(CREDITS);

    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.creditRefundedTransactionId).toBe(refunds[0]?.id);
    expect(offer.creditRefundedAt).not.toBeNull();
  });

  it('refunds once under concurrent runs, and no run fails', async () => {
    const CREDITS = 5;
    const COST = 3;
    const { provider, worker } = await unviewedRefundableOffer(CREDITS, COST);

    const runs = await Promise.all([worker.execute(), worker.execute(), worker.execute()]);

    expect(runs.reduce((sum, run) => sum + run.refunded, 0)).toBe(1);
    // A loser must reach the business rule, not a leaked serialization abort:
    // runSerializable retries the P2034 and the replay sees the refund already
    // recorded. A FAILED here is a regression, never acceptable.
    for (const run of runs) {
      expect(run.results.filter((entry) => entry.status === 'FAILED')).toHaveLength(0);
    }

    const refunds = await ctx.prisma.providerCreditTransaction.count({
      where: { providerId: provider.id, type: CreditTransactionType.OFFER_REFUND },
    });
    expect(refunds).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(CREDITS);
  });
});

describe('mock package payment — single settlement', () => {
  async function purchaseFixture() {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: ownerUser.id,
      categoryId: category.id,
    });
    const cookie = await loginAs(ctx.prisma, ownerUser.id);

    const suffix = uniqueSuffix();
    const creditPackage = await ctx.prisma.offerCreditPackage.create({
      data: {
        name: `Paket ${suffix}`,
        slug: `paket-${suffix}`,
        creditAmount: 10,
        priceAmount: 50000,
        isActive: true,
      },
    });

    const purchase = await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(201);

    return { provider, cookie, purchaseId: purchase.body.id as string };
  }

  const card = {
    cardholderName: 'Test Kart',
    cardNumber: '4111111111111111',
    expiryMonth: 12,
    expiryYear: 2030,
    cvv: '123',
  };

  it('loads credits once when the payment call is repeated', async () => {
    const { provider, cookie, purchaseId } = await purchaseFixture();
    const payUrl = `/providers/${provider.id}/package-purchases/${purchaseId}/mock-pay`;

    const first = await request(ctx.server)
      .post(payUrl)
      .set('Cookie', cookie)
      .send(card)
      .expect(201);
    expect(first.body.status).toBe(PackagePurchaseStatus.PAID);

    await request(ctx.server).post(payUrl).set('Cookie', cookie).send(card).expect(409);

    const loads = await ctx.prisma.providerCreditTransaction.findMany({
      where: { providerId: provider.id, type: CreditTransactionType.PACKAGE_PURCHASE },
    });
    expect(loads).toHaveLength(1);
    expect(loads[0]?.amount).toBe(10);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(10);

    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: purchaseId },
    });
    expect(purchase.status).toBe(PackagePurchaseStatus.PAID);
    expect(purchase.creditTransactionId).toBe(loads[0]?.id);
  });

  it('settles once under concurrent payment calls', async () => {
    const { provider, cookie, purchaseId } = await purchaseFixture();
    const payUrl = `/providers/${provider.id}/package-purchases/${purchaseId}/mock-pay`;

    const results = await Promise.all([
      request(ctx.server).post(payUrl).set('Cookie', cookie).send(card),
      request(ctx.server).post(payUrl).set('Cookie', cookie).send(card),
    ]);

    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    // Same contract as the concurrent refund: the retried transaction replays,
    // sees the purchase already PAID, and answers 409. Never a 500.
    const loser = results.find((result) => result.status !== 201);
    expect(loser?.status).toBe(409);

    const loads = await ctx.prisma.providerCreditTransaction.count({
      where: { providerId: provider.id, type: CreditTransactionType.PACKAGE_PURCHASE },
    });
    expect(loads).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(10);
  });

  it('does not load credits when the mock payment is declined', async () => {
    const { provider, cookie, purchaseId } = await purchaseFixture();

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases/${purchaseId}/mock-pay`)
      .set('Cookie', cookie)
      .send({ ...card, cardNumber: '4111111111110000' })
      .expect(201);

    expect(response.body.status).toBe(PackagePurchaseStatus.FAILED);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
    expect(
      await ctx.prisma.providerCreditTransaction.count({
        where: { providerId: provider.id, type: CreditTransactionType.PACKAGE_PURCHASE },
      }),
    ).toBe(0);
  });
});

describe('offer status after a successful submission', () => {
  it('records the spend transaction id on the offer', async () => {
    const COST = 3;
    const { provider, serviceRequest, cookie } = await offerFixture({
      credits: COST,
      categoryCost: COST,
    });

    const created = await request(ctx.server)
      .post(offerUrl(provider.id, serviceRequest.id))
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);

    expect(created.body.status).toBe(OfferStatus.SUBMITTED);

    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: created.body.id } });
    const spend = await ctx.prisma.providerCreditTransaction.findFirstOrThrow({
      where: { providerId: provider.id, type: CreditTransactionType.OFFER_SPEND },
    });

    expect(offer.creditCost).toBe(COST);
    expect(offer.creditSpentTransactionId).toBe(spend.id);
    expect(spend.referenceId).toBe(offer.id);
    expect(spend.amount).toBe(-COST);
    expect(spend.balanceAfter).toBe(0);
  });
});
