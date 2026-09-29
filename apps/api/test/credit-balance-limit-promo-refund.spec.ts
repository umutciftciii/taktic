import { CreditTransactionType, OfferStatus, ProviderStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDIT_LEDGER_INTEGER_MAX } from '../src/common/credit-limits';
import { runSerializable } from '../src/common/serializable-transaction';
import { CampaignEngineHooks } from '../src/modules/campaigns/engine/campaign-engine.hooks';
import { CampaignEngineService, type EngineResult } from '../src/modules/campaigns/engine/campaign-engine.service';
import { CampaignEvaluationWorker } from '../src/modules/campaigns/engine/campaign-evaluation.worker';
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';
import { createCampaignFixture, setEngineEnabled } from './campaign-fixtures';
import {
  backdateOfferSubmission,
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createProviderProfile,
  createTestApp,
  createUser,
  currentCreditBalance,
  declareBusinessRegistration,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * API-HARDENING-001 follow-up: the ledger's integer bound on the two positive,
 * non-manual writers PR #124 first left alone — the campaign engine's promo
 * grant (`grantPromoCreditLot`) and the offer refund (`OFFER_REFUND`).
 *
 * | writer                  | contract at max + 1                                        |
 * | ----------------------- | ---------------------------------------------------------- |
 * | promo grant (engine)    | candidate refused `CREDIT_BALANCE_LIMIT` inside its         |
 * |                         | savepoint: no counter, redemption, lot or ledger row; the   |
 * |                         | event is EVALUATED, not retried                             |
 * | refund worker           | offer SKIPPED `CREDIT_BALANCE_LIMIT_EXCEEDED`, still        |
 * |                         | eligible; a later scan refunds it once there is room        |
 * | manual / removal / cancel | 400 `CREDIT_BALANCE_LIMIT_EXCEEDED`, whole transaction     |
 * |                         | rolled back                                                 |
 *
 * Valid movements are unchanged: the exact bound is accepted everywhere.
 */
let ctx: TestContext;
const MAX = CREDIT_LEDGER_INTEGER_MAX;
const LIMIT_CODE = 'CREDIT_BALANCE_LIMIT_EXCEEDED';

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

async function setBalance(providerId: string, balance: number) {
  const current = await currentCreditBalance(ctx.prisma, providerId);
  if (balance !== current) {
    await grantCredits(ctx.prisma, providerId, balance - current);
  }
}

async function ledgerCount(type: CreditTransactionType) {
  return ctx.prisma.providerCreditTransaction.count({ where: { type } });
}

describe('the campaign promo grant', () => {
  let engine: CampaignEngineService;
  let worker: CampaignEvaluationWorker;
  let hooks: CampaignEngineHooks;

  beforeAll(() => {
    engine = ctx.app.get(CampaignEngineService);
    worker = ctx.app.get(CampaignEvaluationWorker);
    hooks = ctx.app.get(CampaignEngineHooks);
  });

  beforeEach(async () => {
    await setEngineEnabled(ctx.prisma, true);
  });

  async function approvedProvider() {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await ctx.prisma.user.update({
      where: { id: owner.id },
      data: { emailVerifiedAt: new Date(), phoneVerifiedAt: new Date() },
    });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status: ProviderStatus.APPROVED });
    await ctx.prisma.providerProfile.update({ where: { id: provider.id }, data: { approvedAt: new Date() } });
    await declareBusinessRegistration(ctx.prisma, provider.id);
    return provider;
  }

  const evaluate = (providerId: string) =>
    runSerializable(
      ctx.prisma,
      (tx) => engine.evaluate(tx, { trigger: 'PROVIDER_APPROVED', providerId, approvalTransition: true }),
      { label: 'test.evaluate' },
    );

  function outcomes(result: EngineResult) {
    if (result.outcome !== 'EVALUATED') throw new Error(`expected EVALUATED, got ${result.outcome}`);
    return result.evaluations.map((entry) => entry.outcome);
  }

  async function nothingGranted(campaignId: string) {
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect(await ctx.prisma.promoCreditLot.count()).toBe(0);
    expect(await ledgerCount(CreditTransactionType.CAMPAIGN_GRANT)).toBe(0);
    const campaign = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign).toMatchObject({ redemptionCount: 0, budgetConsumedCredits: 0 });
    expect(await ctx.prisma.campaignProviderCounter.count()).toBe(0);
    expect(await ctx.prisma.campaignDailyCounter.count()).toBe(0);
  }

  it('grants a promotion that lands exactly on the bound', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { credits: 10 });
    const provider = await approvedProvider();
    await setBalance(provider.id, MAX - 10);

    const result = await evaluate(provider.id);

    expect(outcomes(result)).toEqual(['GRANTED']);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(MAX);
    expect(await ctx.prisma.campaignRedemption.count({ where: { campaignId: campaign.id } })).toBe(1);
  });

  it('refuses one past the bound as an outcome, leaving nothing consumed or written', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { credits: 10 });
    const provider = await approvedProvider();
    await setBalance(provider.id, MAX - 9);

    const result = await evaluate(provider.id);

    expect(outcomes(result)).toEqual(['CREDIT_BALANCE_LIMIT']);
    await nothingGranted(campaign.id);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(MAX - 9);
    const log = await ctx.prisma.campaignEvaluationLog.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(log.outcome).toBe('CREDIT_BALANCE_LIMIT');
  });

  it('through the worker: the event is evaluated once, not retried, and a later raise grants exactly once', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { credits: 10 });
    const provider = await approvedProvider();
    await setBalance(provider.id, MAX - 9);
    await runSerializable(ctx.prisma, (tx) => hooks.providerApproved(tx, provider.id), { label: 'test.hook' });

    const first = await worker.runOnce();

    expect(first.claimed).toBe(1);
    const event = await ctx.prisma.campaignTriggerEvent.findFirstOrThrow({ where: { providerId: provider.id } });
    expect(event.status).toBe('EVALUATED');
    await nothingGranted(campaign.id);
    // Not parked for a retry into the same refusal.
    expect((await worker.runOnce()).claimed).toBe(0);

    // Room appears; a fresh evaluation of the same event grants once, and a
    // third finds it settled.
    await grantCredits(ctx.prisma, provider.id, -1);
    expect(outcomes(await evaluate(provider.id))).toEqual(['GRANTED']);
    expect(outcomes(await evaluate(provider.id))).toEqual(['ALREADY_REDEEMED']);
    expect(await ctx.prisma.promoCreditLot.count()).toBe(1);
    expect(await ledgerCount(CreditTransactionType.CAMPAIGN_GRANT)).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(MAX);
  });

  it('lets the next candidate that fits win when a bigger one does not', async () => {
    const big = await createCampaignFixture(ctx.prisma, { credits: 10 });
    const small = await createCampaignFixture(ctx.prisma, { credits: 3 });
    const provider = await approvedProvider();
    await setBalance(provider.id, MAX - 5);

    const result = await evaluate(provider.id);

    if (result.outcome !== 'EVALUATED') throw new Error('expected EVALUATED');
    const byCampaign = Object.fromEntries(result.evaluations.map((entry) => [entry.campaignId, entry.outcome]));
    expect(byCampaign[big.campaign.id]).toBe('CREDIT_BALANCE_LIMIT');
    expect(byCampaign[small.campaign.id]).toBe('GRANTED');
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(MAX - 2);
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: big.campaign.id } })).redemptionCount).toBe(0);
  });
});

describe('the offer credit refund', () => {
  const COST = 2;

  async function spentOffer() {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: COST });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id });
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
    await grantCredits(ctx.prisma, provider.id, 10);
    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', await loginAs(ctx.prisma, owner.id))
      .send(offerPayload())
      .expect(201);
    return {
      provider,
      category,
      serviceRequest,
      customerCookie: await loginAs(ctx.prisma, customer.id),
      offerId: created.body.id as string,
    };
  }

  const refunds = () => ctx.prisma.providerCreditTransaction.findMany({ where: { type: CreditTransactionType.OFFER_REFUND } });

  async function adminCookie() {
    return loginAs(ctx.prisma, (await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN })).id);
  }

  it('worker: refunds exactly to the bound', async () => {
    const { provider, offerId } = await spentOffer();
    await setBalance(provider.id, MAX - COST);
    await backdateOfferSubmission(ctx.prisma, offerId, 72);

    const run = await ctx.app.get(UnviewedOfferRefundService).execute();

    expect(run.results).toEqual([expect.objectContaining({ offerId, status: 'REFUNDED' })]);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(MAX);
  });

  it('worker: skips one past the bound with nothing written, then refunds once there is room, and only once', async () => {
    const { provider, offerId } = await spentOffer();
    await setBalance(provider.id, MAX - COST + 1);
    await backdateOfferSubmission(ctx.prisma, offerId, 72);
    const refundWorker = ctx.app.get(UnviewedOfferRefundService);

    const skipped = await refundWorker.execute();

    expect(skipped.results).toEqual([{ offerId, status: 'SKIPPED', reason: LIMIT_CODE }]);
    expect(skipped.refunded).toBe(0);
    expect(await refunds()).toHaveLength(0);
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer).toMatchObject({ creditRefundedTransactionId: null, creditRefundedAt: null });
    // Still a candidate: the same refusal again, not a FAILED.
    expect((await refundWorker.execute()).results[0]).toMatchObject({ status: 'SKIPPED', reason: LIMIT_CODE });

    await grantCredits(ctx.prisma, provider.id, -1);
    const [a, b] = await Promise.all([refundWorker.execute(), refundWorker.execute()]);
    expect([...a.results, ...b.results].filter((result) => result.status === 'REFUNDED')).toHaveLength(1);
    expect(await refunds()).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(MAX);
    expect((await refundWorker.execute()).results).toEqual([]);
  });

  it('manual refund: 400 past the bound, no ledger row and no audit row; accepted at the bound', async () => {
    const { provider, offerId } = await spentOffer();
    const cookie = await adminCookie();
    await setBalance(provider.id, MAX - COST + 1);

    const refused = await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', cookie)
      .send({ reasonCode: 'INVALID_REQUEST' });

    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe(LIMIT_CODE);
    expect(await refunds()).toHaveLength(0);
    expect(await ctx.prisma.manualOfferRefundAudit.count()).toBe(0);

    await grantCredits(ctx.prisma, provider.id, -1);
    const accepted = await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', cookie)
      .send({ reasonCode: 'INVALID_REQUEST' });
    expect(accepted.status).toBe(201);
    expect(accepted.body.balance).toBe(MAX);
    // A repeat is the ordinary "already refunded", not a second row.
    const again = await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', cookie)
      .send({ reasonCode: 'INVALID_REQUEST' });
    expect(again.status).toBe(409);
    expect(await refunds()).toHaveLength(1);
  });

  it('request removal: refused whole — the request stays APPROVED and the offer live', async () => {
    const { provider, serviceRequest, offerId } = await spentOffer();
    await setBalance(provider.id, MAX - COST + 1);

    const response = await request(ctx.server)
      .patch(`/service-requests/${serviceRequest.id}/status`)
      .set('Cookie', await adminCookie())
      .send({ status: 'REJECTED', rejectionReason: 'Sahte talep' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe(LIMIT_CODE);
    expect((await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: serviceRequest.id } })).status).toBe(
      ServiceRequestStatus.APPROVED,
    );
    expect((await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).status).toBe(OfferStatus.SUBMITTED);
    expect(await refunds()).toHaveLength(0);
  });

  it("customer cancel: refused whole; once there is room it cancels and refunds once", async () => {
    const { provider, serviceRequest, customerCookie, offerId } = await spentOffer();
    await setBalance(provider.id, MAX - COST + 1);

    const refused = await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/cancel`)
      .set('Cookie', customerCookie)
      .send({});

    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe(LIMIT_CODE);
    expect((await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: serviceRequest.id } })).status).toBe(
      ServiceRequestStatus.APPROVED,
    );
    expect(await ctx.prisma.serviceRequestCancellation.count()).toBe(0);
    expect(await refunds()).toHaveLength(0);

    await grantCredits(ctx.prisma, provider.id, -1);
    await request(ctx.server).post(`/service-requests/${serviceRequest.id}/cancel`).set('Cookie', customerCookie).send({}).expect(201);
    expect(await refunds()).toHaveLength(1);
    expect((await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).status).toBe(OfferStatus.CANCELLED);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(MAX);
  });
});
