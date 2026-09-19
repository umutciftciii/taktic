import {
  CampaignStatus,
  OfferPackageType,
  PackagePurchaseStatus,
  type Prisma,
  ProviderStatus,
  UserRole,
} from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runSerializable } from '../src/common/serializable-transaction';
import {
  CampaignEngineService,
  type EngineInput,
  type EngineResult,
} from '../src/modules/campaigns/engine/campaign-engine.service';
import { createCampaignFixture, engineWriteSnapshot, setEngineEnabled } from './campaign-fixtures';
import {
  createOfferPackage,
  createProviderProfile,
  createTestApp,
  createUser,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The engine with its switch on — reachable only from here in S2A.
 *
 * What is proven: one event, one settlement (CMP-001 §12); the deterministic
 * order among candidates and the STACK_CONFLICT the losers get; the limit
 * counters consumed by conditional update under a savepoint, so a refused
 * candidate leaves no trace and the next one wins; the eligibility transition
 * granting exactly once whatever the order of the three facts; and, in every
 * scenario, **no ledger row** — the credit ledger is S2B's.
 */

let ctx: TestContext;
let engine: CampaignEngineService;

beforeAll(async () => {
  ctx = await createTestApp();
  engine = ctx.app.get(CampaignEngineService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await setEngineEnabled(ctx.prisma, true);
});

async function providerWithAccount(overrides: { email?: boolean; phone?: boolean; approved?: boolean } = {}) {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  await ctx.prisma.user.update({
    where: { id: owner.id },
    data: {
      emailVerifiedAt: overrides.email ? new Date() : null,
      phoneVerifiedAt: overrides.phone ? new Date() : null,
    },
  });
  const approved = overrides.approved ?? true;
  const provider = await createProviderProfile(ctx.prisma, {
    userId: owner.id,
    status: approved ? ProviderStatus.APPROVED : ProviderStatus.PENDING_REVIEW,
  });
  if (approved) {
    await ctx.prisma.providerProfile.update({ where: { id: provider.id }, data: { approvedAt: new Date() } });
  }
  return { owner, provider };
}

async function paidPurchase(providerId: string, options: { price?: number; type?: OfferPackageType } = {}) {
  const pkg = await createOfferPackage(ctx.prisma, {
    type: options.type ?? OfferPackageType.ONE_TIME_CREDITS,
    creditAmount: 25,
    priceAmount: options.price ?? 100_000,
  });
  return ctx.prisma.packagePurchase.create({
    data: {
      providerId,
      packageId: pkg.id,
      status: PackagePurchaseStatus.PAID,
      creditAmountSnapshot: 25,
      priceAmountSnapshot: pkg.priceAmount,
      packageNameSnapshot: pkg.name,
      paidAt: new Date(),
    },
    include: { package: true },
  });
}

function evaluate(input: EngineInput): Promise<EngineResult> {
  return runSerializable(ctx.prisma, (tx) => engine.evaluate(tx, input), { label: 'test.evaluate' });
}

function approval(providerId: string): EngineInput {
  return { trigger: 'PROVIDER_APPROVED', providerId, approvalTransition: true };
}

function evaluated(result: EngineResult) {
  if (result.outcome !== 'EVALUATED') {
    throw new Error(`expected EVALUATED, got ${result.outcome}`);
  }
  return result;
}

function outcomesByCampaign(result: EngineResult) {
  return Object.fromEntries(
    evaluated(result).evaluations.map((entry) => [entry.campaignId ?? 'none', entry.outcome]),
  );
}

async function logs(where: Prisma.CampaignEvaluationLogWhereInput = {}) {
  return ctx.prisma.campaignEvaluationLog.findMany({
    where,
    orderBy: { evaluatedAt: 'asc' },
    select: { campaignId: true, outcome: true, reasonCode: true, winnerCampaignId: true, fact: true },
  });
}

/** The accounting identities of CMP-001 §10.4, checked after every scenario that grants. */
async function expectCounterInvariants() {
  const campaigns = await ctx.prisma.campaign.findMany({ select: { id: true, redemptionCount: true, budgetConsumedCredits: true } });
  for (const campaign of campaigns) {
    const redemptions = await ctx.prisma.campaignRedemption.findMany({ where: { campaignId: campaign.id }, select: { grantedCredits: true } });
    expect(campaign.redemptionCount).toBe(redemptions.length);
    expect(campaign.budgetConsumedCredits).toBe(redemptions.reduce((sum, row) => sum + row.grantedCredits, 0));
    const perProvider = await ctx.prisma.campaignProviderCounter.aggregate({ where: { campaignId: campaign.id }, _sum: { redemptionCount: true } });
    const perDay = await ctx.prisma.campaignDailyCounter.aggregate({ where: { campaignId: campaign.id }, _sum: { redemptionCount: true } });
    expect(perProvider._sum.redemptionCount ?? 0).toBe(campaign.redemptionCount);
    expect(perDay._sum.redemptionCount ?? 0).toBe(campaign.redemptionCount);
  }
  // Every lot belongs to exactly one GRANTED redemption and mirrors its credits.
  const lots = await ctx.prisma.promoCreditLot.findMany({ include: { redemption: true } });
  for (const lot of lots) {
    expect(lot.grantedCredits).toBe(lot.redemption.grantedCredits);
    expect(lot.remainingCredits).toBe(lot.grantedCredits);
    expect(lot.status).toBe('ACTIVE');
  }
  expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
}

describe('one event, one campaign', () => {
  it('grants once: event, redemption, lot, counters and a GRANTED log — and no ledger row', async () => {
    const { campaign, version } = await createCampaignFixture(ctx.prisma, { credits: 10, expiresInDays: 30 });
    const { provider, owner } = await providerWithAccount();
    const before = Date.now();

    const result = evaluated(await evaluate(approval(provider.id)));

    expect(result.granted).toMatchObject({ campaignId: campaign.id, campaignVersionId: version.id, grantedCredits: 10 });
    expect(result.triggerEventKey).toBe(`PROVIDER_APPROVED:${provider.id}`);

    const event = await ctx.prisma.campaignTriggerEvent.findUniqueOrThrow({ where: { triggerEventKey: result.triggerEventKey } });
    expect(event).toMatchObject({ trigger: 'PROVIDER_APPROVED', providerId: provider.id, purchaseId: null, factSetKey: null, evaluationCount: 1, settledByCampaignId: campaign.id });
    expect(event.settledRedemptionId).toBe(result.granted!.redemptionId);
    expect(event.settledAt).not.toBeNull();

    const redemption = await ctx.prisma.campaignRedemption.findUniqueOrThrow({ where: { id: result.granted!.redemptionId } });
    expect(redemption).toMatchObject({
      campaignId: campaign.id,
      campaignVersionId: version.id,
      providerId: provider.id,
      userId: owner.id,
      trigger: 'PROVIDER_APPROVED',
      triggerEventId: event.id,
      triggerEventKey: event.triggerEventKey,
      status: 'GRANTED',
      grantedCredits: 10,
      grantTransactionId: null,
    });
    expect(redemption.rulesSnapshot).toEqual(version.definition);

    const lot = await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { redemptionId: redemption.id } });
    expect(lot).toMatchObject({ providerId: provider.id, grantedCredits: 10, remainingCredits: 10, status: 'ACTIVE' });
    const thirtyDays = 30 * 86_400_000;
    expect(lot.expiresAt.getTime()).toBeGreaterThanOrEqual(before + thirtyDays - 5_000);
    expect(lot.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + thirtyDays + 5_000);

    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ redemptionCount: 1, budgetConsumedCredits: 10 });
    expect(await ctx.prisma.campaignProviderCounter.findMany({ where: { campaignId: campaign.id } })).toMatchObject([{ providerId: provider.id, redemptionCount: 1 }]);
    expect(await ctx.prisma.campaignDailyCounter.findMany({ where: { campaignId: campaign.id } })).toMatchObject([{ redemptionCount: 1 }]);
    expect(await logs()).toEqual([{ campaignId: campaign.id, outcome: 'GRANTED', reasonCode: null, winnerCampaignId: null, fact: null }]);
    await expectCounterInvariants();
  });

  it('the same event raised again is ALREADY_REDEEMED: evaluationCount moves, nothing else does', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma);
    const { provider } = await providerWithAccount();
    await evaluate(approval(provider.id));
    const after = await engineWriteSnapshot(ctx.prisma);

    const second = evaluated(await evaluate(approval(provider.id)));

    expect(second.granted).toBeNull();
    expect(outcomesByCampaign(second)).toEqual({ [campaign.id]: 'ALREADY_REDEEMED' });
    const event = await ctx.prisma.campaignTriggerEvent.findUniqueOrThrow({ where: { triggerEventKey: second.triggerEventKey } });
    expect(event.evaluationCount).toBe(2);
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual({ ...after, evaluationLogs: after.evaluationLogs + 1 });
    await expectCounterInvariants();
  });

  it('a payment event is keyed by the purchase and carries it on the event and the redemption', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED' });
    const { provider } = await providerWithAccount();
    const purchase = await paidPurchase(provider.id);

    const result = evaluated(await evaluate({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: provider.id, purchaseId: purchase.id }));

    expect(result.granted?.campaignId).toBe(campaign.id);
    expect(result.triggerEventKey).toBe(`PACKAGE_PAYMENT_SUCCEEDED:${purchase.id}`);
    expect((await ctx.prisma.campaignTriggerEvent.findUniqueOrThrow({ where: { triggerEventKey: result.triggerEventKey } })).purchaseId).toBe(purchase.id);
    expect((await ctx.prisma.campaignRedemption.findUniqueOrThrow({ where: { id: result.granted!.redemptionId } })).purchaseId).toBe(purchase.id);
  });

  it('the same provider, a different event and a per-provider limit above one grants again', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', maxRedemptionsPerProvider: 2 });
    const { provider } = await providerWithAccount();
    const first = await paidPurchase(provider.id);
    const second = await paidPurchase(provider.id);

    expect(evaluated(await evaluate({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: provider.id, purchaseId: first.id })).granted).not.toBeNull();
    expect(evaluated(await evaluate({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: provider.id, purchaseId: second.id })).granted).not.toBeNull();

    expect(await ctx.prisma.campaignRedemption.count({ where: { campaignId: campaign.id, providerId: provider.id } })).toBe(2);
    await expectCounterInvariants();
  });
});

describe('candidates, conditions and windows', () => {
  it('writes NO_CANDIDATE when no active campaign matches the trigger', async () => {
    await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED' });
    await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED', status: CampaignStatus.DRAFT });
    const { provider } = await providerWithAccount();

    const result = evaluated(await evaluate(approval(provider.id)));

    expect(result.granted).toBeNull();
    expect(result.evaluations).toEqual([{ campaignId: null, outcome: 'NO_CANDIDATE', reasonCode: null }]);
    expect(await logs()).toEqual([{ campaignId: null, outcome: 'NO_CANDIDATE', reasonCode: null, winnerCampaignId: null, fact: null }]);
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(1);
  });

  it('a PAUSED campaign is logged CAMPAIGN_PAUSED and consumes nothing; DRAFT and ENDED are not evaluated at all', async () => {
    const paused = await createCampaignFixture(ctx.prisma, { status: CampaignStatus.PAUSED });
    await createCampaignFixture(ctx.prisma, { status: CampaignStatus.ENDED });
    await createCampaignFixture(ctx.prisma, { status: CampaignStatus.DRAFT });
    const { provider } = await providerWithAccount();

    const result = evaluated(await evaluate(approval(provider.id)));

    expect(result.granted).toBeNull();
    expect(outcomesByCampaign(result)).toEqual({ [paused.campaign.id]: 'CAMPAIGN_PAUSED' });
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: paused.campaign.id } })).toMatchObject({ redemptionCount: 0, budgetConsumedCredits: 0 });
    expect(await ctx.prisma.campaignProviderCounter.count()).toBe(0);
  });

  it('a window that has not opened, or has closed, is WINDOW_CLOSED', async () => {
    const future = await createCampaignFixture(ctx.prisma, { windowStartAt: new Date(Date.now() + 86_400_000) });
    const past = await createCampaignFixture(ctx.prisma, { windowEndAt: new Date(Date.now() - 86_400_000) });
    const { provider } = await providerWithAccount();

    const result = evaluated(await evaluate(approval(provider.id)));

    expect(result.granted).toBeNull();
    expect(outcomesByCampaign(result)).toEqual({ [future.campaign.id]: 'WINDOW_CLOSED', [past.campaign.id]: 'WINDOW_CLOSED' });
  });

  it('a failed condition is CONDITIONS_FAILED with the condition type as reasonCode, read from canonical facts', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, {
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      conditions: [
        { type: 'PURCHASE_KIND_IN', kinds: ['OFFER_PACKAGE'] },
        { type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' },
        { type: 'MIN_PAID_AMOUNT', minor: 50_000, currency: 'TRY' },
      ],
    });
    const { provider } = await providerWithAccount();
    const cheap = await paidPurchase(provider.id, { price: 40_000 });
    const result = evaluated(await evaluate({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: provider.id, purchaseId: cheap.id }));
    expect(result.granted).toBeNull();
    expect(await logs()).toMatchObject([{ campaignId: campaign.id, outcome: 'CONDITIONS_FAILED', reasonCode: 'MIN_PAID_AMOUNT' }]);

    // A second PAID purchase is no longer the first — even though the first
    // one earned nothing.
    const later = await paidPurchase(provider.id, { price: 100_000 });
    const second = evaluated(await evaluate({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: provider.id, purchaseId: later.id }));
    expect(second.granted).toBeNull();
    expect((await logs()).at(-1)).toMatchObject({ outcome: 'CONDITIONS_FAILED', reasonCode: 'FIRST_SUCCESSFUL_PAID_PURCHASE' });
  });

  it('FIRST_PROVIDER_APPROVAL fails without a genuine transition', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { conditions: [{ type: 'FIRST_PROVIDER_APPROVAL' }] });
    const { provider } = await providerWithAccount();

    const result = evaluated(await evaluate({ trigger: 'PROVIDER_APPROVED', providerId: provider.id, approvalTransition: false }));

    expect(result.granted).toBeNull();
    expect(outcomesByCampaign(result)).toEqual({ [campaign.id]: 'CONDITIONS_FAILED' });
  });
});

describe('exclusive stack among candidates of one event', () => {
  it('orders by credits desc, then priority asc, then campaignId asc; losers get STACK_CONFLICT and keep their counters', async () => {
    const small = await createCampaignFixture(ctx.prisma, { credits: 5, priority: 1 });
    const big = await createCampaignFixture(ctx.prisma, { credits: 10, priority: 100 });
    const { provider } = await providerWithAccount();

    const result = evaluated(await evaluate(approval(provider.id)));

    expect(result.granted?.campaignId).toBe(big.campaign.id);
    expect(outcomesByCampaign(result)).toEqual({ [big.campaign.id]: 'GRANTED', [small.campaign.id]: 'STACK_CONFLICT' });
    expect(await logs({ campaignId: small.campaign.id })).toMatchObject([{ outcome: 'STACK_CONFLICT', winnerCampaignId: big.campaign.id }]);
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: small.campaign.id } })).toMatchObject({ redemptionCount: 0, budgetConsumedCredits: 0 });
    expect(await ctx.prisma.campaignProviderCounter.count({ where: { campaignId: small.campaign.id } })).toBe(0);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(1);
    await expectCounterInvariants();
  });

  it('equal credits: the smaller priority wins; equal priority: the smaller campaignId wins', async () => {
    const a = await createCampaignFixture(ctx.prisma, { credits: 10, priority: 50 });
    const b = await createCampaignFixture(ctx.prisma, { credits: 10, priority: 10 });
    const { provider } = await providerWithAccount();
    expect(evaluated(await evaluate(approval(provider.id))).granted?.campaignId).toBe(b.campaign.id);

    const c = await createCampaignFixture(ctx.prisma, { credits: 10, priority: 10, trigger: 'PACKAGE_PAYMENT_SUCCEEDED' });
    const d = await createCampaignFixture(ctx.prisma, { credits: 10, priority: 10, trigger: 'PACKAGE_PAYMENT_SUCCEEDED' });
    const purchase = await paidPurchase(provider.id);
    const winner = evaluated(await evaluate({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: provider.id, purchaseId: purchase.id })).granted?.campaignId;
    expect(winner).toBe([c.campaign.id, d.campaign.id].sort()[0]);
    expect(a.campaign.id).toBeDefined();
  });

  it('a winner refused by its budget is rolled back to the savepoint and the next candidate wins', async () => {
    const exhausted = await createCampaignFixture(ctx.prisma, { credits: 10, priority: 1, budgetCredits: 15 });
    await ctx.prisma.campaign.update({ where: { id: exhausted.campaign.id }, data: { redemptionCount: 1, budgetConsumedCredits: 10 } });
    const runnerUp = await createCampaignFixture(ctx.prisma, { credits: 5, priority: 1 });
    const { provider } = await providerWithAccount();

    const result = evaluated(await evaluate(approval(provider.id)));

    expect(result.granted?.campaignId).toBe(runnerUp.campaign.id);
    expect(outcomesByCampaign(result)).toEqual({ [exhausted.campaign.id]: 'BUDGET_EXHAUSTED', [runnerUp.campaign.id]: 'GRANTED' });
    // The refused candidate's partial counter increments were undone.
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: exhausted.campaign.id } })).toMatchObject({ redemptionCount: 1, budgetConsumedCredits: 10 });
    expect(await ctx.prisma.campaignProviderCounter.count({ where: { campaignId: exhausted.campaign.id } })).toBe(0);
    expect(await ctx.prisma.campaignDailyCounter.count({ where: { campaignId: exhausted.campaign.id } })).toBe(0);
    const event = await ctx.prisma.campaignTriggerEvent.findUniqueOrThrow({ where: { triggerEventKey: result.triggerEventKey } });
    expect(event.settledByCampaignId).toBe(runnerUp.campaign.id);
  });

  it('once an event is settled, a later candidate gets EVENT_ALREADY_SETTLED and the winner ALREADY_REDEEMED', async () => {
    const winner = await createCampaignFixture(ctx.prisma, { credits: 10 });
    const { provider } = await providerWithAccount();
    await evaluate(approval(provider.id));
    const late = await createCampaignFixture(ctx.prisma, { credits: 100 });

    const result = evaluated(await evaluate(approval(provider.id)));

    expect(result.granted).toBeNull();
    expect(outcomesByCampaign(result)).toEqual({ [winner.campaign.id]: 'ALREADY_REDEEMED', [late.campaign.id]: 'EVENT_ALREADY_SETTLED' });
    expect(await logs({ campaignId: late.campaign.id })).toMatchObject([{ outcome: 'EVENT_ALREADY_SETTLED', winnerCampaignId: winner.campaign.id }]);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(1);
  });

  it('different events do not block one another: an approval and a payment both grant to the same provider', async () => {
    const k1 = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED', credits: 10 });
    const k2 = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 5 });
    const { provider } = await providerWithAccount();
    const purchase = await paidPurchase(provider.id);

    expect(evaluated(await evaluate(approval(provider.id))).granted?.campaignId).toBe(k1.campaign.id);
    expect(evaluated(await evaluate({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: provider.id, purchaseId: purchase.id })).granted?.campaignId).toBe(k2.campaign.id);
    expect(await ctx.prisma.promoCreditLot.count({ where: { providerId: provider.id } })).toBe(2);
    await expectCounterInvariants();
  });
});

describe('limits', () => {
  it('maxRedemptionsPerProvider: the third event of one provider is PER_PROVIDER_LIMIT', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', maxRedemptionsPerProvider: 2 });
    const { provider } = await providerWithAccount();
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const purchase = await paidPurchase(provider.id);
      outcomes.push(outcomesByCampaign(await evaluate({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: provider.id, purchaseId: purchase.id }))[campaign.id]!);
    }
    expect(outcomes).toEqual(['GRANTED', 'GRANTED', 'PER_PROVIDER_LIMIT']);
    expect(await ctx.prisma.campaignProviderCounter.findFirstOrThrow({ where: { campaignId: campaign.id } })).toMatchObject({ redemptionCount: 2 });
    await expectCounterInvariants();
  });

  it('maxRedemptionsPerDay: the second provider of the day is DAILY_LIMIT', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { maxRedemptionsPerDay: 1 });
    const first = await providerWithAccount();
    const second = await providerWithAccount();
    expect(outcomesByCampaign(await evaluate(approval(first.provider.id)))[campaign.id]).toBe('GRANTED');
    expect(outcomesByCampaign(await evaluate(approval(second.provider.id)))[campaign.id]).toBe('DAILY_LIMIT');
    expect(await ctx.prisma.campaignDailyCounter.findMany({ where: { campaignId: campaign.id } })).toMatchObject([{ redemptionCount: 1 }]);
    await expectCounterInvariants();
  });

  it('maxRedemptionsGlobal: the second redemption ever is GLOBAL_LIMIT', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { maxRedemptionsGlobal: 1 });
    const first = await providerWithAccount();
    const second = await providerWithAccount();
    expect(outcomesByCampaign(await evaluate(approval(first.provider.id)))[campaign.id]).toBe('GRANTED');
    expect(outcomesByCampaign(await evaluate(approval(second.provider.id)))[campaign.id]).toBe('GLOBAL_LIMIT');
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ redemptionCount: 1 });
    await expectCounterInvariants();
  });

  it('budgetCredits: a grant that would overshoot the budget is BUDGET_EXHAUSTED, revoked or not', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { credits: 10, budgetCredits: 25 });
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { provider } = await providerWithAccount();
      outcomes.push(outcomesByCampaign(await evaluate(approval(provider.id)))[campaign.id]!);
    }
    expect(outcomes).toEqual(['GRANTED', 'GRANTED', 'BUDGET_EXHAUSTED']);
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ redemptionCount: 2, budgetConsumedCredits: 20 });
    await expectCounterInvariants();
  });

  it('the last slot under concurrency goes to exactly one transaction', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { maxRedemptionsGlobal: 1 });
    const providers = await Promise.all(Array.from({ length: 4 }, () => providerWithAccount()));
    const arrive = barrier(4);

    const results = await Promise.all(providers.map(({ provider }) => evaluateOverlapping(approval(provider.id), arrive)));

    const granted = results.filter((result) => result.outcome === 'EVALUATED' && result.granted !== null);
    expect(granted).toHaveLength(1);
    expect(await ctx.prisma.campaignRedemption.count({ where: { campaignId: campaign.id } })).toBe(1);
    await expectCounterInvariants();
  });
});

/**
 * Makes N transactions take their snapshot before any of them writes, so the
 * conflict is real rather than avoided by one finishing first. Later arrivals
 * (retries) pass straight through.
 */
function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    await open;
  };
}

/** The retry helper's warnings, so a test can assert that a conflict was met and replayed. */
const retryWarnings: string[] = [];
const recordingLogger = { warn: (message: string) => retryWarnings.push(message), error: () => {} };

function evaluateOverlapping(input: EngineInput, arrive: () => Promise<void>): Promise<EngineResult> {
  return runSerializable(
    ctx.prisma,
    async (tx) => {
      await tx.operationsSettings.findUnique({ where: { id: 'singleton' } }); // snapshot taken here
      await arrive();
      return engine.evaluate(tx, input);
    },
    { label: 'test.evaluate.overlapping', logger: recordingLogger },
  );
}

describe('concurrency on one event', () => {
  it('two overlapping transactions raising the same event produce one redemption', async () => {
    await createCampaignFixture(ctx.prisma);
    const { provider } = await providerWithAccount();
    const arrive = barrier(2);
    retryWarnings.length = 0;

    const results = await Promise.all([
      evaluateOverlapping(approval(provider.id), arrive),
      evaluateOverlapping(approval(provider.id), arrive),
    ]);

    const grants = results.filter((result) => result.outcome === 'EVALUATED' && result.granted !== null);
    expect(grants).toHaveLength(1);
    const other = results.find((result) => result.outcome === 'EVALUATED' && result.granted === null);
    expect(other && outcomesByCampaign(other)).toEqual({ [(await ctx.prisma.campaign.findFirstOrThrow()).id]: 'ALREADY_REDEEMED' });
    expect(await ctx.prisma.campaignRedemption.count()).toBe(1);
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(1);
    expect((await ctx.prisma.campaignTriggerEvent.findFirstOrThrow()).evaluationCount).toBe(2);
    // The loser could not have seen the winner's rows from its own snapshot:
    // it met the conflict, was rolled back whole, and replayed.
    expect(retryWarnings.some((message) => /write conflict on attempt 1/.test(message))).toBe(true);
    await expectCounterInvariants();
  });
});

describe('eligibility transition through onProviderFact', () => {
  const FACTS = ['PROVIDER_APPROVED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED'] as const;

  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
      permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
    );
  }

  async function writeFact(providerId: string, userId: string, fact: (typeof FACTS)[number]) {
    if (fact === 'PROVIDER_APPROVED') {
      await ctx.prisma.providerProfile.update({ where: { id: providerId }, data: { status: ProviderStatus.APPROVED, approvedAt: new Date() } });
    } else {
      await ctx.prisma.user.update({
        where: { id: userId },
        data: fact === 'EMAIL_VERIFIED' ? { emailVerifiedAt: new Date() } : { phoneVerifiedAt: new Date() },
      });
    }
  }

  it.each(permutations(FACTS).map((order) => [order.join(' → '), order]))(
    'grants exactly once when the facts complete in the order %s',
    async (_label, order) => {
      const { campaign } = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: [...FACTS] });
      const { provider, owner } = await providerWithAccount({ approved: false });
      const outcomes: string[] = [];

      for (const fact of order) {
        await writeFact(provider.id, owner.id, fact);
        const result = await runSerializable(ctx.prisma, (tx) => engine.onProviderFact(tx, provider.id, fact), { label: 'test.fact' });
        outcomes.push(result.outcome);
      }

      expect(outcomes).toEqual(['ELIGIBILITY_INCOMPLETE', 'ELIGIBILITY_INCOMPLETE', 'EVALUATED']);
      const redemptions = await ctx.prisma.campaignRedemption.findMany({ where: { campaignId: campaign.id } });
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0]!.triggerEventKey).toBe(`PROVIDER_ELIGIBILITY_REACHED:EMAIL_VERIFIED+PHONE_VERIFIED+PROVIDER_APPROVED:${provider.id}`);
      // No event exists for the two incomplete writes.
      expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(1);
      expect((await logs()).map((row) => row.fact)).toEqual([order[2]]);

      // Re-writing the last fact (an approval after suspension, a proof written again) grants nothing more.
      const again = await runSerializable(ctx.prisma, (tx) => engine.onProviderFact(tx, provider.id, order[2]!), { label: 'test.fact' });
      expect(again.outcome).toBe('EVALUATED');
      expect(await ctx.prisma.campaignRedemption.count()).toBe(1);
      await expectCounterInvariants();
    },
  );

  it('a fact no active campaign asks about is NO_FACT_SET and writes nothing', async () => {
    await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED' });
    await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: ['PROVIDER_APPROVED', 'EMAIL_VERIFIED'], status: CampaignStatus.DRAFT });
    const { provider } = await providerWithAccount({ email: true, phone: true });
    const before = await engineWriteSnapshot(ctx.prisma);

    const result = await ctx.prisma.$transaction((tx) => engine.onProviderFact(tx, provider.id, 'EMAIL_VERIFIED'));

    expect(result.outcome).toBe('NO_FACT_SET');
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(before);
  });

  it('a guest application (no account) never completes an account-proof fact set', async () => {
    await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: ['PROVIDER_APPROVED', 'EMAIL_VERIFIED'] });
    const guest = await createProviderProfile(ctx.prisma, { userId: null, status: ProviderStatus.APPROVED });

    const result = await ctx.prisma.$transaction((tx) => engine.onProviderFact(tx, guest.id, 'PROVIDER_APPROVED'));

    expect(result.outcome).toBe('ELIGIBILITY_INCOMPLETE');
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(0);
  });

  it('two fact sets sharing a fact are each evaluated as their own event', async () => {
    const two = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: ['PROVIDER_APPROVED', 'EMAIL_VERIFIED'], credits: 5 });
    const three = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: [...FACTS], credits: 10 });
    const { provider } = await providerWithAccount({ email: true, phone: true });

    const result = await runSerializable(ctx.prisma, (tx) => engine.onProviderFact(tx, provider.id, 'PROVIDER_APPROVED'), { label: 'test.fact' });

    expect(result.outcome).toBe('EVALUATED');
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(2);
    expect(await ctx.prisma.campaignRedemption.count({ where: { campaignId: two.campaign.id } })).toBe(1);
    expect(await ctx.prisma.campaignRedemption.count({ where: { campaignId: three.campaign.id } })).toBe(1);
    await expectCounterInvariants();
  });
});

describe('failure containment', () => {
  it('an unexpected error undoes only the engine and leaves the caller transaction alive', async () => {
    const { campaign, version } = await createCampaignFixture(ctx.prisma);
    // A definition the validator would never have stored: the evaluator refuses it.
    await ctx.prisma.campaignVersion.update({
      where: { id: version.id },
      data: { definition: { ...(version.definition as object), conditions: { all: [{ type: 'NOT_A_CONDITION' }] } } as Prisma.InputJsonValue },
    });
    const { provider } = await providerWithAccount();

    const result = await ctx.prisma.$transaction(async (tx) => {
      await tx.providerProfile.update({ where: { id: provider.id }, data: { moderationNote: 'caller write' } });
      const engineResult = await engine.evaluate(tx, approval(provider.id));
      await tx.providerProfile.update({ where: { id: provider.id }, data: { addressNote: 'after engine' } });
      return engineResult;
    });

    expect(result.outcome).toBe('ENGINE_ERROR');
    const profile = await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } });
    expect(profile.moderationNote).toBe('caller write');
    expect(profile.addressNote).toBe('after engine');
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(0);
    expect(await ctx.prisma.campaignEvaluationLog.count()).toBe(0);
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ redemptionCount: 0 });
  });
});
