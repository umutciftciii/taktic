import {
  CampaignStatus,
  CampaignTriggerEventStatus,
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CampaignEngineRepository } from '../src/modules/campaigns/engine/campaign-engine.repository';
import { CampaignEngineService } from '../src/modules/campaigns/engine/campaign-engine.service';
import { CampaignEvaluationWorker } from '../src/modules/campaigns/engine/campaign-evaluation.worker';
import { FactSourceRegistry } from '../src/modules/campaigns/engine/fact-source-registry';
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
 * CMP-002 S2B2 rev. 2 — the two-stage contract through the real business
 * paths, switch on.
 *
 * Stage A: a provider is approved through the moderation route, proves its
 * e-mail through the mailed link and its telephone through the SMS code,
 * buys a package through the signed Lemon Squeezy webhook and through the
 * mock form — and each of those commits together with exactly one durable
 * PENDING `CampaignTriggerEvent` and nothing else: no redemption, no lot, no
 * ledger row, no log.
 *
 * Stage B: `CampaignEvaluationWorker.runOnce` claims and evaluates the
 * event in its own transaction; a grant appears, or a closed reason is
 * logged. A forced evaluator fault leaves the business write standing and
 * the event RETRY_WAIT with a code, and the next due attempt grants once
 * the fault is gone. Duplicate webhooks, re-approvals, four concurrent hooks
 * and four concurrent workers all end with at most one grant; an expired
 * lease and a restarted process both pick the event up again; and with the
 * switch off every real path writes nothing campaign-related at all.
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
let worker: CampaignEvaluationWorker;
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
  worker = ctx.app.get(CampaignEvaluationWorker);
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
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ───────────────────────────── helpers ──────────────────────────────

const K1_FACTS = ['PROVIDER_APPROVED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED'] as const;
type Fact = (typeof K1_FACTS)[number];
const K1_KEY = (providerId: string) => `PROVIDER_ELIGIBILITY_REACHED:EMAIL_VERIFIED+PHONE_VERIFIED+PROVIDER_APPROVED:${providerId}`;

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

async function events() {
  return ctx.prisma.campaignTriggerEvent.findMany({
    orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }],
    select: { triggerEventKey: true, status: true, attemptCount: true, leaseUntil: true, lastErrorCode: true, nextAttemptAt: true, settledByCampaignId: true },
  });
}

/** What stage A leaves behind and nothing more: PENDING event(s), zero grant-side rows. */
async function expectOnlyPending(keys: string[]) {
  const rows = await events();
  expect(rows.map((row) => [row.triggerEventKey, row.status]).sort()).toEqual(keys.map((key) => [key, 'PENDING']).sort());
  expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
  expect(await ctx.prisma.promoCreditLot.count()).toBe(0);
  expect(await ctx.prisma.campaignEvaluationLog.count()).toBe(0);
  expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: { in: ['CAMPAIGN_GRANT', 'CAMPAIGN_EXPIRE', 'CAMPAIGN_REVOKE'] } } })).toBe(0);
  expect(await ctx.prisma.campaignProviderCounter.count()).toBe(0);
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
  expect(event).toMatchObject({ status: 'SETTLED', settledByCampaignId: campaignId, settledRedemptionId: redemption.id, leaseUntil: null, lastErrorCode: null });
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

/** A stored definition the validator refuses: the engine answers ENGINE_ERROR for any event it is a candidate of. */
async function corrupt(versionId: string) {
  const version = await ctx.prisma.campaignVersion.findUniqueOrThrow({ where: { id: versionId } });
  await ctx.prisma.campaignVersion.update({
    where: { id: versionId },
    data: { definition: { ...(version.definition as object), conditions: { all: [{ type: 'NOT_A_CONDITION' }] } } as Prisma.InputJsonValue },
  });
  return version.definition as Prisma.InputJsonValue;
}

const later = (ms: number) => new Date(Date.now() + ms);
const HOUR = 3_600_000;

// ─────────────────── stage A: the business write + the pending event ───────────────────

describe('stage A — every real path commits its write together with a PENDING event, and nothing else', () => {
  it.each(permutations(K1_FACTS).map((order) => [order.join(' → '), order]))(
    'K1 in the order %s: the eligibility event exists after the last fact only; the worker then grants exactly once',
    async (_label, order) => {
      const { campaign } = await activeCampaign({ trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: [...K1_FACTS], credits: 5, expiresInDays: 14 });
      const { cookie: adminCookie } = await admin();
      const { provider, cookie } = await newProvider();
      const actors = { adminCookie, providerId: provider.id, cookie };

      for (const fact of order.slice(0, 2)) {
        await writeFact(fact, actors);
        expect((await events()).map((row) => row.triggerEventKey)).not.toContain(K1_KEY(provider.id));
      }
      await writeFact(order[2]!, actors);

      // The approval event is raised too (no campaign answers it); the K1 key exists once all three hold.
      const raised = await events();
      expect(raised.map((row) => row.triggerEventKey)).toEqual(expect.arrayContaining([`PROVIDER_APPROVED:${provider.id}`, K1_KEY(provider.id)]));
      await expectOnlyPending(raised.map((row) => row.triggerEventKey));
      expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);

      const run = await worker.runOnce();
      expect(run.skipped).toBeNull();
      expect(run.outcomes.find((entry) => entry.triggerEventKey === K1_KEY(provider.id))?.outcome).toBe('SETTLED');
      const { event } = await expectSingleGrant(provider.id, campaign.id, 5);
      expect(event.triggerEventKey).toBe(K1_KEY(provider.id));
      expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(5);
      // The proofs and the approval landed exactly as before.
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: provider.userId! } });
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.phoneVerifiedAt).not.toBeNull();
      expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.APPROVED);
      // A second pass finds nothing due.
      expect((await worker.runOnce()).claimed).toBe(0);
    },
  );

  it('a suspension followed by a re-approval, and a re-save of an approved profile, raise no second event and grant nothing more', async () => {
    const { campaign } = await activeCampaign({ trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: [...K1_FACTS], credits: 5 });
    const { cookie: adminCookie } = await admin();
    const { provider, cookie } = await newProvider();
    await proveEmail(cookie, 201);
    await provePhone(cookie, 201);
    await approve(adminCookie, provider.id).expect(200);
    await worker.runOnce();
    await expectSingleGrant(provider.id, campaign.id, 5);
    const after = await engineWriteSnapshot(ctx.prisma);

    await approve(adminCookie, provider.id, ProviderStatus.SUSPENDED).expect(200);
    await approve(adminCookie, provider.id).expect(200);
    await approve(adminCookie, provider.id).expect(200);
    // The re-approval raised the same keys: the SETTLED one stayed settled,
    // the evaluated approval event was reopened, and no row was added.
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(after);
    expect((await events()).find((row) => row.triggerEventKey === K1_KEY(provider.id))?.status).toBe('SETTLED');
    await worker.runOnce();
    expect(await ctx.prisma.campaignRedemption.count()).toBe(1);
    expect(await ctx.prisma.promoCreditLot.count()).toBe(1);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(5);
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.APPROVED);
  });

  it('approval never waits on eligibility: with no proof on file the profile is APPROVED and only the approval event exists', async () => {
    await activeCampaign({ trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: [...K1_FACTS] });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();
    await approve(adminCookie, provider.id).expect(200);
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.APPROVED);
    await expectOnlyPending([`PROVIDER_APPROVED:${provider.id}`]);
    await worker.runOnce();
    expect((await events()).map((row) => row.status)).toEqual(['EVALUATED']);
    expect((await logs()).map((row) => row.outcome)).toEqual(['NO_CANDIDATE']);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
  });

  it("a CUSTOMER's e-mail proof produces no provider fact and no row, with the engine on", async () => {
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

  it('webhook: PAID, PACKAGE_PURCHASE, PROCESSED and the PENDING event commit together; the worker grants; a redelivery is a duplicate', async () => {
    const { campaign } = await activeCampaign({
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      credits: 10,
      conditions: [
        { type: 'PURCHASE_KIND_IN', kinds: ['OFFER_PACKAGE'] },
        { type: 'PACKAGE_TYPE_IN', types: ['ONE_TIME_CREDITS'] },
        { type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' },
        { type: 'MIN_PAID_AMOUNT', minor: 50_000, currency: 'TRY' },
        { type: 'NO_PRIOR_REVOCATION' },
      ],
    });
    const { provider, cookie } = await newProvider(ProviderStatus.APPROVED);
    const { purchase } = await openLemonCheckout(provider.id, cookie);

    const first = await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(200);
    expect(first.body).toEqual({ status: 'processed' });
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe(PackagePurchaseStatus.PAID);
    expect((await ctx.prisma.paymentWebhookEvent.findFirstOrThrow()).status).toBe(PaymentWebhookEventStatus.PROCESSED);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(PACKAGE_CREDITS);
    await expectOnlyPending([`PACKAGE_PAYMENT_SUCCEEDED:${purchase.id}`]);

    // Redelivered before the worker ran: PROCESSED short-circuit, the same key, still one PENDING event.
    expect((await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(200)).body).toEqual({ status: 'duplicate' });
    await expectOnlyPending([`PACKAGE_PAYMENT_SUCCEEDED:${purchase.id}`]);

    const run = await worker.runOnce();
    expect(run.outcomes).toEqual([{ triggerEventKey: `PACKAGE_PAYMENT_SUCCEEDED:${purchase.id}`, outcome: 'SETTLED' }]);
    await expectSingleGrant(provider.id, campaign.id, 10, [{ type: CreditTransactionType.PACKAGE_PURCHASE, amount: PACKAGE_CREDITS }]);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(PACKAGE_CREDITS + 10);
    const settled = await engineWriteSnapshot(ctx.prisma);

    // Redelivered after the grant: still a duplicate, nothing written, no second grant.
    expect((await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(200)).body).toEqual({ status: 'duplicate' });
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(settled);
    expect((await ctx.prisma.paymentWebhookEvent.findFirstOrThrow()).attemptCount).toBe(3);
    // A different order naming the same, already-PAID purchase is refused before settlement.
    expect((await deliver(paidOrder(purchase.paymentReference!, 'order-2')).expect(200)).body).toEqual({ status: 'mismatched' });
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(settled);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(PACKAGE_CREDITS + 10);
  });

  it('mock settle raises the same event; the worker grants once; a second purchase is evaluated and refused by its conditions', async () => {
    process.env.PAYMENT_PROVIDER = 'mock';
    const { campaign } = await activeCampaign({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 10, conditions: [{ type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' }] });
    const { provider, cookie } = await newProvider(ProviderStatus.APPROVED);
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.ONE_TIME_CREDITS, creditAmount: PACKAGE_CREDITS, priceAmount: PRICE });
    const buy = async () => {
      const created = await request(ctx.server).post(`/providers/${provider.id}/package-purchases`).set('Cookie', cookie).send({ packageId: pkg.id }).expect(201);
      await request(ctx.server).post(`/providers/${provider.id}/package-purchases/${created.body.id}/mock-pay`).set('Cookie', cookie).send(MOCK_CARD).expect(201);
      return created.body.id as string;
    };

    const first = await buy();
    await expectOnlyPending([`PACKAGE_PAYMENT_SUCCEEDED:${first}`]);
    await request(ctx.server).post(`/providers/${provider.id}/package-purchases/${first}/mock-pay`).set('Cookie', cookie).send(MOCK_CARD).expect(409);
    await worker.runOnce();
    await expectSingleGrant(provider.id, campaign.id, 10, [{ type: CreditTransactionType.PACKAGE_PURCHASE, amount: PACKAGE_CREDITS }]);

    const second = await buy();
    await worker.runOnce();
    expect(await ctx.prisma.campaignRedemption.count()).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(2 * PACKAGE_CREDITS + 10);
    expect((await events()).find((row) => row.triggerEventKey === `PACKAGE_PAYMENT_SUCCEEDED:${second}`)?.status).toBe('EVALUATED');
    expect((await logs({ campaignId: campaign.id })).map((row) => [row.outcome, row.reasonCode])).toEqual([
      ['GRANTED', null],
      ['CONDITIONS_FAILED', 'FIRST_SUCCESSFUL_PAID_PURCHASE'],
    ]);
  });

  it('a database fault while writing the event fails the business transaction: the payment is not settled, PROCESSED is not written, the provider redelivers', async () => {
    await activeCampaign({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 10 });
    const { provider, cookie } = await newProvider(ProviderStatus.APPROVED);
    const { purchase } = await openLemonCheckout(provider.id, cookie);
    const repository = ctx.app.get(CampaignEngineRepository);
    const fault = Object.assign(new Error('simulated integrity failure'), { name: 'PrismaClientKnownRequestError', code: 'P2003' });
    const spy = vi.spyOn(repository, 'ensurePendingEvent').mockRejectedValue(fault);

    const refused = await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(503);
    expect(refused.body.code).toBe('CAMPAIGN_EVENT_NOT_DURABLE');
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe(PackagePurchaseStatus.PENDING);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
    expect(await ctx.prisma.paymentWebhookEvent.count({ where: { status: PaymentWebhookEventStatus.PROCESSED } })).toBe(0);
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(0);

    // "The payment settled but the event is lost" cannot happen: the redelivery settles both.
    spy.mockRestore();
    expect((await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(200)).body).toEqual({ status: 'processed' });
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe(PackagePurchaseStatus.PAID);
    await expectOnlyPending([`PACKAGE_PAYMENT_SUCCEEDED:${purchase.id}`]);
  });

  it('a campaign-side runtime fault in stage A is contained: the approval commits, the fault is logged, no event is fabricated', async () => {
    await activeCampaign({ trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: ['PROVIDER_APPROVED', 'EMAIL_VERIFIED'] });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();
    await ctx.prisma.user.update({ where: { id: provider.userId! }, data: { emailVerifiedAt: new Date() } });
    vi.spyOn(ctx.app.get(FactSourceRegistry), 'readAll').mockRejectedValue(new TypeError('simulated bug'));

    await approve(adminCookie, provider.id).expect(200);
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.APPROVED);
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(0);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
  });
});

// ─────────────────── stage B: fault isolation, retry, lease ───────────────────

describe('stage B — an evaluator fault never touches the business write, and the event is retried', () => {
  it('approval: the profile stays APPROVED, the event goes RETRY_WAIT with ENGINE_ERROR and a log; the next due attempt grants after the fix', async () => {
    const { campaign, version } = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10 });
    const good = await corrupt(version.id);
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();

    await approve(adminCookie, provider.id).expect(200);
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.APPROVED);
    expect(ctx.notifications.ofTemplate('provider-application-approved')).toHaveLength(1);
    await expectOnlyPending([`PROVIDER_APPROVED:${provider.id}`]);

    const failed = await worker.runOnce();
    expect(failed.outcomes).toEqual([{ triggerEventKey: `PROVIDER_APPROVED:${provider.id}`, outcome: 'ENGINE_ERROR' }]);
    const parked = (await events())[0]!;
    expect(parked).toMatchObject({ status: 'RETRY_WAIT', attemptCount: 1, lastErrorCode: 'ENGINE_ERROR', leaseUntil: null });
    expect(parked.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(await logs()).toEqual([{ campaignId: null, outcome: 'ENGINE_ERROR', reasonCode: 'ENGINE_ERROR', winnerCampaignId: null, fact: null }]);
    // No grant-side row, no partial candidate write, the approval untouched.
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect(await ctx.prisma.promoCreditLot.count()).toBe(0);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ redemptionCount: 0, budgetConsumedCredits: 0 });
    // Not due yet: nothing is claimed.
    expect((await worker.runOnce()).claimed).toBe(0);

    // Still broken at the next due tick: backed off again, attempt 2, still visible.
    const stillFailed = await worker.runOnce({ now: later(2 * HOUR) });
    expect(stillFailed.outcomes[0]?.outcome).toBe('ENGINE_ERROR');
    expect((await events())[0]).toMatchObject({ status: 'RETRY_WAIT', attemptCount: 2, lastErrorCode: 'ENGINE_ERROR' });

    // Fixed: the same event, the same key, one full grant.
    await ctx.prisma.campaignVersion.update({ where: { id: version.id }, data: { definition: good } });
    const fixed = await worker.runOnce({ now: later(12 * HOUR) });
    expect(fixed.outcomes[0]?.outcome).toBe('SETTLED');
    await expectSingleGrant(provider.id, campaign.id, 10);
    expect((await events())[0]).toMatchObject({ status: 'SETTLED', attemptCount: 3, lastErrorCode: null });
    expect((await logs()).map((row) => row.outcome)).toEqual(['ENGINE_ERROR', 'ENGINE_ERROR', 'GRANTED']);
  });

  it('e-mail and telephone proofs: both proofs stay written, the K1 event is parked and later granted', async () => {
    const { campaign, version } = await activeCampaign({ trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: ['PROVIDER_APPROVED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED'], credits: 3 });
    const good = await corrupt(version.id);
    const { provider, cookie } = await newProvider(ProviderStatus.APPROVED);

    await proveEmail(cookie, 201);
    await provePhone(cookie, 201);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: provider.userId! } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.phoneVerifiedAt).not.toBeNull();
    await expectOnlyPending([K1_KEY(provider.id)]);

    expect((await worker.runOnce()).outcomes[0]?.outcome).toBe('ENGINE_ERROR');
    expect((await events())[0]).toMatchObject({ status: 'RETRY_WAIT', lastErrorCode: 'ENGINE_ERROR' });
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: provider.userId! } })).phoneVerifiedAt).toEqual(user.phoneVerifiedAt);

    await ctx.prisma.campaignVersion.update({ where: { id: version.id }, data: { definition: good } });
    expect((await worker.runOnce({ now: later(HOUR) })).outcomes[0]?.outcome).toBe('SETTLED');
    await expectSingleGrant(provider.id, campaign.id, 3);
  });

  it('webhook and mock settle: PAID and PROCESSED stay, the event is parked; a duplicate delivery adds no event and no grant; the retry grants once', async () => {
    const { campaign, version } = await activeCampaign({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 10 });
    const good = await corrupt(version.id);
    const { provider, cookie } = await newProvider(ProviderStatus.APPROVED);
    const { purchase } = await openLemonCheckout(provider.id, cookie);

    expect((await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(200)).body).toEqual({ status: 'processed' });
    expect((await worker.runOnce()).outcomes[0]?.outcome).toBe('ENGINE_ERROR');
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe(PackagePurchaseStatus.PAID);
    expect((await ctx.prisma.paymentWebhookEvent.findFirstOrThrow()).status).toBe(PaymentWebhookEventStatus.PROCESSED);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(PACKAGE_CREDITS);
    expect((await events())[0]).toMatchObject({ status: 'RETRY_WAIT', lastErrorCode: 'ENGINE_ERROR' });

    expect((await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(200)).body).toEqual({ status: 'duplicate' });
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(1);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);

    await ctx.prisma.campaignVersion.update({ where: { id: version.id }, data: { definition: good } });
    expect((await worker.runOnce({ now: later(HOUR) })).outcomes[0]?.outcome).toBe('SETTLED');
    await expectSingleGrant(provider.id, campaign.id, 10, [{ type: CreditTransactionType.PACKAGE_PURCHASE, amount: PACKAGE_CREDITS }]);

    // The mock path, same shape.
    process.env.PAYMENT_PROVIDER = 'mock';
    await corrupt(version.id);
    const other = await newProvider(ProviderStatus.APPROVED);
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.ONE_TIME_CREDITS, creditAmount: PACKAGE_CREDITS, priceAmount: PRICE });
    const created = await request(ctx.server).post(`/providers/${other.provider.id}/package-purchases`).set('Cookie', other.cookie).send({ packageId: pkg.id }).expect(201);
    await request(ctx.server).post(`/providers/${other.provider.id}/package-purchases/${created.body.id}/mock-pay`).set('Cookie', other.cookie).send(MOCK_CARD).expect(201);
    expect((await worker.runOnce({ now: later(HOUR) })).outcomes[0]?.outcome).toBe('ENGINE_ERROR');
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: created.body.id as string } })).status).toBe(PackagePurchaseStatus.PAID);
    expect(await currentCreditBalance(ctx.prisma, other.provider.id)).toBe(PACKAGE_CREDITS);
    await ctx.prisma.campaignVersion.update({ where: { id: version.id }, data: { definition: good } });
    expect((await worker.runOnce({ now: later(3 * HOUR) })).outcomes[0]?.outcome).toBe('SETTLED');
    expect(await ctx.prisma.campaignRedemption.count({ where: { providerId: other.provider.id } })).toBe(1);
  });

  it('a fault in one candidate lets no other candidate win by default: the event stays parked and the stack order is recomputed on the retry', async () => {
    const rich = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10, priority: 1 });
    const poor = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 5, priority: 1 });
    const good = await corrupt(rich.version.id);
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();
    await approve(adminCookie, provider.id).expect(200);

    expect((await worker.runOnce()).outcomes[0]?.outcome).toBe('ENGINE_ERROR');
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: poor.campaign.id } })).toMatchObject({ redemptionCount: 0 });

    await ctx.prisma.campaignVersion.update({ where: { id: rich.version.id }, data: { definition: good } });
    expect((await worker.runOnce({ now: later(HOUR) })).outcomes[0]?.outcome).toBe('SETTLED');
    await expectSingleGrant(provider.id, rich.campaign.id, 10);
    expect(await logs({ campaignId: poor.campaign.id })).toMatchObject([{ outcome: 'STACK_CONFLICT', winnerCampaignId: rich.campaign.id }]);
  });

  it('a serialization budget exhausted in the worker parks the event with CONCURRENT_MODIFICATION; a plain error parks it with WORKER_ERROR', async () => {
    await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10 });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();
    await approve(adminCookie, provider.id).expect(200);
    const engine = ctx.app.get(CampaignEngineService);

    const conflict = vi.spyOn(engine, 'evaluate').mockRejectedValue(Object.assign(new Error('conflict'), { code: 'P2034' }));
    expect((await worker.runOnce()).outcomes[0]?.outcome).toBe('CONCURRENT_MODIFICATION');
    expect((await events())[0]).toMatchObject({ status: 'RETRY_WAIT', attemptCount: 1, lastErrorCode: 'CONCURRENT_MODIFICATION', leaseUntil: null });

    conflict.mockRejectedValue(new Error('boom'));
    expect((await worker.runOnce({ now: later(HOUR) })).outcomes[0]?.outcome).toBe('WORKER_ERROR');
    expect((await events())[0]).toMatchObject({ status: 'RETRY_WAIT', attemptCount: 2, lastErrorCode: 'WORKER_ERROR' });
    expect(await ctx.prisma.campaignEvaluationLog.count()).toBe(0);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);

    conflict.mockRestore();
    expect((await worker.runOnce({ now: later(12 * HOUR) })).outcomes[0]?.outcome).toBe('SETTLED');
    expect(await ctx.prisma.campaignRedemption.count()).toBe(1);
  });
});

// ────────────────────────── claims, leases, restarts ──────────────────────────

describe('claims and leases', () => {
  it('four concurrent worker passes over one event: exactly one claims it, exactly one grant', async () => {
    const { campaign } = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10 });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();
    await approve(adminCookie, provider.id).expect(200);
    // Four independent workers (four processes, in effect): the in-process
    // guard is bypassed by constructing them separately.
    const workers = Array.from({ length: 4 }, () => new CampaignEvaluationWorker(
      ctx.prisma,
      ctx.app.get(CampaignEngineRepository),
      ctx.app.get(CampaignEngineService),
      ctx.app.get(FactSourceRegistry),
    ));

    const runs = await Promise.all(workers.map((w) => w.runOnce()));

    expect(runs.reduce((sum, run) => sum + run.claimed, 0)).toBe(1);
    expect(runs.flatMap((run) => run.outcomes).map((entry) => entry.outcome)).toEqual(['SETTLED']);
    await expectSingleGrant(provider.id, campaign.id, 10);
    expect((await events())[0]!.attemptCount).toBe(1);
  });

  it('four concurrent hooks for one provider: one PENDING event; the worker then grants once and no committed raise is silently lost', async () => {
    const { campaign } = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10 });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();

    const responses = await Promise.all(Array.from({ length: 4 }, () => approve(adminCookie, provider.id)));
    const statuses = responses.map((r) => r.status);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    for (const response of responses.filter((r) => r.status === 409)) {
      expect(response.body.code).toBe('CONCURRENT_MODIFICATION');
    }
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    await expectOnlyPending([`PROVIDER_APPROVED:${provider.id}`]);
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.APPROVED);

    await worker.runOnce();
    await expectSingleGrant(provider.id, campaign.id, 10);
  });

  it('four concurrent deliveries of one paid order: one settlement, one event, then one grant', async () => {
    const { campaign } = await activeCampaign({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 10 });
    const { provider, cookie } = await newProvider(ProviderStatus.APPROVED);
    const { purchase } = await openLemonCheckout(provider.id, cookie);

    const responses = await Promise.all(Array.from({ length: 4 }, () => deliver(paidOrder(purchase.paymentReference!, 'order-1'))));
    const bodies = responses.map((r) => ({ status: r.status, outcome: r.body.status as string | undefined }));
    expect(bodies.filter((b) => b.status === 200 && b.outcome === 'processed')).toHaveLength(1);
    for (const body of bodies) {
      expect(body.status === 409 || (body.status === 200 && ['processed', 'duplicate'].includes(body.outcome!))).toBe(true);
    }
    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(1);
    await expectOnlyPending([`PACKAGE_PAYMENT_SUCCEEDED:${purchase.id}`]);

    await worker.runOnce();
    await expectSingleGrant(provider.id, campaign.id, 10, [{ type: CreditTransactionType.PACKAGE_PURCHASE, amount: PACKAGE_CREDITS }]);
  });

  it('an expired lease (a worker that died mid-flight) is reclaimed and evaluated; a live lease is not', async () => {
    const { campaign } = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10 });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();
    await approve(adminCookie, provider.id).expect(200);
    const event = await ctx.prisma.campaignTriggerEvent.findFirstOrThrow();

    // Claimed by somebody whose lease is still running: skipped.
    await ctx.prisma.campaignTriggerEvent.update({
      where: { id: event.id },
      data: { status: CampaignTriggerEventStatus.PROCESSING, leaseUntil: later(4 * 60_000), claimedAt: new Date(), attemptCount: 1 },
    });
    expect((await worker.runOnce()).claimed).toBe(0);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);

    // The lease ran out: reclaimed, attempt 2, granted.
    await ctx.prisma.campaignTriggerEvent.update({ where: { id: event.id }, data: { leaseUntil: new Date(Date.now() - 1_000) } });
    const run = await worker.runOnce();
    expect(run.outcomes).toEqual([{ triggerEventKey: event.triggerEventKey, outcome: 'SETTLED' }]);
    await expectSingleGrant(provider.id, campaign.id, 10);
    expect((await events())[0]!.attemptCount).toBe(2);
  });

  it('a worker whose lease was taken over cannot commit its attempt on top of the successor', async () => {
    await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10 });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();
    await approve(adminCookie, provider.id).expect(200);
    const repository = ctx.app.get(CampaignEngineRepository);
    // The first worker claims; before it evaluates, its lease expires and a
    // second claim moves the token. Simulated by rewriting the lease between
    // claim and evaluation.
    const claim = repository.claimDueEvent.bind(repository);
    vi.spyOn(repository, 'claimDueEvent').mockImplementation(async (db, now) => {
      const claimed = await claim(db, now);
      if (claimed) {
        await ctx.prisma.campaignTriggerEvent.update({ where: { id: claimed.id }, data: { leaseUntil: later(10 * 60_000) } });
      }
      return claimed;
    });
    const run = await worker.runOnce();
    expect(run.outcomes[0]?.outcome).toBe('LEASE_LOST');
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect((await events())[0]).toMatchObject({ status: 'PROCESSING' });
  });

  it('a restarted process picks pending and parked events up from the database', async () => {
    const { campaign, version } = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10 });
    const good = await corrupt(version.id);
    const { cookie: adminCookie } = await admin();
    const first = await newProvider();
    const second = await newProvider();
    await approve(adminCookie, first.provider.id).expect(200);
    expect((await worker.runOnce()).outcomes[0]?.outcome).toBe('ENGINE_ERROR');
    await ctx.prisma.campaignVersion.update({ where: { id: version.id }, data: { definition: good } });
    await approve(adminCookie, second.provider.id).expect(200);
    expect((await events()).map((row) => row.status).sort()).toEqual(['PENDING', 'RETRY_WAIT']);

    // "Restart": a second application instance over the same database.
    const restarted = await createTestApp();
    try {
      const run = await restarted.app.get(CampaignEvaluationWorker).runOnce({ now: later(HOUR) });
      expect(run.outcomes.map((entry) => entry.outcome).sort()).toEqual(['SETTLED', 'SETTLED']);
    } finally {
      await restarted.app.close();
    }
    expect(await ctx.prisma.campaignRedemption.count({ where: { campaignId: campaign.id } })).toBe(2);
    expect((await events()).map((row) => row.status)).toEqual(['SETTLED', 'SETTLED']);
  });
});

// ─────────────────────────── stack, independence, off ───────────────────────────

describe('stack and independence through the real routes', () => {
  it('two ACTIVE approval campaigns on one approval: the richer one settles, the other is STACK_CONFLICT with untouched counters', async () => {
    const small = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 5, priority: 1 });
    const big = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10, priority: 100 });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();
    await approve(adminCookie, provider.id).expect(200);
    await worker.runOnce();
    await expectSingleGrant(provider.id, big.campaign.id, 10);
    expect(await logs({ campaignId: small.campaign.id })).toMatchObject([{ outcome: 'STACK_CONFLICT', winnerCampaignId: big.campaign.id }]);
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: small.campaign.id } })).toMatchObject({ redemptionCount: 0, budgetConsumedCredits: 0 });
    expect(await ctx.prisma.campaignProviderCounter.count({ where: { campaignId: small.campaign.id } })).toBe(0);
  });

  it('the richer candidate refused by its budget rolls back and the next one wins', async () => {
    const exhausted = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10, budgetCredits: 10 });
    await ctx.prisma.campaign.update({ where: { id: exhausted.campaign.id }, data: { redemptionCount: 1, budgetConsumedCredits: 10 } });
    const runnerUp = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 5 });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();
    await approve(adminCookie, provider.id).expect(200);
    await worker.runOnce();
    await expectSingleGrant(provider.id, runnerUp.campaign.id, 5);
    expect((await logs()).map((row) => [row.campaignId, row.outcome])).toEqual([
      [exhausted.campaign.id, 'BUDGET_EXHAUSTED'],
      [runnerUp.campaign.id, 'GRANTED'],
    ]);
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: exhausted.campaign.id } })).toMatchObject({ redemptionCount: 1, budgetConsumedCredits: 10 });
  });

  it('K1 and K2 on the same provider are independent events: two grants, two lots, wallet invariant holds', async () => {
    const k1 = await activeCampaign({ trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: [...K1_FACTS], credits: 5 });
    const k2 = await activeCampaign({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 10 });
    const { cookie: adminCookie } = await admin();
    const { provider, cookie } = await newProvider();
    const { purchase } = await openLemonCheckout(provider.id, cookie);

    await deliver(paidOrder(purchase.paymentReference!, 'order-1')).expect(200);
    await worker.runOnce();
    await proveEmail(cookie, 201);
    await provePhone(cookie, 201);
    await approve(adminCookie, provider.id).expect(200);
    await worker.runOnce();

    const redemptions = await ctx.prisma.campaignRedemption.findMany({ where: { providerId: provider.id }, orderBy: { grantedAt: 'asc' } });
    expect(redemptions.map((row) => row.campaignId)).toEqual([k2.campaign.id, k1.campaign.id]);
    expect(await ctx.prisma.promoCreditLot.count({ where: { providerId: provider.id } })).toBe(2);
    expect((await ledger(provider.id)).map((row) => [row.type, row.amount, row.balanceAfter])).toEqual([
      [CreditTransactionType.PACKAGE_PURCHASE, PACKAGE_CREDITS, 25],
      [CreditTransactionType.CAMPAIGN_GRANT, 10, 35],
      [CreditTransactionType.CAMPAIGN_GRANT, 5, 40],
    ]);
    expect(await walletInvariant(ctx.prisma, provider.id)).toMatchObject({ balance: 40, sumOfAmounts: 40, promoInWallet: 15, paid: 25 });
  });

  it('PAUSED logs CAMPAIGN_PAUSED and the event is EVALUATED; DRAFT and ENDED are invisible', async () => {
    const paused = await activeCampaign({ trigger: 'PROVIDER_APPROVED', status: CampaignStatus.PAUSED });
    await activeCampaign({ trigger: 'PROVIDER_APPROVED', status: CampaignStatus.DRAFT });
    await activeCampaign({ trigger: 'PROVIDER_APPROVED', status: CampaignStatus.ENDED });
    const { cookie: adminCookie } = await admin();
    const { provider } = await newProvider();
    await approve(adminCookie, provider.id).expect(200);
    await worker.runOnce();
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
    expect(await logs()).toMatchObject([{ campaignId: paused.campaign.id, outcome: 'CAMPAIGN_PAUSED' }]);
    expect((await events())[0]!.status).toBe('EVALUATED');
  });
});

describe('with the switch off', () => {
  it('every real path writes no event, and a worker pass claims nothing even with events left over from an earlier on-period', async () => {
    const { campaign } = await activeCampaign({ trigger: 'PROVIDER_APPROVED', credits: 10 });
    const { cookie: adminCookie } = await admin();
    const earlier = await newProvider();
    await approve(adminCookie, earlier.provider.id).expect(200);
    await expectOnlyPending([`PROVIDER_APPROVED:${earlier.provider.id}`]);

    await setEngineEnabled(ctx.prisma, false);
    const before = await engineWriteSnapshot(ctx.prisma);
    const { provider, cookie } = await newProvider();
    await proveEmail(cookie, 201);
    await provePhone(cookie, 201);
    await approve(adminCookie, provider.id).expect(200);
    process.env.PAYMENT_PROVIDER = 'mock';
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.ONE_TIME_CREDITS, creditAmount: PACKAGE_CREDITS, priceAmount: PRICE });
    const created = await request(ctx.server).post(`/providers/${provider.id}/package-purchases`).set('Cookie', cookie).send({ packageId: pkg.id }).expect(201);
    await request(ctx.server).post(`/providers/${provider.id}/package-purchases/${created.body.id}/mock-pay`).set('Cookie', cookie).send(MOCK_CARD).expect(201);

    const run = await worker.runOnce();
    expect(run).toEqual({ skipped: 'ENGINE_DISABLED', claimed: 0, outcomes: [] });
    // The business writes happened; the campaign side gained nothing — the
    // package credits are the only ledger movement.
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual({ ...before, ledgerRows: before.ledgerRows + 1 });
    expect((await events())[0]).toMatchObject({ status: 'PENDING', attemptCount: 0 });
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ redemptionCount: 0 });
  });
});
