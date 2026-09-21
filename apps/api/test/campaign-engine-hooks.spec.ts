import {
  CampaignStatus,
  CreditTransactionType,
  OfferPackageType,
  PackagePurchaseStatus,
  PaymentWebhookEventStatus,
  type Prisma,
  ProviderStatus,
  UserRole,
} from '@prisma/client';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LemonSqueezyCheckoutAdapter } from '../src/modules/payments/lemon-squeezy.adapter';
import { LEMON_SQUEEZY_SIGNATURE_HEADER } from '../src/modules/payments/lemon-squeezy.webhook';
import { createCampaignFixture, engineWriteSnapshot, setEngineEnabled, walletInvariant } from './campaign-fixtures';
import {
  createOfferPackage,
  createProviderProfile,
  createTestApp,
  createUser,
  currentCreditBalance,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * CMP-002 S2B2 — the engine reached through the real business paths, switch on.
 *
 * Nothing here calls the engine directly. A provider is approved through the
 * moderation route, proves its e-mail through the mailed link and its
 * telephone through the SMS code, buys a package through the signed Lemon
 * Squeezy webhook and through the mock form — and the campaign rows, the
 * CAMPAIGN_GRANT ledger row and the lot appear (or do not) as a consequence.
 *
 * What is proven, in the brief's words: K1 grants once whatever the order of
 * the three facts, and a fact written again (an approval after a suspension)
 * grants nothing more; K2 grants once per verified settlement, and a
 * redelivered or raced webhook grants nothing more; a customer's proof is no
 * provider fact; two ACTIVE campaigns on one event settle exactly one; an
 * engine fault rolls the settlement back with a retryable answer and the
 * redelivery settles cleanly once the campaign at fault is paused; four
 * concurrent approvals of one provider grant once and leave no silent loser.
 */

const PLACEHOLDER_API_KEY = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.${'placeholderNotARealCredential'}`;
const WEBHOOK_SECRET = 'placeholder-webhook-secret-not-real';
const STORE_ID = '424242';
const VARIANT_ID = '778899';
const PRICE = 100_000;
const PACKAGE_CREDITS = 25;
const MANAGED_KEYS = [
  'PAYMENT_PROVIDER',
  'LEMON_SQUEEZY_API_KEY',
  'LEMON_SQUEEZY_STORE_ID',
  'LEMON_SQUEEZY_WEBHOOK_SECRET',
  'LEMON_SQUEEZY_VARIANT_MAP',
  'WEB_ORIGIN',
] as const;

let ctx: TestContext;
let original: Record<string, string | undefined>;

beforeAll(async () => {
  ctx = await createTestApp({
    paymentProvider: new LemonSqueezyCheckoutAdapter(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        data: { type: 'checkouts', id: 'checkout-abc-123', attributes: { url: 'https://lemon.example.test/c' } },
      }),
    })),
  });
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await setEngineEnabled(ctx.prisma, true);
  ctx.notifications.clear();
  ctx.sms.clear();
  resetAuthThrottle(ctx.app);
  original = Object.fromEntries(MANAGED_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ───────────────────────────── helpers ──────────────────────────────

const K1_FACTS = ['PROVIDER_APPROVED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED'] as const;
type Fact = (typeof K1_FACTS)[number];

async function admin() {
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { user, cookie: await loginAs(ctx.prisma, user.id) };
}

/** A PROVIDER account with a profile under review, nothing proven yet. */
async function newProvider(status: ProviderStatus = ProviderStatus.PENDING_REVIEW) {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: `0555${uniqueSuffix().padStart(7, '0').slice(-7)}` });
  const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status });
  return { owner, provider, cookie: await loginAs(ctx.prisma, owner.id) };
}

/** An ACTIVE campaign written the way the activation route writes it (the route itself is admin-campaign-lifecycle.spec). */
const activeCampaign = (options: Parameters<typeof createCampaignFixture>[1] = {}) => createCampaignFixture(ctx.prisma, options);

const approve = (adminCookie: string, providerId: string, status: ProviderStatus = ProviderStatus.APPROVED) =>
  request(ctx.server).patch(`/providers/${providerId}/status`).set('Cookie', adminCookie).send({ status, ...(status === ProviderStatus.REJECTED ? { rejectionReason: 'test' } : {}) });

/** Requests the link and follows it; returns the confirm response (status asserted by the caller). */
async function proveEmail(cookie: string, expectedStatus: number) {
  await request(ctx.server).post('/auth/email-verification/resend').set('Cookie', cookie).expect(201);
  const mail = ctx.notifications.ofTemplate('provider-email-verification').at(-1)!;
  const token = new URL(mail.actionUrl!).searchParams.get('token')!;
  return request(ctx.server).post('/auth/email-verification/confirm').send({ token }).expect(expectedStatus);
}

/** Requests the code and enters it; returns the verify response (status asserted by the caller). */
async function provePhone(cookie: string, expectedStatus: number) {
  await request(ctx.server).post('/providers/me/phone-verification').set('Cookie', cookie).expect(201);
  return request(ctx.server).post('/providers/me/phone-verification/verify').set('Cookie', cookie).send({ code: ctx.sms.lastCode() }).expect(expectedStatus);
}

async function writeFact(fact: Fact, actors: { adminCookie: string; providerId: string; cookie: string }) {
  if (fact === 'PROVIDER_APPROVED') return approve(actors.adminCookie, actors.providerId).expect(200);
  if (fact === 'EMAIL_VERIFIED') return proveEmail(actors.cookie, 201);
  return provePhone(actors.cookie, 201);
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

async function ledger(providerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: { providerId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { type: true, amount: true, balanceAfter: true, referenceType: true },
  });
}

async function logs(where: Prisma.CampaignEvaluationLogWhereInput = {}) {
  return ctx.prisma.campaignEvaluationLog.findMany({
    where,
    orderBy: { evaluatedAt: 'asc' },
    select: { campaignId: true, outcome: true, reasonCode: true, winnerCampaignId: true, fact: true },
  });
}

/** Everything a single grant must have left behind, and nothing else, for one provider. */
async function expectSingleGrant(providerId: string, campaignId: string, credits: number, extraLedger: Array<{ type: CreditTransactionType; amount: number }> = []) {
  const redemptions = await ctx.prisma.campaignRedemption.findMany({ where: { providerId } });
  expect(redemptions).toHaveLength(1);
  const redemption = redemptions[0]!;
  expect(redemption).toMatchObject({ campaignId, status: 'GRANTED', grantedCredits: credits });
  expect(redemption.grantTransactionId).not.toBeNull();
  const lots = await ctx.prisma.promoCreditLot.findMany({ where: { providerId } });
  expect(lots).toHaveLength(1);
  expect(lots[0]).toMatchObject({ redemptionId: redemption.id, grantedCredits: credits, remainingCredits: credits, status: 'ACTIVE' });
  const grants = await ctx.prisma.providerCreditTransaction.findMany({ where: { providerId, type: CreditTransactionType.CAMPAIGN_GRANT } });
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ id: redemption.grantTransactionId, amount: credits, referenceType: 'CampaignRedemption', referenceId: redemption.id });
  const rows = await ledger(providerId);
  expect(rows.map((row) => ({ type: row.type, amount: row.amount }))).toEqual([...extraLedger, { type: CreditTransactionType.CAMPAIGN_GRANT, amount: credits }]);
  const wallet = await walletInvariant(ctx.prisma, providerId);
  expect(wallet.sumOfAmounts).toBe(wallet.balance);
  expect(wallet.promoInWallet).toBe(credits);
  expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ redemptionCount: 1, budgetConsumedCredits: credits });
  expect(await ctx.prisma.campaignProviderCounter.findMany({ where: { campaignId } })).toMatchObject([{ providerId, redemptionCount: 1 }]);
  const event = await ctx.prisma.campaignTriggerEvent.findUniqueOrThrow({ where: { id: redemption.triggerEventId } });
  expect(event).toMatchObject({ settledByCampaignId: campaignId, settledRedemptionId: redemption.id });
  return { redemption, lot: lots[0]!, event };
}

function configureLemon(slug: string) {
  process.env.PAYMENT_PROVIDER = 'lemon-squeezy-test';
  process.env.LEMON_SQUEEZY_API_KEY = PLACEHOLDER_API_KEY;
  process.env.LEMON_SQUEEZY_STORE_ID = STORE_ID;
  process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.LEMON_SQUEEZY_VARIANT_MAP = `${slug}:${VARIANT_ID}`;
  process.env.WEB_ORIGIN = 'https://web.example.test';
}

function deliver(payload: unknown) {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(body, 'utf8')).digest('hex');
  return request(ctx.server)
    .post('/payments/lemon-squeezy/webhook')
    .set('content-type', 'application/json')
    .set(LEMON_SQUEEZY_SIGNATURE_HEADER, signature)
    .send(body);
}

function paidOrder(reference: string, orderId: string) {
  return {
    meta: { event_name: 'order_created', test_mode: true, custom_data: { purchase_reference: reference } },
    data: {
      type: 'orders',
      id: orderId,
      attributes: {
        store_id: Number(STORE_ID),
        status: 'paid',
        total: PRICE,
        currency: 'TRY',
        user_name: 'Ayşe Yılmaz',
        user_email: 'ayse.yilmaz@example.test',
        first_order_item: { variant_id: Number(VARIANT_ID), price: PRICE, quantity: 1 },
      },
    },
  };
}

/** A PENDING Lemon purchase opened through the real checkout route. */
async function openLemonCheckout(providerId: string, cookie: string) {
  const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.ONE_TIME_CREDITS, creditAmount: PACKAGE_CREDITS, priceAmount: PRICE });
  configureLemon(pkg.slug);
  const created = await request(ctx.server).post(`/providers/${providerId}/checkout-sessions`).set('Cookie', cookie).send({ packageId: pkg.id }).expect(201);
  const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: created.body.purchase.id as string } });
  return { pkg, purchase };
}

const MOCK_CARD = { cardholderName: 'Test Kullanıcı', cardNumber: '4242424242424242', expiryMonth: 12, expiryYear: new Date().getFullYear() + 2, cvv: '123' };

// ─────────────────────────── K1: eligibility ────────────────────────────

describe('K1 — approval, e-mail proof and telephone proof through the real routes', () => {
  it.each(permutations(K1_FACTS).map((order) => [order.join(' → '), order]))(
    'grants exactly once, on the last fact, in the order %s',
    async (_label, order) => {
      const { campaign } = await activeCampaign({ trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: [...K1_FACTS], credits: 5, expiresInDays: 14 });
      const { cookie: adminCookie } = await admin();
      const { provider, cookie } = await newProvider();
      const actors = { adminCookie, providerId: provider.id, cookie };

      for (const fact of order.slice(0, 2)) {
        await writeFact(fact, actors);
        expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
        expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
      }
      await writeFact(order[2]!, actors);

      const { event } = await expectSingleGrant(provider.id, campaign.id, 5);
      expect(event.triggerEventKey).toBe(`PROVIDER_ELIGIBILITY_REACHED:EMAIL_VERIFIED+PHONE_VERIFIED+PROVIDER_APPROVED:${provider.id}`);
      expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(5);
      const granted = await logs({ outcome: 'GRANTED' });
      expect(granted).toEqual([{ campaignId: campaign.id, outcome: 'GRANTED', reasonCode: null, winnerCampaignId: null, fact: order[2] }]);
      // The proofs themselves landed exactly as before.
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: provider.userId! } });
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.phoneVerifiedAt).not.toBeNull();
      expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.APPROVED);
    },
  );

  it('a suspension followed by a re-approval, and an already-approved re-save, grant nothing more', async () => {
    const { campaign } = await activeCampaign({ trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: [...K1_FACTS], credits: 5 });
    const { cookie: adminCookie } = await admin();
    const { provider, cookie } = await newProvider();
    await proveEmail(cookie, 201);
    await provePhone(cookie, 201);
    await approve(adminCookie, provider.id).expect(200);
    await expectSingleGrant(provider.id, campaign.id, 5);
    const after = await engineWriteSnapshot(ctx.prisma);

    await approve(adminCookie, provider.id, ProviderStatus.SUSPENDED).expect(200);
    await approve(adminCookie, provider.id).expect(200);
    // A re-save of an already APPROVED profile is not a transition and raises nothing.
    await approve(adminCookie, provider.id).expect(200);

    expect(await ctx.prisma.campaignRedemption.count()).toBe(1);
    expect(await ctx.prisma.promoCreditLot.count()).toBe(1);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(5);
    // The second approval was evaluated (it is a genuine transition) and found the settled event.
    const later = await engineWriteSnapshot(ctx.prisma);
    expect(later).toEqual({ ...after, evaluationLogs: later.evaluationLogs });
    expect(later.evaluationLogs).toBeGreaterThan(after.evaluationLogs);
    expect((await logs({ campaignId: campaign.id })).map((row) => row.outcome)).toEqual(['GRANTED', 'ALREADY_REDEEMED']);
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.APPROVED);
  });

  it('approval never waits on eligibility: with no proof on file the profile is APPROVED and the set stays incomplete', async () => {
    await activeCampaign({ trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: [...K1_FACTS] });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();
    await approve(adminCookie, provider.id).expect(200);
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.APPROVED);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
    // No eligibility event exists for an incomplete set; the approval *event*
    // exists and found no candidate.
    const events = await ctx.prisma.campaignTriggerEvent.findMany();
    expect(events.map((row) => row.trigger)).toEqual(['PROVIDER_APPROVED']);
    expect((await logs()).map((row) => row.outcome)).toEqual(['NO_CANDIDATE']);
  });

  it("a CUSTOMER's e-mail proof and an operator's proof produce no provider fact and no row", async () => {
    await activeCampaign({ trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: ['PROVIDER_APPROVED', 'EMAIL_VERIFIED'] });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await loginAs(ctx.prisma, customer.id);
    const before = await engineWriteSnapshot(ctx.prisma);

    await request(ctx.server).post('/auth/email-verification/resend').set('Cookie', cookie).expect(201);
    const mail = ctx.notifications.ofTemplate('email-verification').at(-1)!;
    const token = new URL(mail.actionUrl!).searchParams.get('token')!;
    await request(ctx.server).post('/auth/email-verification/confirm').send({ token }).expect(201);

    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).emailVerifiedAt).not.toBeNull();
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(before);
  });
});

// ──────────────────────── K2: package payment ───────────────────────────

describe('K2 — a verified Lemon Squeezy settlement and the mock settlement', () => {
  const K2_CONDITIONS = [
    { type: 'PURCHASE_KIND_IN', kinds: ['OFFER_PACKAGE'] },
    { type: 'PACKAGE_TYPE_IN', types: ['ONE_TIME_CREDITS'] },
    { type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' },
    { type: 'MIN_PAID_AMOUNT', minor: 50_000, currency: 'TRY' },
    { type: 'NO_PRIOR_REVOCATION' },
  ];

  it('the webhook settles once: PACKAGE_PURCHASE then CAMPAIGN_GRANT in one commit; a redelivery is a duplicate with no second grant', async () => {
    const { campaign } = await activeCampaign({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 10, conditions: K2_CONDITIONS });
    const { provider, cookie } = await newProvider(ProviderStatus.APPROVED);
    const { purchase } = await openLemonCheckout(provider.id, cookie);

    const first = await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(200);
    expect(first.body).toEqual({ status: 'processed' });

    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe(PackagePurchaseStatus.PAID);
    const { event } = await expectSingleGrant(provider.id, campaign.id, 10, [{ type: CreditTransactionType.PACKAGE_PURCHASE, amount: PACKAGE_CREDITS }]);
    expect(event.triggerEventKey).toBe(`PACKAGE_PAYMENT_SUCCEEDED:${purchase.id}`);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(PACKAGE_CREDITS + 10);
    expect((await ctx.prisma.paymentWebhookEvent.findFirstOrThrow()).status).toBe(PaymentWebhookEventStatus.PROCESSED);
    const settled = await engineWriteSnapshot(ctx.prisma);

    // Same event again: the PROCESSED short-circuit, nothing evaluated, nothing written.
    const again = await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(200);
    expect(again.body).toEqual({ status: 'duplicate' });
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(settled);
    expect((await ctx.prisma.paymentWebhookEvent.findFirstOrThrow()).attemptCount).toBe(2);

    // A different order naming the same, already-PAID purchase is refused
    // before settlement and evaluates nothing.
    const other = await deliver(paidOrder(purchase.paymentReference!, 'order-2')).expect(200);
    expect(other.body).toEqual({ status: 'mismatched' });
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(settled);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(PACKAGE_CREDITS + 10);
  });

  it('the mock settlement raises the same event and grants once; the second purchase is not the first', async () => {
    process.env.PAYMENT_PROVIDER = 'mock';
    const { campaign } = await activeCampaign({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 10, conditions: K2_CONDITIONS });
    const { provider, cookie } = await newProvider(ProviderStatus.APPROVED);
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.ONE_TIME_CREDITS, creditAmount: PACKAGE_CREDITS, priceAmount: PRICE });

    const buy = async () => {
      const created = await request(ctx.server).post(`/providers/${provider.id}/package-purchases`).set('Cookie', cookie).send({ packageId: pkg.id }).expect(201);
      const paid = await request(ctx.server)
        .post(`/providers/${provider.id}/package-purchases/${created.body.id}/mock-pay`)
        .set('Cookie', cookie)
        .send(MOCK_CARD)
        .expect(201);
      return { purchaseId: created.body.id as string, paid };
    };

    const first = await buy();
    expect(first.paid.body.status).toBe(PackagePurchaseStatus.PAID);
    await expectSingleGrant(provider.id, campaign.id, 10, [{ type: CreditTransactionType.PACKAGE_PURCHASE, amount: PACKAGE_CREDITS }]);
    // Paying the same purchase again is refused at the purchase, before the engine.
    await request(ctx.server).post(`/providers/${provider.id}/package-purchases/${first.purchaseId}/mock-pay`).set('Cookie', cookie).send(MOCK_CARD).expect(409);

    const second = await buy();
    expect(second.paid.body.status).toBe(PackagePurchaseStatus.PAID);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(2 * PACKAGE_CREDITS + 10);
    expect((await logs({ campaignId: campaign.id })).map((row) => [row.outcome, row.reasonCode])).toEqual([
      ['GRANTED', null],
      ['CONDITIONS_FAILED', 'FIRST_SUCCESSFUL_PAID_PURCHASE'],
    ]);
  });

  it('a settlement that fails the conditions loads the package credits and grants nothing', async () => {
    const { campaign } = await activeCampaign({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 10, conditions: [{ type: 'MIN_PAID_AMOUNT', minor: 500_000, currency: 'TRY' }] });
    const { provider, cookie } = await newProvider(ProviderStatus.APPROVED);
    const { purchase } = await openLemonCheckout(provider.id, cookie);
    await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(200);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(PACKAGE_CREDITS);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect(await logs({ campaignId: campaign.id })).toMatchObject([{ outcome: 'CONDITIONS_FAILED', reasonCode: 'MIN_PAID_AMOUNT' }]);
    expect((await ctx.prisma.paymentWebhookEvent.findFirstOrThrow()).status).toBe(PaymentWebhookEventStatus.PROCESSED);
  });
});

// ───────────────────── retry semantics and containment ──────────────────

describe('retry semantics — an engine fault is never committed over', () => {
  /** A stored definition the validator refuses: the engine answers ENGINE_ERROR. */
  async function corrupt(versionId: string) {
    const version = await ctx.prisma.campaignVersion.findUniqueOrThrow({ where: { id: versionId } });
    await ctx.prisma.campaignVersion.update({
      where: { id: versionId },
      data: { definition: { ...(version.definition as object), conditions: { all: [{ type: 'NOT_A_CONDITION' }] } } as Prisma.InputJsonValue },
    });
  }

  it('webhook: the settlement rolls back with a retryable non-2xx, PROCESSED is not written, and the redelivery settles once the campaign is paused', async () => {
    const { campaign, version } = await activeCampaign({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 10 });
    await corrupt(version.id);
    const { provider, cookie } = await newProvider(ProviderStatus.APPROVED);
    const { purchase } = await openLemonCheckout(provider.id, cookie);
    const before = await engineWriteSnapshot(ctx.prisma);

    const refused = await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(409);
    expect(refused.body.code).toBe('CAMPAIGN_ENGINE_FAILED');

    // Nothing of the settlement survived: no PAID, no ledger row, no attempt
    // record marked PROCESSED, no campaign row of any kind.
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe(PackagePurchaseStatus.PENDING);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
    expect(await ctx.prisma.paymentWebhookEvent.count({ where: { status: PaymentWebhookEventStatus.PROCESSED } })).toBe(0);
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(before);

    // The operator pauses the campaign at fault (always possible); Lemon redelivers.
    const { cookie: adminCookie } = await admin();
    await request(ctx.server).post(`/admin/campaigns/${campaign.id}/pause`).set('Cookie', adminCookie).send({ reason: 'tanım bozuk' }).expect(201);
    const redelivered = await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(200);
    expect(redelivered.body).toEqual({ status: 'processed' });
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe(PackagePurchaseStatus.PAID);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(PACKAGE_CREDITS);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect(await logs()).toMatchObject([{ campaignId: campaign.id, outcome: 'CAMPAIGN_PAUSED' }]);
    expect((await ctx.prisma.paymentWebhookEvent.findFirstOrThrow()).status).toBe(PaymentWebhookEventStatus.PROCESSED);
  });

  it('approval: the status change rolls back with a retryable 409 and no partial row; an approval-only campaign is not consulted once ended', async () => {
    const { campaign, version } = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10 });
    await corrupt(version.id);
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();
    const before = await engineWriteSnapshot(ctx.prisma);

    const refused = await approve(adminCookie, provider.id).expect(409);
    expect(refused.body.code).toBe('CAMPAIGN_ENGINE_FAILED');
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.PENDING_REVIEW);
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(before);
    expect(ctx.notifications.ofTemplate('provider-application-approved')).toHaveLength(0);

    await request(ctx.server).post(`/admin/campaigns/${campaign.id}/end`).set('Cookie', adminCookie).send({ reason: 'tanım bozuk' }).expect(201);
    await approve(adminCookie, provider.id).expect(200);
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.APPROVED);
    expect((await logs()).map((row) => row.outcome)).toEqual(['NO_CANDIDATE']);
  });

  it('telephone proof: the proof rolls back with a retryable 409 and the code can be entered again after the fix', async () => {
    const { campaign, version } = await activeCampaign({ trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: ['PROVIDER_APPROVED', 'PHONE_VERIFIED'], credits: 3 });
    await corrupt(version.id);
    const { provider, cookie } = await newProvider(ProviderStatus.APPROVED);

    const refused = await provePhone(cookie, 409);
    expect(refused.body.code).toBe('CAMPAIGN_ENGINE_FAILED');
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: provider.userId! } })).phoneVerifiedAt).toBeNull();
    expect(await engineWriteSnapshot(ctx.prisma)).toMatchObject({ triggerEvents: 0, redemptions: 0, lots: 0, ledgerRows: 0 });

    // Restore the definition; the same OTP flow now proves and grants.
    await ctx.prisma.campaignVersion.update({ where: { id: version.id }, data: { definition: version.definition as Prisma.InputJsonValue } });
    await provePhone(cookie, 201);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: provider.userId! } })).phoneVerifiedAt).not.toBeNull();
    await expectSingleGrant(provider.id, campaign.id, 3);
  });
});

// ──────────────────────────── stack and races ───────────────────────────

describe('stack and concurrency through the real routes', () => {
  it('two ACTIVE approval campaigns on one approval: the richer one settles, the other is STACK_CONFLICT with untouched counters', async () => {
    const small = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 5, priority: 1 });
    const big = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10, priority: 100 });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();

    await approve(adminCookie, provider.id).expect(200);

    await expectSingleGrant(provider.id, big.campaign.id, 10);
    expect(await logs({ campaignId: small.campaign.id })).toMatchObject([{ outcome: 'STACK_CONFLICT', winnerCampaignId: big.campaign.id }]);
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: small.campaign.id } })).toMatchObject({ redemptionCount: 0, budgetConsumedCredits: 0 });
    expect(await ctx.prisma.campaignProviderCounter.count({ where: { campaignId: small.campaign.id } })).toBe(0);
  });

  it('the richer candidate refused by its budget rolls back and the next one wins, in the approval transaction', async () => {
    const exhausted = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10, budgetCredits: 10 });
    await ctx.prisma.campaign.update({ where: { id: exhausted.campaign.id }, data: { redemptionCount: 1, budgetConsumedCredits: 10 } });
    const runnerUp = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 5 });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();

    await approve(adminCookie, provider.id).expect(200);

    await expectSingleGrant(provider.id, runnerUp.campaign.id, 5);
    expect((await logs()).map((row) => [row.campaignId, row.outcome])).toEqual([
      [exhausted.campaign.id, 'BUDGET_EXHAUSTED'],
      [runnerUp.campaign.id, 'GRANTED'],
    ]);
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: exhausted.campaign.id } })).toMatchObject({ redemptionCount: 1, budgetConsumedCredits: 10 });
  });

  it('four concurrent approvals of one provider: one grant, one lot, one redemption; every loser is either replayed into ALREADY_REDEEMED or told to retry', async () => {
    const { campaign } = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10 });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();

    const responses = await Promise.all(Array.from({ length: 4 }, () => approve(adminCookie, provider.id)));

    const statuses = responses.map((r) => r.status);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    for (const response of responses.filter((r) => r.status === 409)) {
      expect(response.body.code).toBe('CONCURRENT_MODIFICATION');
    }
    await expectSingleGrant(provider.id, campaign.id, 10);
    // No silent loser: every committed approval either granted or logged
    // that the event was already settled — one log row per commit.
    const committed = statuses.filter((s) => s === 200).length;
    const rows = await logs({ campaignId: campaign.id });
    expect(rows.filter((row) => row.outcome === 'GRANTED')).toHaveLength(1);
    expect(rows).toHaveLength(committed);
    expect(rows.slice(1).every((row) => row.outcome === 'ALREADY_REDEEMED')).toBe(true);
    expect((await ctx.prisma.campaignTriggerEvent.findFirstOrThrow()).evaluationCount).toBe(committed);
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.APPROVED);
  });

  it('four concurrent deliveries of one paid order: one settlement, one grant; the rest are duplicates or retryable', async () => {
    const { campaign } = await activeCampaign({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 10 });
    const { provider, cookie } = await newProvider(ProviderStatus.APPROVED);
    const { purchase } = await openLemonCheckout(provider.id, cookie);

    const responses = await Promise.all(Array.from({ length: 4 }, () => deliver(paidOrder(purchase.paymentReference!, 'order-1'))));

    const bodies = responses.map((r) => ({ status: r.status, outcome: r.body.status as string | undefined }));
    expect(bodies.filter((b) => b.status === 200 && b.outcome === 'processed')).toHaveLength(1);
    for (const body of bodies) {
      expect(body.status === 409 || (body.status === 200 && ['processed', 'duplicate'].includes(body.outcome!))).toBe(true);
    }
    await expectSingleGrant(provider.id, campaign.id, 10, [{ type: CreditTransactionType.PACKAGE_PURCHASE, amount: PACKAGE_CREDITS }]);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(PACKAGE_CREDITS + 10);
    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(1);
    expect((await ctx.prisma.paymentWebhookEvent.findFirstOrThrow()).status).toBe(PaymentWebhookEventStatus.PROCESSED);
  });

  it('K1 and K2 on the same provider are independent events: two grants, two lots, wallet invariant holds', async () => {
    const k1 = await activeCampaign({ trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: [...K1_FACTS], credits: 5 });
    const k2 = await activeCampaign({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 10 });
    const { cookie: adminCookie } = await admin();
    const { provider, cookie } = await newProvider();
    const { purchase } = await openLemonCheckout(provider.id, cookie);

    await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(200);
    await proveEmail(cookie, 201);
    await provePhone(cookie, 201);
    await approve(adminCookie, provider.id).expect(200);

    const redemptions = await ctx.prisma.campaignRedemption.findMany({ where: { providerId: provider.id }, orderBy: { grantedAt: 'asc' } });
    expect(redemptions.map((row) => row.campaignId)).toEqual([k2.campaign.id, k1.campaign.id]);
    expect(await ctx.prisma.promoCreditLot.count({ where: { providerId: provider.id } })).toBe(2);
    expect((await ledger(provider.id)).map((row) => [row.type, row.amount, row.balanceAfter])).toEqual([
      [CreditTransactionType.PACKAGE_PURCHASE, PACKAGE_CREDITS, 25],
      [CreditTransactionType.CAMPAIGN_GRANT, 10, 35],
      [CreditTransactionType.CAMPAIGN_GRANT, 5, 40],
    ]);
    const wallet = await walletInvariant(ctx.prisma, provider.id);
    expect(wallet).toMatchObject({ balance: 40, sumOfAmounts: 40, promoInWallet: 15, paid: 25 });
  });
});

describe('a campaign that is not ACTIVE is never a grant', () => {
  it('PAUSED logs CAMPAIGN_PAUSED, DRAFT and ENDED are invisible, and an ended campaign leaves its lots alone', async () => {
    const paused = await activeCampaign({ trigger: 'PROVIDER_APPROVED', status: CampaignStatus.PAUSED });
    await activeCampaign({ trigger: 'PROVIDER_APPROVED', status: CampaignStatus.DRAFT });
    await activeCampaign({ trigger: 'PROVIDER_APPROVED', status: CampaignStatus.ENDED });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();
    await approve(adminCookie, provider.id).expect(200);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
    expect(await logs()).toMatchObject([{ campaignId: paused.campaign.id, outcome: 'CAMPAIGN_PAUSED' }]);
  });
});
