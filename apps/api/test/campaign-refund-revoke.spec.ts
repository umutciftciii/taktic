import { CampaignAuditAction, CampaignStatus, CreditTransactionType, PaymentWebhookEventStatus, type Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LemonSqueezyCheckoutAdapter } from '../src/modules/payments/lemon-squeezy.adapter';
import { MANUAL_REVIEW_REASON } from '../src/modules/payments/payments-webhook.service';
import { CampaignEvaluationWorker } from '../src/modules/campaigns/engine/campaign-evaluation.worker';
import { createCampaignFixture, engineWriteSnapshot, setEngineEnabled, walletInvariant } from './campaign-fixtures';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  currentCreditBalance,
  loginAs,
  offerPayload,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';
import {
  LEMON_BUYER_EMAIL,
  LEMON_BUYER_NAME,
  LEMON_HOSTED_URL,
  LEMON_STORE_ID,
  configureLemonSqueezy,
  deliverLemonWebhook,
  lemonOrderPayload,
  restoreLemonEnv,
  snapshotLemonEnv,
} from './lemon-squeezy-fixtures';

/**
 * CMP-003 S3 — a refunded package takes its promotional credit back.
 *
 * Every scenario runs the real chain: a sandbox checkout, the signed
 * `order_created` delivery that settles it (stage A: PENDING event), the
 * evaluation worker that grants the lot (stage B), and then the signed
 * `order_refunded` delivery. What that last delivery does today — flag the
 * purchase for a person, record the event, answer `manual_review_required` —
 * is kept to the byte; what this slice adds inside the same transaction is
 * the revoke: one CAMPAIGN_REVOKE row for whatever the lot still holds, the
 * lot REVOKED, the redemption REVOKED with the webhook event that did it, the
 * campaign's UTC daily revoke counter moved by one, and — past the running
 * version's threshold — the campaign paused by itself, once.
 */

let ctx: TestContext;
let worker: CampaignEvaluationWorker;
let originalEnv: Record<string, string | undefined>;

beforeAll(async () => {
  ctx = await createTestApp({
    paymentProvider: new LemonSqueezyCheckoutAdapter(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ data: { type: 'checkouts', id: 'checkout-abc-123', attributes: { url: LEMON_HOSTED_URL } } }),
    })),
  });
  worker = ctx.app.get(CampaignEvaluationWorker);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  originalEnv = snapshotLemonEnv();
});

afterEach(() => {
  restoreLemonEnv(originalEnv);
});

const PACKAGE_CREDITS = 25;
const PROMO_CREDITS = 10;

/** One sandbox package for the whole spec, so several providers can buy the same variant. */
async function packageFixture() {
  const suffix = uniqueSuffix();
  const slug = `paket-${suffix}`;
  const creditPackage = await ctx.prisma.offerCreditPackage.create({
    data: { name: `Paket ${suffix}`, slug, creditAmount: PACKAGE_CREDITS, priceAmount: 49900, currency: 'TRY', isActive: true },
  });
  configureLemonSqueezy(slug);
  return creditPackage;
}

/** A discoverable provider (so it can send offers) with an open sandbox checkout. */
async function providerWithPendingPurchase(packageId: string, categoryId: string) {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId });
  const cookie = await loginAs(ctx.prisma, owner.id);
  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/checkout-sessions`)
    .set('Cookie', cookie)
    .send({ packageId })
    .expect(201);
  const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: created.body.purchase.id as string } });
  return { owner, provider, cookie, purchase, reference: purchase.paymentReference!, orderId: `order-${uniqueSuffix()}` };
}

/** Settles the purchase through the webhook and lets the worker grant the lot. */
async function settleAndGrant(fixture: { reference: string; orderId: string; provider: { id: string }; purchase: { id: string } }) {
  await deliverLemonWebhook(ctx, lemonOrderPayload({ reference: fixture.reference, orderId: fixture.orderId })).expect(200);
  const run = await worker.runOnce();
  expect(run.skipped).toBeNull();
  const redemption = await ctx.prisma.campaignRedemption.findFirstOrThrow({
    where: { purchaseId: fixture.purchase.id },
    include: { promoLot: true },
  });
  expect(redemption.status).toBe('GRANTED');
  expect(redemption.promoLot?.status).toBe('ACTIVE');
  expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(PACKAGE_CREDITS + PROMO_CREDITS);
  return redemption;
}

function refund(fixture: { reference: string; orderId: string }, overrides: Record<string, unknown> = {}) {
  return deliverLemonWebhook(ctx, lemonOrderPayload({ reference: fixture.reference, orderId: fixture.orderId, eventName: 'order_refunded', ...overrides }));
}

function ledger(providerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: { providerId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, type: true, amount: true, balanceAfter: true, reason: true, referenceType: true, referenceId: true, createdById: true },
  });
}

async function expectInvariant(providerId: string) {
  const state = await walletInvariant(ctx.prisma, providerId);
  expect(state.sumOfAmounts).toBe(state.balance);
  expect(state.paid).toBeGreaterThanOrEqual(0);
  return state;
}

async function revokeCounter(campaignId: string) {
  const rows = await ctx.prisma.campaignRevokeDailyCounter.findMany({ where: { campaignId } });
  return rows.reduce((total, row) => total + row.revokeCount, 0);
}

async function scenario(options: { maxRevokesPerDay?: number | null; conditions?: Prisma.InputJsonValue[]; credits?: number } = {}) {
  await setEngineEnabled(ctx.prisma, true);
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 4 });
  const creditPackage = await packageFixture();
  const { campaign, version } = await createCampaignFixture(ctx.prisma, {
    trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
    credits: options.credits ?? PROMO_CREDITS,
    maxRedemptionsPerProvider: 5,
    conditions: options.conditions ?? [],
  });
  if (options.maxRevokesPerDay !== undefined) {
    await ctx.prisma.campaignVersion.update({ where: { id: version.id }, data: { maxRevokesPerDay: options.maxRevokesPerDay } });
  }
  return { category, creditPackage, campaign, version };
}

describe('a refunded package revokes its promo lot inside the reversal transaction', () => {
  it('takes the whole unspent lot back with one CAMPAIGN_REVOKE row and keeps the manual-review flag exactly as before', async () => {
    const { category, creditPackage, campaign } = await scenario();
    const fixture = await providerWithPendingPurchase(creditPackage.id, category.id);
    const redemption = await settleAndGrant(fixture);

    const response = await refund(fixture).expect(200);
    expect(response.body).toEqual({ status: 'manual_review_required' });

    // Today's behaviour, byte for byte: flagged, still PAID, event recorded.
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchase.id } });
    expect(purchase.status).toBe('PAID');
    expect(purchase.manualReviewReason).toBe(MANUAL_REVIEW_REASON);
    expect(purchase.manualReviewAt).not.toBeNull();
    const webhookEvent = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({ where: { status: PaymentWebhookEventStatus.MANUAL_REVIEW_REQUIRED } });
    expect(webhookEvent.purchaseId).toBe(fixture.purchase.id);

    // The revoke, in the same commit.
    const rows = await ledger(fixture.provider.id);
    expect(rows.map((row) => [row.type, row.amount, row.balanceAfter])).toEqual([
      ['PACKAGE_PURCHASE', PACKAGE_CREDITS, PACKAGE_CREDITS],
      ['CAMPAIGN_GRANT', PROMO_CREDITS, PACKAGE_CREDITS + PROMO_CREDITS],
      ['CAMPAIGN_REVOKE', -PROMO_CREDITS, PACKAGE_CREDITS],
    ]);
    const revokeRow = rows[2]!;
    expect(revokeRow).toMatchObject({ reason: 'PROMO_LOT_REVOKED:PAYMENT_REVERSED', referenceType: 'PromoCreditLot', referenceId: redemption.promoLot!.id, createdById: null });

    const lot = await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: redemption.promoLot!.id } });
    expect(lot).toMatchObject({ status: 'REVOKED', remainingCredits: 0, revokeTransactionId: revokeRow.id });
    const after = await ctx.prisma.campaignRedemption.findUniqueOrThrow({ where: { id: redemption.id } });
    expect(after).toMatchObject({
      status: 'REVOKED',
      revokeReason: 'PAYMENT_REVERSED',
      spentAtRevoke: 0,
      revokedById: null,
      revokeNote: null,
      revokedByWebhookEventId: webhookEvent.id,
    });
    expect(after.revokedAt).not.toBeNull();
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(PACKAGE_CREDITS);
    expect(await revokeCounter(campaign.id)).toBe(1);
    // Cumulative campaign counters are never decremented (CMP-001 §10.2).
    const campaignRow = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(campaignRow).toMatchObject({ status: 'ACTIVE', redemptionCount: 1, budgetConsumedCredits: PROMO_CREDITS });
    expect(await ctx.prisma.campaignAuditLog.count({ where: { campaignId: campaign.id } })).toBe(0);
    await expectInvariant(fixture.provider.id);
  });

  it('takes back only what is left of a partly spent lot and records what was spent — no debt, no negative balance', async () => {
    const { category, creditPackage } = await scenario();
    const fixture = await providerWithPendingPurchase(creditPackage.id, category.id);
    const redemption = await settleAndGrant(fixture);

    // A real offer spends 4 credits: the earliest-expiring promo lot pays first (S2B1).
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    await request(ctx.server)
      .post(`/providers/${fixture.provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', fixture.cookie)
      .send(offerPayload())
      .expect(201);
    expect((await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: redemption.promoLot!.id } })).remainingCredits).toBe(PROMO_CREDITS - 4);

    await refund(fixture).expect(200);

    const rows = await ledger(fixture.provider.id);
    expect(rows.map((row) => [row.type, row.amount, row.balanceAfter])).toEqual([
      ['PACKAGE_PURCHASE', PACKAGE_CREDITS, PACKAGE_CREDITS],
      ['CAMPAIGN_GRANT', PROMO_CREDITS, PACKAGE_CREDITS + PROMO_CREDITS],
      ['OFFER_SPEND', -4, PACKAGE_CREDITS + PROMO_CREDITS - 4],
      ['CAMPAIGN_REVOKE', -(PROMO_CREDITS - 4), PACKAGE_CREDITS],
    ]);
    const after = await ctx.prisma.campaignRedemption.findUniqueOrThrow({ where: { id: redemption.id } });
    expect(after).toMatchObject({ status: 'REVOKED', spentAtRevoke: 4 });
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(PACKAGE_CREDITS);
    const state = await expectInvariant(fixture.provider.id);
    expect(state.paid).toBe(PACKAGE_CREDITS);
    expect(state.promoInWallet).toBe(0);
  });

  it('produces one financial outcome however often the refund is redelivered, and under a second reversal event for the same order', async () => {
    const { category, creditPackage, campaign } = await scenario();
    const fixture = await providerWithPendingPurchase(creditPackage.id, category.id);
    await settleAndGrant(fixture);

    await refund(fixture).expect(200);
    const again = await refund(fixture).expect(200);
    expect(again.body).toEqual({ status: 'duplicate' });
    const otherEvent = await refund(fixture, { eventName: 'subscription_payment_refunded' }).expect(200);
    expect(otherEvent.body).toEqual({ status: 'manual_review_required' });
    const [first, second, third] = await Promise.all([refund(fixture), refund(fixture), refund(fixture)]);
    for (const response of [first, second, third]) {
      expect(response.status).toBe(200);
    }

    const rows = await ledger(fixture.provider.id);
    expect(rows.filter((row) => row.type === CreditTransactionType.CAMPAIGN_REVOKE)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(PACKAGE_CREDITS);
    expect(await revokeCounter(campaign.id)).toBe(1);
    expect(await ctx.prisma.campaignAuditLog.count({ where: { campaignId: campaign.id } })).toBe(0);
    expect(await ctx.prisma.paymentWebhookEvent.count({ where: { status: PaymentWebhookEventStatus.MANUAL_REVIEW_REQUIRED } })).toBe(2);
    await expectInvariant(fixture.provider.id);
  });

  it('revokes a lot granted earlier even though the engine switch has since been turned off', async () => {
    const { category, creditPackage, campaign } = await scenario();
    const fixture = await providerWithPendingPurchase(creditPackage.id, category.id);
    const redemption = await settleAndGrant(fixture);
    await setEngineEnabled(ctx.prisma, false);

    await refund(fixture).expect(200);

    expect((await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: redemption.promoLot!.id } })).status).toBe('REVOKED');
    expect((await ledger(fixture.provider.id)).filter((row) => row.type === 'CAMPAIGN_REVOKE')).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(PACKAGE_CREDITS);
    expect(await revokeCounter(campaign.id)).toBe(1);
    // The switch still guards *new* entitlement: the worker claims nothing.
    expect((await worker.runOnce()).skipped).toBe('ENGINE_DISABLED');
    await expectInvariant(fixture.provider.id);
  });

  it('leaves a refund of a package that earned no promo exactly as it is today', async () => {
    // Engine off, no campaign: the pre-CMP-003 world.
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 4 });
    const creditPackage = await packageFixture();
    const fixture = await providerWithPendingPurchase(creditPackage.id, category.id);
    await deliverLemonWebhook(ctx, lemonOrderPayload({ reference: fixture.reference, orderId: fixture.orderId })).expect(200);
    const before = await engineWriteSnapshot(ctx.prisma);

    const response = await refund(fixture).expect(200);
    expect(response.body).toEqual({ status: 'manual_review_required' });

    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchase.id } });
    expect(purchase.status).toBe('PAID');
    expect(purchase.manualReviewReason).toBe(MANUAL_REVIEW_REASON);
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(PACKAGE_CREDITS);
    expect((await ledger(fixture.provider.id)).map((row) => row.type)).toEqual(['PACKAGE_PURCHASE']);
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(before);
    expect(await ctx.prisma.campaignRevokeDailyCounter.count()).toBe(0);
  });

  it('revokes nothing on a delivery that is unsigned, from another store, live-mode, for another order, or for no purchase', async () => {
    const { category, creditPackage, campaign } = await scenario();
    const fixture = await providerWithPendingPurchase(creditPackage.id, category.id);
    const redemption = await settleAndGrant(fixture);
    const before = await engineWriteSnapshot(ctx.prisma);
    const ledgerBefore = await ledger(fixture.provider.id);

    await refund(fixture, {}).set('x-signature', 'a'.repeat(64)).expect(401);
    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(1);

    const otherStore = await refund(fixture, { storeId: Number(LEMON_STORE_ID) + 1, orderId: 'order-other-store' }).expect(200);
    const liveMode = await refund(fixture, { testMode: false, orderId: 'order-live' }).expect(200);
    const otherOrder = await refund(fixture, { orderId: 'order-someone-elses' }).expect(200);
    const noPurchase = await refund({ reference: `unknown${uniqueSuffix()}unknownunknown`, orderId: 'order-unknown' }).expect(200);
    for (const response of [otherStore, liveMode, otherOrder, noPurchase]) {
      // The flag path answers as it always has; only the revoke is withheld.
      expect(response.body).toEqual({ status: 'manual_review_required' });
    }

    expect((await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: redemption.promoLot!.id } })).status).toBe('ACTIVE');
    expect(await ledger(fixture.provider.id)).toEqual(ledgerBefore);
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(before);
    expect(await revokeCounter(campaign.id)).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(PACKAGE_CREDITS + PROMO_CREDITS);
  });

  it('stores no buyer detail, secret or payload on the revoke trail', async () => {
    const { category, creditPackage } = await scenario();
    const fixture = await providerWithPendingPurchase(creditPackage.id, category.id);
    await settleAndGrant(fixture);
    await refund(fixture).expect(200);

    const written = JSON.stringify({
      redemptions: await ctx.prisma.campaignRedemption.findMany(),
      lots: await ctx.prisma.promoCreditLot.findMany(),
      ledger: await ctx.prisma.providerCreditTransaction.findMany(),
      counters: await ctx.prisma.campaignRevokeDailyCounter.findMany(),
      audit: await ctx.prisma.campaignAuditLog.findMany(),
    });
    for (const forbidden of [LEMON_BUYER_NAME, LEMON_BUYER_EMAIL, fixture.reference, 'placeholder-webhook-secret']) {
      expect(written).not.toContain(forbidden);
    }
  });
});

describe('the daily revoke threshold pauses the campaign by itself', () => {
  it('stays ACTIVE up to the threshold, pauses once when it is exceeded, and keeps revoking afterwards', async () => {
    const { category, creditPackage, campaign, version } = await scenario({ maxRevokesPerDay: 1 });
    const first = await providerWithPendingPurchase(creditPackage.id, category.id);
    const second = await providerWithPendingPurchase(creditPackage.id, category.id);
    const third = await providerWithPendingPurchase(creditPackage.id, category.id);
    await settleAndGrant(first);
    await settleAndGrant(second);
    await settleAndGrant(third);

    await refund(first).expect(200);
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(CampaignStatus.ACTIVE);
    expect(await ctx.prisma.campaignAuditLog.count({ where: { campaignId: campaign.id } })).toBe(0);

    await refund(second).expect(200);
    const paused = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(paused.status).toBe(CampaignStatus.PAUSED);
    expect(paused.activeVersionId).toBe(version.id);
    const audit = await ctx.prisma.campaignAuditLog.findMany({ where: { campaignId: campaign.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: CampaignAuditAction.AUTO_PAUSED,
      campaignVersionId: version.id,
      actorId: campaign.createdById,
      summary: {
        reason: 'REVOKE_THRESHOLD_EXCEEDED',
        actorKind: 'SYSTEM',
        source: 'PAYMENT_REVERSED',
        revokeCount: 2,
        maxRevokesPerDay: 1,
        versionNumber: 1,
      },
    });
    expect(JSON.stringify(audit[0]!.summary)).not.toContain(LEMON_BUYER_EMAIL);

    // Already paused: the third revoke still runs, the counter still moves, no second pause row.
    await refund(third).expect(200);
    expect(await revokeCounter(campaign.id)).toBe(3);
    expect(await ctx.prisma.campaignAuditLog.count({ where: { campaignId: campaign.id, action: CampaignAuditAction.AUTO_PAUSED } })).toBe(1);
    for (const fixture of [first, second, third]) {
      expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(PACKAGE_CREDITS);
      await expectInvariant(fixture.provider.id);
    }

    // Paused means paused for new entitlement: a fresh payment event is logged CAMPAIGN_PAUSED, nothing granted.
    const fourth = await providerWithPendingPurchase(creditPackage.id, category.id);
    await deliverLemonWebhook(ctx, lemonOrderPayload({ reference: fourth.reference, orderId: fourth.orderId })).expect(200);
    const run = await worker.runOnce();
    expect(run.outcomes.map((entry) => entry.outcome)).toEqual(['EVALUATED']);
    expect(await ctx.prisma.campaignEvaluationLog.count({ where: { campaignId: campaign.id, outcome: 'CAMPAIGN_PAUSED' } })).toBe(1);
    expect(await ctx.prisma.campaignRedemption.count({ where: { purchaseId: fourth.purchase.id } })).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, fourth.provider.id)).toBe(PACKAGE_CREDITS);
  });

  it('counts concurrent revokes exactly and writes exactly one AUTO_PAUSED row', async () => {
    const { category, creditPackage, campaign } = await scenario({ maxRevokesPerDay: 2 });
    const fixtures = [];
    for (let index = 0; index < 4; index += 1) {
      const fixture = await providerWithPendingPurchase(creditPackage.id, category.id);
      await settleAndGrant(fixture);
      fixtures.push(fixture);
    }

    const responses = await Promise.all(fixtures.map((fixture) => refund(fixture)));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'manual_review_required' });
    }

    expect(await revokeCounter(campaign.id)).toBe(4);
    expect(await ctx.prisma.campaignRedemption.count({ where: { campaignId: campaign.id, status: 'REVOKED' } })).toBe(4);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: 'CAMPAIGN_REVOKE' } })).toBe(4);
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(CampaignStatus.PAUSED);
    expect(await ctx.prisma.campaignAuditLog.count({ where: { campaignId: campaign.id, action: CampaignAuditAction.AUTO_PAUSED } })).toBe(1);
    for (const fixture of fixtures) {
      await expectInvariant(fixture.provider.id);
    }
  });

  it('never pauses a campaign whose running version sets no threshold', async () => {
    const { category, creditPackage, campaign } = await scenario({ maxRevokesPerDay: null });
    const fixtures = [];
    for (let index = 0; index < 3; index += 1) {
      const fixture = await providerWithPendingPurchase(creditPackage.id, category.id);
      await settleAndGrant(fixture);
      fixtures.push(fixture);
    }
    for (const fixture of fixtures) {
      await refund(fixture).expect(200);
    }
    expect(await revokeCounter(campaign.id)).toBe(3);
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(CampaignStatus.ACTIVE);
    expect(await ctx.prisma.campaignAuditLog.count({ where: { campaignId: campaign.id } })).toBe(0);
  });
});

describe('NO_PRIOR_REVOCATION reads the revoke as a fact', () => {
  it('fails only the campaign that names the condition; a campaign without it still grants the same provider', async () => {
    await setEngineEnabled(ctx.prisma, true);
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 4 });
    const creditPackage = await packageFixture();
    const strict = await createCampaignFixture(ctx.prisma, {
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      credits: PROMO_CREDITS,
      maxRedemptionsPerProvider: 5,
      conditions: [{ type: 'NO_PRIOR_REVOCATION' }],
    });
    const fixture = await providerWithPendingPurchase(creditPackage.id, category.id);
    await settleAndGrant(fixture);
    await refund(fixture).expect(200);

    // The same provider buys again: strict refuses on the fact, lenient (fewer credits, so it loses only while strict is eligible) grants.
    const lenient = await createCampaignFixture(ctx.prisma, {
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      credits: 3,
      maxRedemptionsPerProvider: 5,
      createdById: strict.campaign.createdById,
    });
    const again = await request(ctx.server)
      .post(`/providers/${fixture.provider.id}/checkout-sessions`)
      .set('Cookie', fixture.cookie)
      .send({ packageId: creditPackage.id })
      .expect(201);
    const secondPurchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: again.body.purchase.id as string } });
    await deliverLemonWebhook(ctx, lemonOrderPayload({ reference: secondPurchase.paymentReference!, orderId: `order-${uniqueSuffix()}` })).expect(200);
    const run = await worker.runOnce();
    expect(run.outcomes.map((entry) => entry.outcome)).toEqual(['SETTLED']);

    const logs = await ctx.prisma.campaignEvaluationLog.findMany({
      where: { triggerEvent: { purchaseId: secondPurchase.id } },
      select: { campaignId: true, outcome: true, reasonCode: true },
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        { campaignId: strict.campaign.id, outcome: 'CONDITIONS_FAILED', reasonCode: 'NO_PRIOR_REVOCATION' },
        { campaignId: lenient.campaign.id, outcome: 'GRANTED', reasonCode: null },
      ]),
    );
    expect(await ctx.prisma.campaignRedemption.count({ where: { purchaseId: secondPurchase.id, campaignId: lenient.campaign.id, status: 'GRANTED' } })).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(PACKAGE_CREDITS * 2 + 3);
  });
});
