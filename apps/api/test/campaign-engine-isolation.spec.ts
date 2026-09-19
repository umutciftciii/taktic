import {
  CreditTransactionType,
  OfferPackageType,
  PackagePurchaseStatus,
  ProviderStatus,
  UserRole,
} from '@prisma/client';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LemonSqueezyCheckoutAdapter } from '../src/modules/payments/lemon-squeezy.adapter';
import { LEMON_SQUEEZY_SIGNATURE_HEADER } from '../src/modules/payments/lemon-squeezy.webhook';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createOfferPackage,
  createProviderProfile,
  createTestApp,
  createUser,
  currentCreditBalance,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  resetAuthThrottle,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * CMP-002 S0/S1 ships definitions and drafts, and nothing that acts on them.
 *
 * This file drives every flow the future engine will hook — a provider being
 * approved, an account proving its e-mail and its telephone, a package
 * settling through the real webhook and through the mock path, an offer
 * spending credit — with a draft campaign sitting in the database, and
 * asserts that the campaign tables gained nothing, the ledger carries only
 * the six pre-existing transaction types, and no balance moved except where
 * the flow itself always moved it.
 */

const PLACEHOLDER_API_KEY = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.${'placeholderNotARealCredential'}`;
const WEBHOOK_SECRET = 'placeholder-webhook-secret-not-real';
const STORE_ID = '424242';
const VARIANT_ID = '778899';
const PRICE = 49900;
const MANAGED_KEYS = [
  'PAYMENT_PROVIDER',
  'LEMON_SQUEEZY_API_KEY',
  'LEMON_SQUEEZY_STORE_ID',
  'LEMON_SQUEEZY_WEBHOOK_SECRET',
  'LEMON_SQUEEZY_VARIANT_MAP',
  'WEB_ORIGIN',
] as const;

const LEDGER_TYPES_BEFORE_CMP002 = [
  'ADMIN_GRANT',
  'ADMIN_DEDUCT',
  'PACKAGE_PURCHASE',
  'OFFER_SPEND',
  'OFFER_REFUND',
  'ADJUSTMENT',
];

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

/** A draft campaign for each trigger, so "no evaluation" is asserted with candidates present. */
async function seedDrafts() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  const cookie = await loginAs(ctx.prisma, admin.id);
  const base = {
    benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 30 },
    limits: { maxRedemptionsPerProvider: 1 },
    window: {},
    stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
    priority: 100,
    schemaVersion: 1,
  };
  const definitions = [
    { ...base, trigger: 'PROVIDER_APPROVED', conditions: { all: [{ type: 'FIRST_PROVIDER_APPROVAL' }] } },
    { ...base, trigger: 'PACKAGE_PAYMENT_SUCCEEDED', conditions: { all: [{ type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' }] } },
    {
      ...base,
      trigger: 'PROVIDER_ELIGIBILITY_REACHED',
      eligibility: { facts: ['PROVIDER_APPROVED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED'] },
      conditions: { all: [] },
    },
  ];
  for (const definition of definitions) {
    await request(ctx.server)
      .post('/admin/campaigns')
      .set('Cookie', cookie)
      .send({ key: `taslak-${uniqueSuffix()}`, name: 'Taslak', definition })
      .expect(201);
  }
  return { admin, cookie, snapshot: await campaignSnapshot() };
}

async function campaignSnapshot() {
  return {
    campaigns: await ctx.prisma.campaign.count(),
    versions: await ctx.prisma.campaignVersion.count(),
    audit: await ctx.prisma.campaignAuditLog.count(),
    engineEnabled: (await ctx.prisma.operationsSettings.findUnique({ where: { id: 'singleton' } }))?.campaignEngineEnabled ?? false,
  };
}

async function ledgerTypes() {
  const rows = await ctx.prisma.providerCreditTransaction.findMany({ select: { type: true } });
  return [...new Set(rows.map((row) => row.type))].sort();
}

async function expectNothingCampaignRelated(snapshot: Awaited<ReturnType<typeof campaignSnapshot>>) {
  expect(await campaignSnapshot()).toEqual(snapshot);
  expect(snapshot.engineEnabled).toBe(false);
  for (const type of await ledgerTypes()) {
    expect(LEDGER_TYPES_BEFORE_CMP002).toContain(type);
  }
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

describe('with draft campaigns in the database', () => {
  it('a provider approval writes the profile status and nothing else', async () => {
    const { cookie, snapshot } = await seedDrafts();
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status: ProviderStatus.PENDING_REVIEW });

    await request(ctx.server)
      .patch(`/providers/${provider.id}/status`)
      .set('Cookie', cookie)
      .send({ status: ProviderStatus.APPROVED })
      .expect(200);

    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.APPROVED);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
    await expectNothingCampaignRelated(snapshot);
  });

  it('an e-mail proof and a telephone proof write the two account columns and nothing else', async () => {
    const { snapshot } = await seedDrafts();
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: '05553334455' });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status: ProviderStatus.APPROVED });
    const cookie = await loginAs(ctx.prisma, owner.id);

    await request(ctx.server).post('/auth/email-verification/resend').set('Cookie', cookie).expect(201);
    const mail = ctx.notifications.ofTemplate('provider-email-verification')[0]!;
    const token = new URL(mail.actionUrl!).searchParams.get('token')!;
    await request(ctx.server).post('/auth/email-verification/confirm').send({ token }).expect(201);

    await request(ctx.server).post('/providers/me/phone-verification').set('Cookie', cookie).expect(201);
    await request(ctx.server)
      .post('/providers/me/phone-verification/verify')
      .set('Cookie', cookie)
      .send({ code: ctx.sms.lastCode() })
      .expect(201);

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.phoneVerifiedAt).not.toBeNull();
    // All three eligibility facts now hold for this provider — and no
    // eligibility transition was evaluated, because there is nothing to do so.
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
    await expectNothingCampaignRelated(snapshot);
  });

  it('a settled webhook payment loads the package credits and nothing else', async () => {
    const { snapshot } = await seedDrafts();
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status: ProviderStatus.APPROVED });
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.ONE_TIME_CREDITS, creditAmount: 25, priceAmount: PRICE });
    process.env.PAYMENT_PROVIDER = 'lemon-squeezy-test';
    process.env.LEMON_SQUEEZY_API_KEY = PLACEHOLDER_API_KEY;
    process.env.LEMON_SQUEEZY_STORE_ID = STORE_ID;
    process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.LEMON_SQUEEZY_VARIANT_MAP = `${pkg.slug}:${VARIANT_ID}`;
    process.env.WEB_ORIGIN = 'https://web.example.test';
    const cookie = await loginAs(ctx.prisma, owner.id);

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: pkg.id })
      .expect(201);
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: created.body.purchase.id as string } });

    await deliver({
      meta: { event_name: 'order_created', test_mode: true, custom_data: { purchase_reference: purchase.paymentReference } },
      data: {
        type: 'orders',
        id: 'order-991',
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
    }).expect(200);

    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe(PackagePurchaseStatus.PAID);
    // Exactly the package's credits, from exactly one PACKAGE_PURCHASE row.
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);
    expect(await ctx.prisma.providerCreditTransaction.findMany({ where: { providerId: provider.id }, select: { type: true, amount: true } })).toEqual([
      { type: CreditTransactionType.PACKAGE_PURCHASE, amount: 25 },
    ]);
    await expectNothingCampaignRelated(snapshot);
  });

  it('a mock-settled period purchase grants the period and nothing else', async () => {
    const { snapshot } = await seedDrafts();
    process.env.PAYMENT_PROVIDER = 'mock';
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status: ProviderStatus.APPROVED });
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.MONTHLY_QUOTA, quotaCredits: 15 });
    const cookie = await loginAs(ctx.prisma, owner.id);

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases`)
      .set('Cookie', cookie)
      .send({ packageId: pkg.id })
      .expect(201);
    await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases/${created.body.id}/mock-pay`)
      .set('Cookie', cookie)
      .send({ cardholderName: 'Test Kullanıcı', cardNumber: '4242424242424242', expiryMonth: 12, expiryYear: new Date().getFullYear() + 2, cvv: '123' })
      .expect(201);

    expect(await ctx.prisma.providerPackageEntitlement.count({ where: { providerId: provider.id } })).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
    await expectNothingCampaignRelated(snapshot);
  });

  it('an offer spends the category price from the paid balance and nothing else', async () => {
    const { snapshot } = await seedDrafts();
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id });
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
    const cookie = await loginAs(ctx.prisma, owner.id);
    await grantCredits(ctx.prisma, provider.id, 10);

    await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);

    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(8);
    expect(await ledgerTypes()).toEqual([CreditTransactionType.ADMIN_GRANT, CreditTransactionType.OFFER_SPEND]);
    await expectNothingCampaignRelated(snapshot);
  });
});
