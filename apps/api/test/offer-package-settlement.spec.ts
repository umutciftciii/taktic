import {
  CreditTransactionType,
  EntitlementRenewalFailureCode,
  EntitlementRenewalStatus,
  OfferPackageType,
  PackagePurchaseStatus,
  PaymentWebhookEventStatus,
  ProviderEntitlementStatus,
  UserRole,
} from '@prisma/client';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LemonSqueezyCheckoutAdapter } from '../src/modules/payments/lemon-squeezy.adapter';
import { LEMON_SQUEEZY_SIGNATURE_HEADER } from '../src/modules/payments/lemon-squeezy.webhook';
import {
  createCategory,
  createOfferPackage,
  createProviderProfile,
  createTestApp,
  createUser,
  currentCreditBalance,
  loginAs,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * What a settled payment produces for the two period products, and what a
 * second delivery of the same payment does not produce.
 *
 * The whole file runs against the real webhook endpoint with real signatures,
 * because the claim being tested is about the only path in this application
 * that may grant anything from a payment.
 */
const PLACEHOLDER_API_KEY = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.${'placeholderNotARealCredential'}`;
const WEBHOOK_SECRET = 'placeholder-webhook-secret-not-real';
const STORE_ID = '424242';
const VARIANT_ID = '778899';
const WEBHOOK_PATH = '/payments/lemon-squeezy/webhook';
const HOSTED_URL = 'https://taktic-sandbox.lemonsqueezy.test/checkout/abc123';
const PRICE = 49900;

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
        data: { type: 'checkouts', id: 'checkout-abc-123', attributes: { url: HOSTED_URL } },
      }),
    })),
  });
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  original = Object.fromEntries(MANAGED_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function configureLemonSqueezy(packageSlug: string) {
  process.env.PAYMENT_PROVIDER = 'lemon-squeezy-test';
  process.env.LEMON_SQUEEZY_API_KEY = PLACEHOLDER_API_KEY;
  process.env.LEMON_SQUEEZY_STORE_ID = STORE_ID;
  process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.LEMON_SQUEEZY_VARIANT_MAP = `${packageSlug}:${VARIANT_ID}`;
  process.env.WEB_ORIGIN = 'https://web.example.test';
}

async function pendingPeriodPurchase(options: {
  type: OfferPackageType;
  quotaCredits?: number;
  dailyOfferLimit?: number | null;
  scopeCategoryIds?: string[];
}) {
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, { userId: ownerUser.id });
  const pkg = await createOfferPackage(ctx.prisma, {
    type: options.type,
    priceAmount: PRICE,
    quotaCredits: options.quotaCredits,
    dailyOfferLimit: options.dailyOfferLimit ?? null,
    scopeCategoryIds: options.scopeCategoryIds,
  });

  configureLemonSqueezy(pkg.slug);
  const cookie = await loginAs(ctx.prisma, ownerUser.id);

  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/checkout-sessions`)
    .set('Cookie', cookie)
    .send({ packageId: pkg.id })
    .expect(201);

  const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
    where: { id: created.body.purchase.id as string },
  });

  return { ownerUser, provider, pkg, cookie, purchase, reference: purchase.paymentReference! };
}

function orderPayload(overrides: { reference: string; orderId?: string }) {
  return {
    meta: {
      event_name: 'order_created',
      test_mode: true,
      custom_data: { purchase_reference: overrides.reference },
    },
    data: {
      type: 'orders',
      id: overrides.orderId ?? 'order-991',
      attributes: {
        store_id: Number(STORE_ID),
        status: 'paid',
        total: PRICE + 2,
        currency: 'TRY',
        user_name: 'Ayşe Yılmaz',
        user_email: 'ayse.yilmaz@example.test',
        first_order_item: { variant_id: Number(VARIANT_ID), price: PRICE, quantity: 1 },
      },
    },
  };
}

function deliver(payload: unknown) {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(Buffer.from(body, 'utf8'))
    .digest('hex');

  return request(ctx.server)
    .post(WEBHOOK_PATH)
    .set('content-type', 'application/json')
    .set(LEMON_SQUEEZY_SIGNATURE_HEADER, signature)
    .send(body);
}

describe('a settled payment for a period package', () => {
  it('grants a 30-day quota period and moves no credit balance', async () => {
    const { provider, reference, purchase } = await pendingPeriodPurchase({
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 40,
    });

    await deliver(orderPayload({ reference })).expect(200);

    const entitlement = await ctx.prisma.providerPackageEntitlement.findFirstOrThrow({
      where: { providerId: provider.id },
    });

    expect(entitlement.type).toBe(OfferPackageType.MONTHLY_QUOTA);
    expect(entitlement.purchaseId).toBe(purchase.id);
    expect(entitlement.quotaCreditsSnapshot).toBe(40);
    expect(entitlement.remainingQuota).toBe(40);
    expect(entitlement.periodDaysSnapshot).toBe(30);
    expect(entitlement.status).toBe(ProviderEntitlementStatus.ACTIVE);
    // Exactly thirty days, measured from the settlement instant.
    expect(entitlement.endAt.getTime() - entitlement.startAt.getTime()).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
    // Auto-renew is never on because somebody bought something.
    expect(entitlement.autoRenewEnabled).toBe(false);
    expect(entitlement.autoRenewConsentAt).toBeNull();
    expect(entitlement.paymentMethodReference).toBeNull();

    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
    expect(
      await ctx.prisma.providerCreditTransaction.count({
        where: { providerId: provider.id, type: CreditTransactionType.PACKAGE_PURCHASE },
      }),
    ).toBe(0);

    const settled = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(settled.status).toBe(PackagePurchaseStatus.PAID);
    expect(settled.creditTransactionId).toBeNull();
  });

  it('freezes the category scope, expanding groups once at purchase time', async () => {
    const group = await createCategory(ctx.prisma, 'Grup', { kind: 'GROUP' as never });
    const leaf = await createCategory(ctx.prisma, 'Yaprak', {
      parentId: group.id,
      offerCreditCost: 2,
    });

    const { provider, reference } = await pendingPeriodPurchase({
      type: OfferPackageType.CATEGORY_UNLIMITED,
      dailyOfferLimit: 5,
      scopeCategoryIds: [group.id],
    });

    await deliver(orderPayload({ reference })).expect(200);

    const entitlement = await ctx.prisma.providerPackageEntitlement.findFirstOrThrow({
      where: { providerId: provider.id },
      include: { scopes: true },
    });

    expect(entitlement.dailyOfferLimitSnapshot).toBe(5);
    const byCategory = new Map(entitlement.scopes.map((scope) => [scope.categoryId, scope]));
    expect(byCategory.get(group.id)?.selected).toBe(true);
    // The descendant is frozen in at purchase time, not walked at offer time.
    expect(byCategory.get(leaf.id)?.selected).toBe(false);
    expect(byCategory.get(leaf.id)?.categoryNameSnapshot).toBe(leaf.name);
  });

  it('keeps the entitlement price when the package is repriced afterwards', async () => {
    const { provider, pkg, reference } = await pendingPeriodPurchase({
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 12,
    });

    await deliver(orderPayload({ reference })).expect(200);

    await ctx.prisma.offerCreditPackage.update({
      where: { id: pkg.id },
      data: { priceAmount: 999_900, name: 'Yeniden adlandırıldı', quotaCredits: 999 },
    });

    const entitlement = await ctx.prisma.providerPackageEntitlement.findFirstOrThrow({
      where: { providerId: provider.id },
    });
    expect(entitlement.priceAmountSnapshot).toBe(PRICE);
    expect(entitlement.quotaCreditsSnapshot).toBe(12);
    expect(entitlement.packageNameSnapshot).toBe(pkg.name);
  });

  it('grants exactly one period however many times the event is redelivered', async () => {
    const { provider, reference } = await pendingPeriodPurchase({
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 40,
    });

    const payload = orderPayload({ reference });
    await deliver(payload).expect(200);
    await deliver(payload).expect(200);
    await deliver(payload).expect(200);

    expect(
      await ctx.prisma.providerPackageEntitlement.count({ where: { providerId: provider.id } }),
    ).toBe(1);

    const event = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({});
    expect(event.status).toBe(PaymentWebhookEventStatus.PROCESSED);
    expect(event.attemptCount).toBe(3);
  });

  it('grants exactly one period when two deliveries race', async () => {
    const { provider, reference } = await pendingPeriodPurchase({
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 40,
    });

    const payload = orderPayload({ reference });
    await Promise.all([deliver(payload), deliver(payload), deliver(payload)]);

    expect(
      await ctx.prisma.providerPackageEntitlement.count({ where: { providerId: provider.id } }),
    ).toBe(1);
  });

  it('grants nothing when the payment did not settle', async () => {
    const { provider, reference, purchase } = await pendingPeriodPurchase({
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 40,
    });

    const payload = orderPayload({ reference });
    payload.data.attributes.status = 'pending';

    await deliver(payload).expect(200);

    expect(
      await ctx.prisma.providerPackageEntitlement.count({ where: { providerId: provider.id } }),
    ).toBe(0);
    const stored = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(stored.status).toBe(PackagePurchaseStatus.PENDING);
  });

  it('grants nothing when the signature is wrong', async () => {
    const { provider, reference } = await pendingPeriodPurchase({
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 40,
    });

    const body = JSON.stringify(orderPayload({ reference }));
    await request(ctx.server)
      .post(WEBHOOK_PATH)
      .set('content-type', 'application/json')
      .set(
        LEMON_SQUEEZY_SIGNATURE_HEADER,
        createHmac('sha256', 'a-different-secret-entirely').update(body).digest('hex'),
      )
      .send(body)
      .expect(401);

    expect(
      await ctx.prisma.providerPackageEntitlement.count({ where: { providerId: provider.id } }),
    ).toBe(0);
  });

  it('chains a manual renewal onto the end of the running period', async () => {
    const { provider, pkg, cookie, reference } = await pendingPeriodPurchase({
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 12,
    });

    await deliver(orderPayload({ reference })).expect(200);
    const first = await ctx.prisma.providerPackageEntitlement.findFirstOrThrow({
      where: { providerId: provider.id },
    });

    // The provider buys the same package again while the period is still live.
    const second = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: pkg.id })
      .expect(201);

    const secondPurchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: second.body.purchase.id as string },
    });
    await deliver(
      orderPayload({ reference: secondPurchase.paymentReference!, orderId: 'order-992' }),
    ).expect(200);

    const periods = await ctx.prisma.providerPackageEntitlement.findMany({
      where: { providerId: provider.id },
      orderBy: { startAt: 'asc' },
    });

    expect(periods).toHaveLength(2);
    const [current, queued] = periods;
    // No gap, no overlap, and no top-up of the running period.
    expect(queued!.startAt.toISOString()).toBe(current!.endAt.toISOString());
    expect(queued!.endAt.getTime() - queued!.startAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(current!.remainingQuota).toBe(12);
    expect(first.endAt.toISOString()).toBe(current!.endAt.toISOString());
  });

  it('refuses a third queued period for the same package', async () => {
    const { provider, pkg, cookie, reference } = await pendingPeriodPurchase({
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 12,
    });

    await deliver(orderPayload({ reference })).expect(200);

    const second = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: pkg.id })
      .expect(201);
    const secondPurchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: second.body.purchase.id as string },
    });
    await deliver(
      orderPayload({ reference: secondPurchase.paymentReference!, orderId: 'order-992' }),
    ).expect(200);

    const third = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: pkg.id });

    expect(third.status).toBe(409);
    expect(third.body.code).toBe('PACKAGE_PERIOD_ALREADY_QUEUED');
  });

  it('refuses an unlimited package whose scope another live package already covers', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const { provider, cookie, reference } = await pendingPeriodPurchase({
      type: OfferPackageType.CATEGORY_UNLIMITED,
      scopeCategoryIds: [category.id],
    });

    await deliver(orderPayload({ reference })).expect(200);

    const overlapping = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.CATEGORY_UNLIMITED,
      priceAmount: PRICE,
      scopeCategoryIds: [category.id],
    });

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: overlapping.id });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('UNLIMITED_SCOPE_CONFLICT');
  });

  it('still loads credits for a one-time package, unchanged', async () => {
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: ownerUser.id });
    const pkg = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.ONE_TIME_CREDITS,
      creditAmount: 25,
      priceAmount: PRICE,
    });
    configureLemonSqueezy(pkg.slug);
    const cookie = await loginAs(ctx.prisma, ownerUser.id);

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: pkg.id })
      .expect(201);
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: created.body.purchase.id as string },
    });

    await deliver(orderPayload({ reference: purchase.paymentReference! })).expect(200);

    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);
    expect(
      await ctx.prisma.providerPackageEntitlement.count({ where: { providerId: provider.id } }),
    ).toBe(0);
  });
});

describe('the mock payment path', () => {
  it('grants a period without loading any credit', async () => {
    process.env.PAYMENT_PROVIDER = 'mock';
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: ownerUser.id });
    const pkg = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 15,
    });
    const cookie = await loginAs(ctx.prisma, ownerUser.id);

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases`)
      .set('Cookie', cookie)
      .send({ packageId: pkg.id })
      .expect(201);

    await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases/${created.body.id}/mock-pay`)
      .set('Cookie', cookie)
      .send({
        cardholderName: 'Test Kullanıcı',
        cardNumber: '4242424242424242',
        expiryMonth: 12,
        expiryYear: new Date().getFullYear() + 2,
        cvv: '123',
      })
      .expect(201);

    const entitlement = await ctx.prisma.providerPackageEntitlement.findFirstOrThrow({
      where: { providerId: provider.id },
    });
    expect(entitlement.remainingQuota).toBe(15);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
  });

  it('grants nothing when the mock payment is declined', async () => {
    process.env.PAYMENT_PROVIDER = 'mock';
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: ownerUser.id });
    const pkg = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 15,
    });
    const cookie = await loginAs(ctx.prisma, ownerUser.id);

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases`)
      .set('Cookie', cookie)
      .send({ packageId: pkg.id })
      .expect(201);

    await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases/${created.body.id}/mock-pay`)
      .set('Cookie', cookie)
      .send({
        cardholderName: 'Test Kullanıcı',
        // The declining card in the mock adapter.
        cardNumber: '4242424242420000',
        expiryMonth: 12,
        expiryYear: new Date().getFullYear() + 2,
        cvv: '123',
      })
      .expect(201);

    expect(
      await ctx.prisma.providerPackageEntitlement.count({ where: { providerId: provider.id } }),
    ).toBe(0);
  });
});
