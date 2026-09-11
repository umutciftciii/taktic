import {
  PackagePurchaseStatus,
  PaymentWebhookEventStatus,
  ServiceCategoryKind,
  UserRole,
} from '@prisma/client';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LemonSqueezyCheckoutAdapter } from '../src/modules/payments/lemon-squeezy.adapter';
import { LEMON_SQUEEZY_SIGNATURE_HEADER } from '../src/modules/payments/lemon-squeezy.webhook';
import {
  createCategory,
  createDiscoverableProvider,
  createOfferPackage,
  createShowcasePackage,
  createTestApp,
  createUser,
  currentCreditBalance,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * A settled vitrin payment produces a publication right, and produces nothing
 * else.
 *
 * The whole file runs against the real webhook endpoint with real signatures,
 * because the claim under test is about the only path in this application that
 * may grant anything from a payment — and the thing that must not happen here is
 * the thing that has always happened on that path: a credit balance moving.
 *
 * ## The two settlement paths branch on one field
 *
 * `PackagePurchase.kind`. That is why every case below asserts the *absence* of
 * an offer-credit effect as well as the presence of the right: a settlement
 * that forgot to branch would still produce a plausible-looking PAID purchase.
 * A CHECK constraint is the second line of defence, and it is proved in
 * `showcase-purchase-kind.spec.ts`.
 *
 * ## No placement, no card
 *
 * The sale is package-first. Money buys an AVAILABLE `ShowcaseEntitlement`; the
 * card that spends it does not exist yet, so a settlement that produced a
 * placement here would be publishing nothing.
 */
const PLACEHOLDER_API_KEY = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.${'placeholderNotARealCredential'}`;
const WEBHOOK_SECRET = 'placeholder-webhook-secret-not-real';
const STORE_ID = '424242';
const VARIANT_ID = '778899';
const OTHER_VARIANT_ID = '990011';
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
  ctx.notifications.clear();
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

function configureLemonSqueezy(variantMap: string) {
  process.env.PAYMENT_PROVIDER = 'lemon-squeezy-test';
  process.env.LEMON_SQUEEZY_API_KEY = PLACEHOLDER_API_KEY;
  process.env.LEMON_SQUEEZY_STORE_ID = STORE_ID;
  process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.LEMON_SQUEEZY_VARIANT_MAP = variantMap;
  process.env.WEB_ORIGIN = 'https://web.example.test';
}

/** A pending vitrin purchase, opened through the real package-first checkout. */
async function pendingShowcasePurchase() {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const pkg = await createShowcasePackage(ctx.prisma, { priceAmount: PRICE, durationDays: 30 });

  configureLemonSqueezy(`${pkg.slug}:${VARIANT_ID}`);
  const cookie = await loginAs(ctx.prisma, ownerUser.id);

  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/showcase/packages/checkout`)
    .set('Cookie', cookie)
    // The sale's own precondition, asserted in
    // `showcase-package-checkout.spec.ts` and satisfied here.
    .send({ showcasePackageId: pkg.id, priceTermsAccepted: true, priceTermsVersion: 'v1' })
    .expect(201);

  const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
    where: { id: created.body.purchase.id as string },
  });

  return {
    category,
    provider,
    ownerUser,
    cookie,
    pkg,
    purchase,
    reference: purchase.paymentReference!,
  };
}

function orderPayload(overrides: {
  reference: string;
  orderId?: string;
  variantId?: string;
  price?: number;
  currency?: string;
  /**
   * The object type, which is part of the event key.
   *
   * A delivery that keys differently while naming the same provider order is
   * the only way to reach `ORDER_ALREADY_SETTLED`: the event key catches a
   * plain redelivery first, and the *order* is what catches this. It is the
   * same seam `lemon-squeezy-webhook.spec.ts` uses for the credit path.
   */
  objectType?: string;
}) {
  return {
    meta: {
      event_name: 'order_created',
      test_mode: true,
      custom_data: { purchase_reference: overrides.reference },
    },
    data: {
      type: overrides.objectType ?? 'orders',
      id: overrides.orderId ?? 'order-vitrin-1',
      attributes: {
        store_id: Number(STORE_ID),
        status: 'paid',
        total: (overrides.price ?? PRICE) + 2,
        currency: overrides.currency ?? 'TRY',
        user_name: 'Ayşe Yılmaz',
        user_email: 'ayse.yilmaz@example.test',
        first_order_item: {
          variant_id: Number(overrides.variantId ?? VARIANT_ID),
          price: overrides.price ?? PRICE,
          quantity: 1,
        },
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

describe('a settled vitrin payment', () => {
  it('grants one AVAILABLE right, no placement, no balance', async () => {
    const { purchase, provider, pkg, reference } = await pendingShowcasePurchase();

    const response = await deliver(orderPayload({ reference }));
    expect(response.status).toBe(200);

    const settled = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(settled.status).toBe(PackagePurchaseStatus.PAID);
    expect(settled.paidAt).not.toBeNull();
    expect(settled.providerOrderId).toBe('order-vitrin-1');
    // The assertion this whole file exists for.
    expect(settled.creditTransactionId).toBeNull();
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);

    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({
      where: { purchaseId: purchase.id },
    });
    expect(right.status).toBe('AVAILABLE');
    expect(right.providerId).toBe(provider.id);
    expect(right.showcasePackageId).toBe(pkg.id);
    expect(right.cardId).toBeNull();
    expect(right.durationDaysSnapshot).toBe(30);
    // The right is granted when the money settled — the activation window
    // runs from that instant, not from midnight.
    expect(right.grantedAt.getTime()).toBe(settled.paidAt!.getTime());
    expect(right.expiresAt.getTime()).toBe(
      settled.paidAt!.getTime() + pkg.activationWindowDays * 24 * 60 * 60 * 1000,
    );
    expect(right.priceTermsVersionSnapshot).toBe('v1');

    // Nothing is on the air: there is no card to publish yet.
    expect(await ctx.prisma.showcasePlacement.count()).toBe(0);
    expect(await ctx.prisma.showcasePlacementShelf.count()).toBe(0);
  });

  it('sends the provider no receipt at all', async () => {
    const { reference } = await pendingShowcasePurchase();

    await deliver(orderPayload({ reference }));

    // No card is on the air, so the placement notice would be false; the
    // credit receipt's heading would be a false statement about a purchase
    // that loaded no balance. The return screen tells the provider.
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('grants one right when the same event is delivered twice', async () => {
    const { purchase, reference } = await pendingShowcasePurchase();

    const first = await deliver(orderPayload({ reference }));
    const second = await deliver(orderPayload({ reference }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(1);
    expect(await ctx.prisma.showcasePlacement.count()).toBe(0);

    const event = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({
      where: { purchaseId: purchase.id },
    });
    expect(event.status).toBe(PaymentWebhookEventStatus.PROCESSED);
    expect(event.attemptCount).toBe(2);

    // And still nothing sent for a second settlement that did not happen.
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('grants one right when two deliveries of the same event arrive together', async () => {
    const { reference } = await pendingShowcasePurchase();

    // The Serializable transaction, the PROCESSED short-circuit inside it and
    // the unique index on `purchaseId` are what make this one right rather
    // than two. All three survive concurrency; none of them relies on ordering.
    const [first, second] = await Promise.all([
      deliver(orderPayload({ reference })),
      deliver(orderPayload({ reference })),
    ]);

    expect([first.status, second.status].every((status) => status === 200)).toBe(true);
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(1);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
  });

  it('refuses a second purchase settled against an order that already closed one', async () => {
    const first = await pendingShowcasePurchase();
    await deliver(orderPayload({ reference: first.reference, orderId: 'order-shared' }));

    // A second vitrin purchase of the same package — the first is PAID, so
    // nothing pending is handed back — against the same Lemon order.
    const opened = await request(ctx.server)
      .post(`/providers/${first.provider.id}/showcase/packages/checkout`)
      .set('Cookie', first.cookie)
      .send({ showcasePackageId: first.pkg.id })
      .expect(201);
    const secondPurchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: opened.body.purchase.id as string },
    });

    const response = await deliver(
      orderPayload({
        reference: secondPurchase.paymentReference!,
        orderId: 'order-shared',
        objectType: 'order',
      }),
    );

    expect(response.status).toBe(200);
    const refused = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({
      where: { purchaseId: secondPurchase.id },
    });
    expect(refused.status).toBe(PaymentWebhookEventStatus.MISMATCHED);
    expect(refused.detail).toBe('ORDER_ALREADY_SETTLED');
    // One order, one right.
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(1);
  });

  /**
   * The case a separate vitrin purchase table would have made impossible to
   * catch. `providerOrderId` is unique across the *one* money rail, so an order
   * that already settled a credit purchase cannot also settle a vitrin one.
   */
  it('refuses one order settling both a credit purchase and a vitrin one', async () => {
    const vitrin = await pendingShowcasePurchase();
    const creditPackage = await createOfferPackage(ctx.prisma, { priceAmount: PRICE });

    configureLemonSqueezy(
      `${vitrin.pkg.slug}:${VARIANT_ID},${creditPackage.slug}:${OTHER_VARIANT_ID}`,
    );

    const creditCheckout = await request(ctx.server)
      .post(`/providers/${vitrin.provider.id}/checkout-sessions`)
      .set('Cookie', vitrin.cookie)
      .send({ packageId: creditPackage.id })
      .expect(201);
    const creditPurchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: creditCheckout.body.purchase.id as string },
    });

    await deliver(
      orderPayload({
        reference: creditPurchase.paymentReference!,
        orderId: 'order-both',
        variantId: OTHER_VARIANT_ID,
      }),
    );

    const second = await deliver(
      orderPayload({ reference: vitrin.reference, orderId: 'order-both', objectType: 'order' }),
    );

    expect(second.status).toBe(200);
    const refused = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({
      where: { purchaseId: vitrin.purchase.id },
    });
    expect(refused.detail).toBe('ORDER_ALREADY_SETTLED');
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(0);
  });

  it('reads the vitrin catalogue’s slug when checking the variant', async () => {
    const { reference } = await pendingShowcasePurchase();

    const response = await deliver(orderPayload({ reference, variantId: OTHER_VARIANT_ID }));

    expect(response.status).toBe(200);
    const event = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({});
    expect(event.detail).toBe('VARIANT_MISMATCH');
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(0);
  });

  it('refuses an amount that does not match the snapshot exactly', async () => {
    const { reference } = await pendingShowcasePurchase();

    const response = await deliver(orderPayload({ reference, price: PRICE - 1 }));

    expect(response.status).toBe(200);
    const event = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({});
    expect(event.detail).toBe('AMOUNT_MISMATCH');
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(0);
  });

  it('leaves an ordinary credit purchase settling exactly as it always has', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: ownerUser.id,
      categoryId: category.id,
    });
    const creditPackage = await createOfferPackage(ctx.prisma, {
      priceAmount: PRICE,
      creditAmount: 25,
    });

    configureLemonSqueezy(`${creditPackage.slug}:${VARIANT_ID}`);
    const cookie = await loginAs(ctx.prisma, ownerUser.id);

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(201);
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: created.body.purchase.id as string },
    });

    await deliver(orderPayload({ reference: purchase.paymentReference! }));

    // The regression that matters most to everybody who is not using vitrin.
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(0);
    expect(await ctx.prisma.showcasePlacement.count()).toBe(0);
    expect(
      ctx.notifications.sent.filter(
        (message) => message.template === 'package-purchase-confirmation',
      ),
    ).toHaveLength(1);
  });
});
