import {
  CampaignAuditAction,
  CampaignChannel,
  CampaignTriggerEventStatus,
  CreditTransactionType,
  OfferPackageType,
  ProviderStatus,
  SourceChannel,
  UserRole,
} from '@prisma/client';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchChannel, requiredSourceChannel } from '../src/modules/campaigns/engine/campaign-channel';
import { CampaignEngineHooks } from '../src/modules/campaigns/engine/campaign-engine.hooks';
import { CampaignEvaluationWorker } from '../src/modules/campaigns/engine/campaign-evaluation.worker';
import { FactSourceRegistry } from '../src/modules/campaigns/engine/fact-source-registry';
import { buildTriggerEventKey } from '../src/modules/campaigns/engine/trigger-event-key';
import { LemonSqueezyCheckoutAdapter } from '../src/modules/payments/lemon-squeezy.adapter';
import { LEMON_SQUEEZY_SIGNATURE_HEADER } from '../src/modules/payments/lemon-squeezy.webhook';
import { createCampaignFixture, engineWriteSnapshot, setEngineEnabled } from './campaign-fixtures';
import {
  createCategory,
  createOfferPackage,
  createProviderProfile,
  createTestApp,
  createUser,
  declareBusinessRegistration,
  loginAs,
  providerPayload,
  resetAuthThrottle,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * CMP-006 PR-D — campaign channel targeting.
 *
 * 1. The pure rule (D25): ALL matches every source channel, WEB/MOBILE only
 *    their own, and UNKNOWN never matches a channel-targeted version.
 * 2. The channel is derived on the server from the canonical row — the
 *    purchase, the application, the proof that completed an eligibility set —
 *    through the real routes, and a client header that says otherwise changes
 *    nothing.
 * 3. The engine judges by the event row's own channel: a mismatch is a
 *    CHANNEL_MISMATCH log with `SOURCE_<channel>`, the event ends EVALUATED
 *    (no error, no retry), and nothing is consumed; ALL keeps today's
 *    behaviour for every channel, UNKNOWN included.
 * 4. The channel is not part of the event key and is written on INSERT only:
 *    a re-raise with a different channel neither moves the event nor mints a
 *    second one, and the database refuses to change it.
 * 5. Activation: a MOBILE version is refused with CHANNEL_SOURCE_UNAVAILABLE
 *    (nothing registers a MOBILE producer) and nothing is written; WEB and ALL
 *    activate on today's web sources.
 * 6. With the engine switch off, the channel columns are written on the
 *    business rows and no campaign row of any kind appears.
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
const CLIENT_CHANNEL_HEADER = 'x-taktic-client-channel';
const MOCK_CARD = { cardholderName: 'Test Kullanıcı', cardNumber: '4242424242424242', expiryMonth: 12, expiryYear: new Date().getFullYear() + 2, cvv: '123' };

let ctx: TestContext;
let worker: CampaignEvaluationWorker;
let hooks: CampaignEngineHooks;
let registry: FactSourceRegistry;
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
  hooks = ctx.app.get(CampaignEngineHooks);
  registry = ctx.app.get(FactSourceRegistry);
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

async function admin() {
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { user, cookie: await loginAs(ctx.prisma, user.id) };
}

async function newProvider(
  options: { status?: ProviderStatus; applicationSourceChannel?: SourceChannel; email?: boolean; phone?: boolean } = {},
) {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: `0555${uniqueSuffix().padStart(7, '0').slice(-7)}` });
  if (options.email || options.phone) {
    await ctx.prisma.user.update({
      where: { id: owner.id },
      data: {
        ...(options.email ? { emailVerifiedAt: new Date() } : {}),
        ...(options.phone ? { phoneVerifiedAt: new Date() } : {}),
      },
    });
  }
  const provider = await createProviderProfile(ctx.prisma, {
    userId: owner.id,
    status: options.status ?? ProviderStatus.PENDING_REVIEW,
    applicationSourceChannel: options.applicationSourceChannel,
  });
  await declareBusinessRegistration(ctx.prisma, provider.id);
  return { owner, provider, cookie: await loginAs(ctx.prisma, owner.id) };
}

const approve = (adminCookie: string, providerId: string) =>
  request(ctx.server).patch(`/providers/${providerId}/status`).set('Cookie', adminCookie).send({ status: ProviderStatus.APPROVED });

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

/** A mock purchase opened by `cookie` through the provider route and settled by the provider's own mock payment. */
async function mockPurchase(providerId: string, openerCookie: string, payerCookie: string, headers: Record<string, string> = {}) {
  process.env.PAYMENT_PROVIDER = 'mock';
  const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.ONE_TIME_CREDITS, creditAmount: PACKAGE_CREDITS, priceAmount: PRICE });
  const created = await request(ctx.server)
    .post(`/providers/${providerId}/package-purchases`)
    .set('Cookie', openerCookie)
    .set(headers)
    .send({ packageId: pkg.id })
    .expect(201);
  await request(ctx.server)
    .post(`/providers/${providerId}/package-purchases/${created.body.id}/mock-pay`)
    .set('Cookie', payerCookie)
    .send(MOCK_CARD)
    .expect(201);
  return created.body.id as string;
}

async function eventOf(triggerEventKey: string) {
  return ctx.prisma.campaignTriggerEvent.findUniqueOrThrow({ where: { triggerEventKey } });
}

async function logsOf(campaignId: string) {
  return ctx.prisma.campaignEvaluationLog.findMany({
    where: { campaignId },
    orderBy: { evaluatedAt: 'asc' },
    select: { outcome: true, reasonCode: true },
  });
}

// ─────────────────────────── 1. the pure rule ───────────────────────────

describe('matchChannel — the D25 matrix', () => {
  const cases: Array<[CampaignChannel, SourceChannel, boolean, string | null]> = [
    ['ALL', 'WEB', true, null],
    ['ALL', 'MOBILE', true, null],
    ['ALL', 'UNKNOWN', true, null],
    ['WEB', 'WEB', true, null],
    ['WEB', 'MOBILE', false, 'SOURCE_MOBILE'],
    ['WEB', 'UNKNOWN', false, 'SOURCE_UNKNOWN'],
    ['MOBILE', 'WEB', false, 'SOURCE_WEB'],
    ['MOBILE', 'MOBILE', true, null],
    ['MOBILE', 'UNKNOWN', false, 'SOURCE_UNKNOWN'],
  ];

  it.each(cases)('version %s × event %s → matches=%s (%s)', (target, source, matches, reasonCode) => {
    const verdict = matchChannel(target, source);
    expect(verdict.matches).toBe(matches);
    expect(verdict.matches ? null : verdict.reasonCode).toBe(reasonCode);
  });

  it('covers every (version, event) pair of the two enums', () => {
    expect(cases).toHaveLength(Object.values(CampaignChannel).length * Object.values(SourceChannel).length);
  });

  it('ALL needs no channel producer; WEB and MOBILE need their own', () => {
    expect(requiredSourceChannel('ALL')).toBeNull();
    expect(requiredSourceChannel('WEB')).toBe('WEB');
    expect(requiredSourceChannel('MOBILE')).toBe('MOBILE');
  });

  it('the event key has the same three shapes as before — no channel in any of them', () => {
    expect(buildTriggerEventKey({ trigger: 'PROVIDER_APPROVED', providerId: 'p1' })).toBe('PROVIDER_APPROVED:p1');
    expect(buildTriggerEventKey({ trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: 'p1', purchaseId: 'u1' })).toBe(
      'PACKAGE_PAYMENT_SUCCEEDED:u1',
    );
    expect(
      buildTriggerEventKey({ trigger: 'PROVIDER_ELIGIBILITY_REACHED', providerId: 'p1', facts: ['PHONE_VERIFIED', 'EMAIL_VERIFIED'] }),
    ).toBe('PROVIDER_ELIGIBILITY_REACHED:EMAIL_VERIFIED+PHONE_VERIFIED:p1');
  });

  it('the booted application registers WEB producers for every source and MOBILE for none', () => {
    for (const source of ['PROVIDER_APPROVED', 'PACKAGE_PAYMENT_SUCCEEDED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED'] as const) {
      expect(registry.hasChannelProducer(source, 'WEB')).toBe(true);
      expect(registry.hasChannelProducer(source, 'MOBILE')).toBe(false);
    }
    expect(() => registry.registerChannel('PROVIDER_APPROVED', 'UNKNOWN' as never, { module: 'x' })).toThrow();
  });
});

// ─────────────────────── 2. server-derived channel ───────────────────────

describe('the channel comes from the canonical row, derived on the server', () => {
  it('Lemon checkout: the purchase is WEB whatever the client header says, and the paid webhook raises a WEB event', async () => {
    const { provider, cookie } = await newProvider({ status: ProviderStatus.APPROVED });
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.ONE_TIME_CREDITS, creditAmount: PACKAGE_CREDITS, priceAmount: PRICE });
    configureLemon(pkg.slug);

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .set(CLIENT_CHANNEL_HEADER, 'mobile')
      .send({ packageId: pkg.id })
      .expect(201);
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: created.body.purchase.id as string } });
    expect(purchase.sourceChannel).toBe(SourceChannel.WEB);
    // The purchase projection does not grow a channel field for the client.
    expect(Object.keys(created.body.purchase)).not.toContain('sourceChannel');

    await deliver(paidOrder(purchase.paymentReference!, `order-${uniqueSuffix()}`)).expect(200);
    const event = await eventOf(`PACKAGE_PAYMENT_SUCCEEDED:${purchase.id}`);
    expect(event).toMatchObject({ status: CampaignTriggerEventStatus.PENDING, sourceChannel: SourceChannel.WEB });
  });

  it('package purchase route: WEB for the provider account itself, UNKNOWN for an operator acting for the business', async () => {
    const { provider, cookie } = await newProvider({ status: ProviderStatus.APPROVED });
    const { cookie: adminCookie } = await admin();

    const own = await mockPurchase(provider.id, cookie, cookie, { [CLIENT_CHANNEL_HEADER]: 'mobile' });
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: own } })).sourceChannel).toBe(SourceChannel.WEB);
    expect((await eventOf(`PACKAGE_PAYMENT_SUCCEEDED:${own}`)).sourceChannel).toBe(SourceChannel.WEB);

    const byOperator = await mockPurchase(provider.id, adminCookie, cookie, { [CLIENT_CHANNEL_HEADER]: 'web' });
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: byOperator } })).sourceChannel).toBe(SourceChannel.UNKNOWN);
    expect((await eventOf(`PACKAGE_PAYMENT_SUCCEEDED:${byOperator}`)).sourceChannel).toBe(SourceChannel.UNKNOWN);
  });

  it('application: WEB for a guest applying through the web route (header ignored), UNKNOWN for an operator; approval inherits it', async () => {
    const category = await createCategory(ctx.prisma);
    const { cookie: adminCookie } = await admin();

    const guest = await request(ctx.server)
      .post('/providers')
      .set(CLIENT_CHANNEL_HEADER, 'mobile')
      .send(providerPayload([category.id]))
      .expect(201);
    const operator = await request(ctx.server).post('/providers').set('Cookie', adminCookie).send(providerPayload([category.id])).expect(201);

    const guestRow = await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: guest.body.id as string } });
    const operatorRow = await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: operator.body.id as string } });
    expect(guestRow.applicationSourceChannel).toBe(SourceChannel.WEB);
    expect(operatorRow.applicationSourceChannel).toBe(SourceChannel.UNKNOWN);
    expect(Object.keys(guest.body)).not.toContain('applicationSourceChannel');

    await approve(adminCookie, guestRow.id).expect(200);
    await approve(adminCookie, operatorRow.id).expect(200);
    expect((await eventOf(`PROVIDER_APPROVED:${guestRow.id}`)).sourceChannel).toBe(SourceChannel.WEB);
    expect((await eventOf(`PROVIDER_APPROVED:${operatorRow.id}`)).sourceChannel).toBe(SourceChannel.UNKNOWN);
  });

  it('eligibility: the proof that completes the set lends its channel — the e-mail link and the OTP route are WEB', async () => {
    await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: ['EMAIL_VERIFIED', 'PHONE_VERIFIED'] });

    // E-mail last: phone already proven on the account.
    const first = await newProvider({ phone: true });
    await request(ctx.server).post('/auth/email-verification/resend').set('Cookie', first.cookie).expect(201);
    const mail = ctx.notifications.ofTemplate('provider-email-verification').at(-1)!;
    const token = new URL(mail.actionUrl!).searchParams.get('token')!;
    await request(ctx.server).post('/auth/email-verification/confirm').set(CLIENT_CHANNEL_HEADER, 'mobile').send({ token }).expect(201);
    expect((await eventOf(`PROVIDER_ELIGIBILITY_REACHED:EMAIL_VERIFIED+PHONE_VERIFIED:${first.provider.id}`)).sourceChannel).toBe(
      SourceChannel.WEB,
    );

    // Phone last: e-mail already proven.
    const second = await newProvider({ email: true });
    await request(ctx.server).post('/providers/me/phone-verification').set('Cookie', second.cookie).expect(201);
    await request(ctx.server)
      .post('/providers/me/phone-verification/verify')
      .set('Cookie', second.cookie)
      .set(CLIENT_CHANNEL_HEADER, 'mobile')
      .send({ code: ctx.sms.lastCode() })
      .expect(201);
    expect((await eventOf(`PROVIDER_ELIGIBILITY_REACHED:EMAIL_VERIFIED+PHONE_VERIFIED:${second.provider.id}`)).sourceChannel).toBe(
      SourceChannel.WEB,
    );
  });

  it('eligibility completed by the approval takes the application channel — UNKNOWN for a profile that predates it', async () => {
    await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_ELIGIBILITY_REACHED', facts: ['EMAIL_VERIFIED', 'PROVIDER_APPROVED'] });
    const { cookie: adminCookie } = await admin();
    const web = await newProvider({ email: true, applicationSourceChannel: SourceChannel.WEB });
    const legacy = await newProvider({ email: true });

    await approve(adminCookie, web.provider.id).expect(200);
    await approve(adminCookie, legacy.provider.id).expect(200);

    const key = (id: string) => `PROVIDER_ELIGIBILITY_REACHED:EMAIL_VERIFIED+PROVIDER_APPROVED:${id}`;
    expect((await eventOf(key(web.provider.id))).sourceChannel).toBe(SourceChannel.WEB);
    expect((await eventOf(key(legacy.provider.id))).sourceChannel).toBe(SourceChannel.UNKNOWN);
  });
});

// ───────────────────────── 3. the engine's judgement ─────────────────────────

describe('the engine judges by the event row', () => {
  it('UNKNOWN event: WEB and MOBILE versions log CHANNEL_MISMATCH and grant nothing; the event ends EVALUATED, not RETRY_WAIT', async () => {
    const web = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', channel: 'WEB', credits: 30 });
    const mobile = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', channel: 'MOBILE', credits: 40 });
    const { provider, cookie } = await newProvider({ status: ProviderStatus.APPROVED });
    const { cookie: adminCookie } = await admin();

    const purchaseId = await mockPurchase(provider.id, adminCookie, cookie);
    const run = await worker.runOnce();
    expect(run.claimed).toBe(1);

    expect(await logsOf(web.campaign.id)).toEqual([{ outcome: 'CHANNEL_MISMATCH', reasonCode: 'SOURCE_UNKNOWN' }]);
    expect(await logsOf(mobile.campaign.id)).toEqual([{ outcome: 'CHANNEL_MISMATCH', reasonCode: 'SOURCE_UNKNOWN' }]);
    const event = await eventOf(`PACKAGE_PAYMENT_SUCCEEDED:${purchaseId}`);
    expect(event).toMatchObject({ status: CampaignTriggerEventStatus.EVALUATED, lastErrorCode: null, settledByCampaignId: null });
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect(await ctx.prisma.promoCreditLot.count()).toBe(0);
    expect(await ctx.prisma.campaignProviderCounter.count()).toBe(0);
    expect(await ctx.prisma.campaignDailyCounter.count()).toBe(0);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: CreditTransactionType.CAMPAIGN_GRANT } })).toBe(0);
    for (const { campaign } of [web, mobile]) {
      expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ redemptionCount: 0, budgetConsumedCredits: 0 });
    }
  });

  it('UNKNOWN event with an ALL version beside a WEB one: ALL grants under the usual rules, WEB is a mismatch, not a stack loser', async () => {
    const web = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', channel: 'WEB', credits: 50 });
    const all = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 10 });
    const { provider, cookie } = await newProvider({ status: ProviderStatus.APPROVED });
    const { cookie: adminCookie } = await admin();

    await mockPurchase(provider.id, adminCookie, cookie);
    await worker.runOnce();

    expect(await logsOf(web.campaign.id)).toEqual([{ outcome: 'CHANNEL_MISMATCH', reasonCode: 'SOURCE_UNKNOWN' }]);
    expect(await logsOf(all.campaign.id)).toEqual([{ outcome: 'GRANTED', reasonCode: null }]);
    const redemptions = await ctx.prisma.campaignRedemption.findMany();
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]).toMatchObject({ campaignId: all.campaign.id, grantedCredits: 10 });
  });

  it('WEB event: the WEB version wins by the usual stack order; MOBILE is a mismatch with SOURCE_WEB; ALL loses the stack', async () => {
    const web = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', channel: 'WEB', credits: 20 });
    const mobile = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', channel: 'MOBILE', credits: 90 });
    const all = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 10 });
    const { provider, cookie } = await newProvider({ status: ProviderStatus.APPROVED });

    await mockPurchase(provider.id, cookie, cookie);
    await worker.runOnce();

    expect(await logsOf(mobile.campaign.id)).toEqual([{ outcome: 'CHANNEL_MISMATCH', reasonCode: 'SOURCE_WEB' }]);
    expect(await logsOf(web.campaign.id)).toEqual([{ outcome: 'GRANTED', reasonCode: null }]);
    expect(await logsOf(all.campaign.id)).toEqual([{ outcome: 'STACK_CONFLICT', reasonCode: null }]);
    expect(await ctx.prisma.campaignRedemption.findMany({ select: { campaignId: true, grantedCredits: true } })).toEqual([
      { campaignId: web.campaign.id, grantedCredits: 20 },
    ]);
  });

  it('limits still refuse after the channel passes: a WEB version with an exhausted budget answers BUDGET_EXHAUSTED', async () => {
    const web = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', channel: 'WEB', credits: 10, budgetCredits: 10 });
    await ctx.prisma.campaign.update({ where: { id: web.campaign.id }, data: { budgetConsumedCredits: 10 } });
    const { provider, cookie } = await newProvider({ status: ProviderStatus.APPROVED });

    await mockPurchase(provider.id, cookie, cookie);
    await worker.runOnce();

    expect(await logsOf(web.campaign.id)).toEqual([{ outcome: 'BUDGET_EXHAUSTED', reasonCode: null }]);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
  });
});

// ───────────────────── 4. no second event, no second grant ─────────────────────

describe('the channel never makes a second event or a second grant', () => {
  it('re-raising the same key with another channel leaves the event as born; the worker grants once', async () => {
    const web = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', channel: 'WEB', credits: 10 });
    const { provider, cookie } = await newProvider({ status: ProviderStatus.APPROVED });
    const purchaseId = await mockPurchase(provider.id, cookie, cookie);
    const key = `PACKAGE_PAYMENT_SUCCEEDED:${purchaseId}`;
    expect((await eventOf(key)).sourceChannel).toBe(SourceChannel.WEB);

    await worker.runOnce();
    expect(await ctx.prisma.campaignRedemption.count()).toBe(1);

    // The purchase's channel is immutable too, so the only way to "derive
    // another channel" is to raise the key again with one: through the hook's
    // repository write, as a replayed settlement would.
    await ctx.prisma.$transaction(async (tx) => {
      const repository = (hooks as unknown as { repository: { ensurePendingEvent: Function } }).repository;
      for (const sourceChannel of [SourceChannel.MOBILE, SourceChannel.UNKNOWN]) {
        const ensured = await repository.ensurePendingEvent(
          tx,
          { triggerEventKey: key, trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: provider.id, purchaseId, factSetKey: null, sourceChannel },
          new Date(),
        );
        expect(ensured.created).toBe(false);
      }
    });
    await hooks.packagePaymentSucceeded(ctx.prisma, provider.id, purchaseId);

    expect(await ctx.prisma.campaignTriggerEvent.count({ where: { purchaseId } })).toBe(1);
    expect(await eventOf(key)).toMatchObject({ sourceChannel: SourceChannel.WEB, status: CampaignTriggerEventStatus.SETTLED });
    await worker.runOnce();
    expect(await ctx.prisma.campaignRedemption.count({ where: { campaignId: web.campaign.id } })).toBe(1);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: CreditTransactionType.CAMPAIGN_GRANT } })).toBe(1);
  });

  it('an EVALUATED mismatch re-raised is re-evaluated against its stored channel and still grants nothing', async () => {
    const web = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', channel: 'WEB', credits: 10 });
    const { provider, cookie } = await newProvider({ status: ProviderStatus.APPROVED });
    const { cookie: adminCookie } = await admin();
    const purchaseId = await mockPurchase(provider.id, adminCookie, cookie);
    await worker.runOnce();

    await ctx.prisma.$transaction(async (tx) => {
      const repository = (hooks as unknown as { repository: { ensurePendingEvent: Function } }).repository;
      await repository.ensurePendingEvent(
        tx,
        { triggerEventKey: `PACKAGE_PAYMENT_SUCCEEDED:${purchaseId}`, trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: provider.id, purchaseId, factSetKey: null, sourceChannel: SourceChannel.WEB },
        new Date(),
      );
    });
    await worker.runOnce();

    expect(await logsOf(web.campaign.id)).toEqual([
      { outcome: 'CHANNEL_MISMATCH', reasonCode: 'SOURCE_UNKNOWN' },
      { outcome: 'CHANNEL_MISMATCH', reasonCode: 'SOURCE_UNKNOWN' },
    ]);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
  });

  it('the database refuses to change a channel after insert — event, version, purchase and application', async () => {
    const { version } = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', channel: 'WEB' });
    const { provider, cookie } = await newProvider({ status: ProviderStatus.APPROVED, applicationSourceChannel: SourceChannel.WEB });
    const purchaseId = await mockPurchase(provider.id, cookie, cookie);
    const event = await eventOf(`PACKAGE_PAYMENT_SUCCEEDED:${purchaseId}`);

    const refused = /written on insert and never changed/;
    await expect(ctx.prisma.campaignTriggerEvent.update({ where: { id: event.id }, data: { sourceChannel: 'MOBILE' } })).rejects.toThrow(refused);
    await expect(ctx.prisma.campaignVersion.update({ where: { id: version.id }, data: { channel: 'ALL' } })).rejects.toThrow(refused);
    await expect(ctx.prisma.packagePurchase.update({ where: { id: purchaseId }, data: { sourceChannel: 'UNKNOWN' } })).rejects.toThrow(refused);
    await expect(
      ctx.prisma.providerProfile.update({ where: { id: provider.id }, data: { applicationSourceChannel: 'MOBILE' } }),
    ).rejects.toThrow(refused);

    // Writing the same value is not a change, and other columns stay writable.
    await ctx.prisma.campaignTriggerEvent.update({ where: { id: event.id }, data: { sourceChannel: 'WEB', lastSeenAt: new Date() } });
    await ctx.prisma.providerProfile.update({ where: { id: provider.id }, data: { description: 'Güncel açıklama' } });
  });
});

// ─────────────────────────── 5. activation ───────────────────────────

describe('activation gate', () => {
  const K2 = (channel?: string) => ({
    schemaVersion: 1,
    trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
    conditions: { all: [{ type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' }] },
    benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 30 },
    limits: { maxRedemptionsPerProvider: 1, maxRedemptionsGlobal: null, maxRedemptionsPerDay: null, budgetCredits: null, maxRevokesPerDay: null },
    window: { startAt: null, endAt: null },
    stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
    priority: 100,
    ...(channel ? { channel } : {}),
  });
  const K1_MOBILE = {
    ...K2('MOBILE'),
    trigger: 'PROVIDER_ELIGIBILITY_REACHED',
    eligibility: { facts: ['EMAIL_VERIFIED', 'PHONE_VERIFIED'] },
    conditions: { all: [] },
  };

  async function draft(cookie: string, definition: Record<string, unknown>) {
    const key = `kanal-${uniqueSuffix()}`;
    const created = await request(ctx.server).post('/admin/campaigns').set('Cookie', cookie).send({ key, name: 'Kanal', definition }).expect(201);
    return created.body as { campaign: { id: string }; currentVersion: { id: string; versionNumber: number; channel: string } };
  }

  const activate = (cookie: string, id: string, versionNumber: number) =>
    request(ctx.server).post(`/admin/campaigns/${id}/versions/${versionNumber}/activate`).set('Cookie', cookie).send({});

  async function snapshot() {
    return {
      campaigns: await ctx.prisma.campaign.findMany({ select: { id: true, status: true, activeVersionId: true, updatedAt: true }, orderBy: { id: 'asc' } }),
      versions: await ctx.prisma.campaignVersion.count(),
      audit: await ctx.prisma.campaignAuditLog.count(),
      engine: await engineWriteSnapshot(ctx.prisma),
    };
  }

  it('MOBILE is refused with CHANNEL_SOURCE_UNAVAILABLE and writes nothing; the panel is told why before anyone presses', async () => {
    const { cookie } = await admin();
    for (const definition of [K2('MOBILE'), K1_MOBILE]) {
      const { campaign, currentVersion } = await draft(cookie, definition);
      expect(currentVersion.channel).toBe('MOBILE');

      const detail = await request(ctx.server).get(`/admin/campaigns/${campaign.id}`).set('Cookie', cookie).expect(200);
      expect(detail.body.currentVersionChannel).toMatchObject({ channel: 'MOBILE', available: false });
      expect(detail.body.currentVersionChannel.missingSources.length).toBeGreaterThan(0);

      const before = await snapshot();
      const refused = await activate(cookie, campaign.id, currentVersion.versionNumber).expect(400);
      expect(refused.body.code).toBe('CAMPAIGN_ACTIVATION_REFUSED');
      expect(refused.body.errors).toEqual([
        expect.objectContaining({ path: 'channel', code: 'CHANNEL_SOURCE_UNAVAILABLE', message: expect.stringContaining('MOBILE') }),
      ]);
      expect(await snapshot()).toEqual(before);
    }
  });

  it('WEB and ALL activate on today’s web sources; the audit snapshot names the channel', async () => {
    const { cookie } = await admin();
    for (const [definition, channel] of [[K2('WEB'), 'WEB'], [K2(), 'ALL']] as const) {
      const { campaign, currentVersion } = await draft(cookie, definition);
      const detail = await request(ctx.server).get(`/admin/campaigns/${campaign.id}`).set('Cookie', cookie).expect(200);
      expect(detail.body.currentVersionChannel).toEqual({ channel, available: true, missingSources: [] });

      const activated = await activate(cookie, campaign.id, currentVersion.versionNumber).expect(201);
      expect(activated.body.campaign.status).toBe('ACTIVE');
      expect(activated.body.activeVersion.channel).toBe(channel);
      expect(activated.body.activeVersionChannel).toEqual({ channel, available: true, missingSources: [] });
      const audit = await ctx.prisma.campaignAuditLog.findMany({ where: { campaignId: campaign.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      expect(audit.find((row) => row.action === CampaignAuditAction.VERSION_CREATED)?.summary).toMatchObject({ channel });
      expect(audit.find((row) => row.action === CampaignAuditAction.VERSION_ACTIVATED)?.summary).toMatchObject({ channel });
    }
  });

  it('the gate is mechanical: take the WEB producer away and a WEB version is refused too', async () => {
    const { cookie } = await admin();
    const { campaign, currentVersion } = await draft(cookie, K2('WEB'));
    vi.spyOn(registry, 'hasChannelProducer').mockReturnValue(false);
    const refused = await activate(cookie, campaign.id, currentVersion.versionNumber).expect(400);
    expect(refused.body.errors).toEqual([
      expect.objectContaining({ path: 'channel', code: 'CHANNEL_SOURCE_UNAVAILABLE', message: expect.stringContaining('PACKAGE_PAYMENT_SUCCEEDED') }),
    ]);
  });

  it('a running version’s channel changes only through a new version; the revision reports `channel` as changed', async () => {
    await setEngineEnabled(ctx.prisma, true);
    const { cookie } = await admin();
    const { campaign, currentVersion } = await draft(cookie, K2('WEB'));
    await activate(cookie, campaign.id, currentVersion.versionNumber).expect(201);

    const revised = await request(ctx.server).post(`/admin/campaigns/${campaign.id}/versions`).set('Cookie', cookie).send({ definition: K2() }).expect(201);
    expect(revised.body.currentVersion).toMatchObject({ versionNumber: 2, channel: 'ALL' });
    expect(revised.body.activeVersion).toMatchObject({ versionNumber: 1, channel: 'WEB' });
    const v1 = await ctx.prisma.campaignVersion.findUniqueOrThrow({ where: { id: currentVersion.id } });
    expect(v1.channel).toBe('WEB');
    const created = await ctx.prisma.campaignAuditLog.findFirstOrThrow({
      where: { campaignId: campaign.id, action: CampaignAuditAction.VERSION_CREATED, campaignVersionId: revised.body.currentVersion.id },
    });
    expect(created.summary).toMatchObject({ channel: 'ALL', changedFields: ['channel'] });

    // An invalid channel is a definition error, refused before any write.
    const bad = await request(ctx.server).post(`/admin/campaigns/${campaign.id}/versions`).set('Cookie', cookie).send({ definition: K2('web') }).expect(400);
    expect(bad.body.errors).toEqual([expect.objectContaining({ path: 'channel', code: 'CHANNEL_INVALID' })]);
    expect(await ctx.prisma.campaignVersion.count({ where: { campaignId: campaign.id } })).toBe(2);
  });

  it('the operations desk lists each event with its source channel', async () => {
    const { cookie: adminCookie } = await admin();
    const { campaign } = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', channel: 'WEB' });
    const { provider, cookie } = await newProvider({ status: ProviderStatus.APPROVED });
    await mockPurchase(provider.id, cookie, cookie);
    await mockPurchase(provider.id, adminCookie, cookie);

    const listed = await request(ctx.server).get(`/admin/campaigns/${campaign.id}/evaluation-events`).set('Cookie', adminCookie).expect(200);
    expect((listed.body.items as Array<{ sourceChannel: string }>).map((item) => item.sourceChannel).sort()).toEqual(['UNKNOWN', 'WEB']);
  });
});

// ─────────────────────────── 6. engine off ───────────────────────────

describe('with the engine switch off', () => {
  it('the business rows carry their channel and no campaign row of any kind appears', async () => {
    await setEngineEnabled(ctx.prisma, false);
    await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', channel: 'WEB' });
    const { provider, cookie } = await newProvider({ status: ProviderStatus.APPROVED });
    const before = await engineWriteSnapshot(ctx.prisma);

    const purchaseId = await mockPurchase(provider.id, cookie, cookie);

    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchaseId } })).sourceChannel).toBe(SourceChannel.WEB);
    const after = await engineWriteSnapshot(ctx.prisma);
    expect({ ...after, ledgerRows: before.ledgerRows }).toEqual(before);
    expect(after.triggerEvents).toBe(0);
    expect(after.evaluationLogs).toBe(0);
  });
});
