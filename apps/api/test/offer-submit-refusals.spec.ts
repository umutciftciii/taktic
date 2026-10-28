import { CreditTransactionType, MatchRoundStatus, UserRole } from '@prisma/client';
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
} from './harness';

/**
 * RELEASE-GAP-001 G-07: the refusals the provider's offer form turns into a
 * sentence. The web reads them by status and `code`; this file pins that
 * contract, and that none of them spends a credit or leaves an offer behind.
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

const CATEGORY_COST = 2;

async function fixture(options: { credits?: number } = {}) {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
  const cookie = await loginAs(ctx.prisma, owner.id);
  if (options.credits) {
    await grantCredits(ctx.prisma, provider.id, options.credits);
  }

  return { category, serviceRequest, provider, cookie };
}

const submit = (providerId: string, requestId: string, cookie: string, body = offerPayload()) =>
  request(ctx.server)
    .post(`/providers/${providerId}/requests/${requestId}/offers`)
    .set('Cookie', cookie)
    .send(body);

const spends = () =>
  ctx.prisma.providerCreditTransaction.count({ where: { type: CreditTransactionType.OFFER_SPEND } });

describe('offer submit refusals', () => {
  it('a second offer in the same round: 409 OFFER_ALREADY_SUBMITTED, one spend', async () => {
    const { serviceRequest, provider, cookie } = await fixture({ credits: 10 });
    await submit(provider.id, serviceRequest.id, cookie).expect(201);

    const again = await submit(provider.id, serviceRequest.id, cookie);

    expect(again.status).toBe(409);
    expect(again.body.code).toBe('OFFER_ALREADY_SUBMITTED');
    expect(await ctx.prisma.offer.count()).toBe(1);
    expect(await spends()).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(10 - CATEGORY_COST);
  });

  it('not enough credit: 402, no offer, no spend', async () => {
    const { serviceRequest, provider, cookie } = await fixture({ credits: 1 });

    const refused = await submit(provider.id, serviceRequest.id, cookie);

    expect(refused.status).toBe(402);
    expect(await ctx.prisma.offer.count()).toBe(0);
    expect(await spends()).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(1);
  });

  it('a request that is no longer open to the provider: 404, no offer, no spend', async () => {
    const { serviceRequest, provider, cookie } = await fixture({ credits: 10 });
    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    const refused = await submit(provider.id, serviceRequest.id, cookie);

    expect(refused.status).toBe(404);
    expect(await ctx.prisma.offer.count()).toBe(0);
    expect(await spends()).toBe(0);
  });

  it('a request whose round is no longer open: 409 OFFER_ROUND_CLOSED, no offer, no spend', async () => {
    const { serviceRequest, provider, cookie } = await fixture({ credits: 10 });
    const { currentRoundId } = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
      select: { currentRoundId: true },
    });
    // A request and a round that disagree: the request still APPROVED, its
    // round already expired. The service refuses before anything is written.
    await ctx.prisma.serviceRequestMatchRound.update({
      where: { id: currentRoundId },
      data: { status: MatchRoundStatus.EXPIRED, expiredAt: new Date() },
    });

    const refused = await submit(provider.id, serviceRequest.id, cookie);

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('OFFER_ROUND_CLOSED');
    expect(await ctx.prisma.offer.count()).toBe(0);
    expect(await spends()).toBe(0);
  });

  it('an invalid offer body: 400, no offer, no spend', async () => {
    const { serviceRequest, provider, cookie } = await fixture({ credits: 10 });

    const refused = await submit(provider.id, serviceRequest.id, cookie, { ...offerPayload(), priceAmount: 50 });

    expect(refused.status).toBe(400);
    expect(await ctx.prisma.offer.count()).toBe(0);
    expect(await spends()).toBe(0);
  });
});
