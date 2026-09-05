import {
  CreditTransactionType,
  PackagePurchaseStatus,
  PaymentWebhookEventStatus,
  UserRole,
} from '@prisma/client';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LemonSqueezyCheckoutAdapter } from '../src/modules/payments/lemon-squeezy.adapter';
import { LEMON_SQUEEZY_SIGNATURE_HEADER } from '../src/modules/payments/lemon-squeezy.webhook';
import { MANUAL_REVIEW_REASON } from '../src/modules/payments/payments-webhook.service';
import {
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
 * The only path that may load credits from a payment.
 *
 * Every case here posts bytes to the public endpoint the way Lemon Squeezy
 * would, and the file is organised around the one claim the feature makes: a
 * credit balance moves when — and only when — a delivery carries a correct
 * signature over a payload that agrees with this application's own records, and
 * it moves exactly once however many times that delivery arrives.
 *
 * No test reaches the network. The credentials are syntactically valid
 * placeholders that were never issued.
 */
const PLACEHOLDER_API_KEY = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.${'placeholderNotARealCredential'}`;
const WEBHOOK_SECRET = 'placeholder-webhook-secret-not-real';
const STORE_ID = '424242';
const VARIANT_ID = '778899';
const WEBHOOK_PATH = '/payments/lemon-squeezy/webhook';
const HOSTED_URL = 'https://taktic-sandbox.lemonsqueezy.test/checkout/abc123';

/** A buyer identity of the kind a real payload carries. Nothing may store it. */
const BUYER_NAME = 'Ayşe Yılmaz';
const BUYER_EMAIL = 'ayse.yilmaz@example.test';

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

/** A provider with a pending purchase whose hosted checkout is already open. */
async function pendingPurchaseFixture(
  options: { creditAmount?: number; priceAmount?: number; currency?: string } = {},
) {
  const suffix = uniqueSuffix();
  const slug = `paket-${suffix}`;
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, { userId: ownerUser.id });
  const creditPackage = await ctx.prisma.offerCreditPackage.create({
    data: {
      name: `Paket ${suffix}`,
      slug,
      creditAmount: options.creditAmount ?? 25,
      priceAmount: options.priceAmount ?? 49900,
      currency: options.currency ?? 'TRY',
      isActive: true,
    },
  });

  configureLemonSqueezy(slug);
  const cookie = await loginAs(ctx.prisma, ownerUser.id);

  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/checkout-sessions`)
    .set('Cookie', cookie)
    .send({ packageId: creditPackage.id })
    .expect(201);

  const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
    where: { id: created.body.purchase.id as string },
  });

  return { provider, creditPackage, cookie, purchase, reference: purchase.paymentReference! };
}

type OrderOverrides = {
  eventName?: string;
  orderId?: string;
  objectType?: string;
  testMode?: boolean;
  storeId?: number | string;
  status?: string;
  total?: number;
  itemPrice?: number | null;
  quantity?: number | null;
  currency?: string;
  variantId?: string;
  reference?: string | null;
};

/**
 * A delivery shaped the way Lemon Squeezy sends one, buyer details included —
 * so the assertions about what is *not* stored have something real to bite on.
 */
function orderPayload(overrides: OrderOverrides = {}) {
  return {
    meta: {
      event_name: overrides.eventName ?? 'order_created',
      test_mode: overrides.testMode ?? true,
      custom_data:
        overrides.reference === null ? {} : { purchase_reference: overrides.reference },
    },
    data: {
      type: overrides.objectType ?? 'orders',
      id: overrides.orderId ?? 'order-991',
      attributes: {
        store_id: overrides.storeId ?? Number(STORE_ID),
        status: overrides.status ?? 'paid',
        // Two kuruş above the line item on purpose. Lemon Squeezy normalises
        // every order through USD and derives this figure from the rounded
        // result, so in a store held in any other currency it drifts from the
        // price the checkout was opened with. Every settlement case below
        // therefore runs against a total that does *not* match the snapshot,
        // which is the whole point: the line item is what gets checked.
        total: overrides.total ?? 49902,
        currency: overrides.currency ?? 'TRY',
        user_name: BUYER_NAME,
        user_email: BUYER_EMAIL,
        first_order_item: {
          variant_id: Number(overrides.variantId ?? VARIANT_ID),
          ...(overrides.itemPrice === null ? {} : { price: overrides.itemPrice ?? 49900 }),
          ...(overrides.quantity === null ? {} : { quantity: overrides.quantity ?? 1 }),
        },
      },
    },
  };
}

function sign(body: string, secret = WEBHOOK_SECRET) {
  return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');
}

function deliver(payload: unknown, options: { signature?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const signature = options.signature ?? sign(body, options.secret);

  return request(ctx.server)
    .post(WEBHOOK_PATH)
    .set('content-type', 'application/json')
    .set(LEMON_SQUEEZY_SIGNATURE_HEADER, signature)
    .send(body);
}

/**
 * Runs `body` with every Serializable attempt failing as PostgreSQL fails one
 * under contention.
 *
 * P2034 is the code Prisma reports for SQLSTATE 40001, and `runSerializable`
 * retries exactly it — so rejecting every attempt exhausts the budget with no
 * timing dependency at all. The spy is always restored, including when the
 * request throws.
 */
async function withExhaustedWriteConflicts<T>(body: () => Promise<T>): Promise<T> {
  const conflict = Object.assign(
    new Error('Transaction failed due to a write conflict or a deadlock.'),
    { code: 'P2034' },
  );
  const host = ctx.prisma as unknown as {
    $transaction: (...args: unknown[]) => Promise<unknown>;
  };
  const spy = vi.spyOn(host, '$transaction').mockRejectedValue(conflict);

  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}

async function packageLedgerRows(providerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: { providerId, type: CreditTransactionType.PACKAGE_PURCHASE },
  });
}

describe('nothing happens before the signature is proven', () => {
  it('refuses a delivery with a wrong signature and writes nothing at all', async () => {
    const { provider, reference } = await pendingPurchaseFixture();

    await deliver(orderPayload({ reference }), { secret: 'another-secret-entirely-not-real' })
      .expect(401);

    expect(await packageLedgerRows(provider.id)).toHaveLength(0);
    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);

    const purchase = await ctx.prisma.packagePurchase.findFirstOrThrow();
    expect(purchase.status).toBe(PackagePurchaseStatus.PENDING);
  });

  it('refuses a delivery with no signature, a malformed one, and a tampered body', async () => {
    const { provider, reference } = await pendingPurchaseFixture();
    const payload = orderPayload({ reference });
    const body = JSON.stringify(payload);

    await request(ctx.server)
      .post(WEBHOOK_PATH)
      .set('content-type', 'application/json')
      .send(body)
      .expect(401);

    await deliver(payload, { signature: 'not-hex' }).expect(401);
    await deliver(payload, { signature: 'a'.repeat(64) }).expect(401);

    // A valid signature over the original bytes, replayed against edited ones.
    const tampered = JSON.stringify(orderPayload({ reference, total: 1 }));
    await request(ctx.server)
      .post(WEBHOOK_PATH)
      .set('content-type', 'application/json')
      .set(LEMON_SQUEEZY_SIGNATURE_HEADER, sign(body))
      .send(tampered)
      .expect(401);

    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
  });

  it('does not exist at all when the process is not wired to the provider', async () => {
    const { reference } = await pendingPurchaseFixture();
    process.env.PAYMENT_PROVIDER = 'mock';

    await deliver(orderPayload({ reference })).expect(404);

    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(0);
  });

  it('refuses bytes that are not a payload, after a correct signature', async () => {
    await pendingPurchaseFixture();
    const body = 'not json at all';

    await request(ctx.server)
      .post(WEBHOOK_PATH)
      .set('content-type', 'application/json')
      .set(LEMON_SQUEEZY_SIGNATURE_HEADER, sign(body))
      .send(body)
      .expect(400);

    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(0);
  });
});

describe('a settled order loads credits exactly once', () => {
  it('moves the purchase to PAID and appends one ledger row', async () => {
    const { provider, reference, purchase } = await pendingPurchaseFixture({ creditAmount: 25 });

    const response = await deliver(orderPayload({ reference })).expect(200);
    expect(response.body).toEqual({ status: 'processed' });

    const settled = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(settled.status).toBe(PackagePurchaseStatus.PAID);
    expect(settled.paidAt).not.toBeNull();
    expect(settled.providerOrderId).toBe('order-991');
    expect(settled.creditTransactionId).not.toBeNull();

    const ledger = await packageLedgerRows(provider.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amount).toBe(25);
    expect(ledger[0]!.balanceAfter).toBe(25);
    expect(ledger[0]!.referenceId).toBe(purchase.id);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);

    const audit = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow();
    expect(audit.status).toBe(PaymentWebhookEventStatus.PROCESSED);
    expect(audit.purchaseId).toBe(purchase.id);
  });

  /**
   * The numbers here are the ones a real sandbox order came back with: a
   * checkout opened at 999,00 TRY settled as an order whose `total` and
   * `subtotal` both read 99904, two kuruş of rounding introduced by Lemon
   * Squeezy converting to USD and back for its own accounting. Checking the
   * order total meant no store held outside USD could ever settle; the line
   * item still carried the 99900 this application asked for.
   */
  it('settles an order whose total drifted from the price the checkout was opened at', async () => {
    const { provider, reference, purchase } = await pendingPurchaseFixture({
      creditAmount: 50,
      priceAmount: 99900,
    });

    const response = await deliver(
      orderPayload({ reference, itemPrice: 99900, total: 99904 }),
    ).expect(200);
    expect(response.body).toEqual({ status: 'processed' });

    const settled = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(settled.status).toBe(PackagePurchaseStatus.PAID);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(50);
  });

  it('treats a redelivered event as a no-op', async () => {
    const { provider, reference } = await pendingPurchaseFixture({ creditAmount: 25 });
    const payload = orderPayload({ reference });

    await deliver(payload).expect(200);
    const second = await deliver(payload).expect(200);

    expect(second.body).toEqual({ status: 'duplicate' });
    expect(await packageLedgerRows(provider.id)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);
    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(1);
  });

  it('refuses a second, differently-keyed event for the same paid purchase', async () => {
    const { provider, reference } = await pendingPurchaseFixture({ creditAmount: 25 });

    await deliver(orderPayload({ reference })).expect(200);

    // Same purchase, a different event object: the purchase is no longer
    // PENDING, so it is recorded and refused rather than paid twice.
    const second = await deliver(
      orderPayload({ reference, orderId: 'order-992' }),
    ).expect(200);

    expect(second.body).toEqual({ status: 'mismatched' });
    expect(await packageLedgerRows(provider.id)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);

    const refused = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({
      where: { status: PaymentWebhookEventStatus.MISMATCHED },
    });
    expect(refused.detail).toBe('PURCHASE_NOT_PENDING');
  });

  /**
   * The concurrency contract, asserted as an invariant rather than as one
   * lucky run.
   *
   * Every round seeds its own purchase and delivers the same signed bytes from
   * several connections at once. What must hold is the same every round: every
   * response is a 200 the provider will not retry, exactly one of them settled
   * the order, and exactly one of everything downstream exists. The rounds are
   * a repetition of the whole scenario, not a retry of a failed one — a round
   * that needed a second go would be a failure.
   */
  it.each([2, 4, 8])(
    'answers %i concurrent copies of one delivery without ever refusing the provider',
    async (parallelism) => {
      for (let round = 1; round <= 3; round += 1) {
        const { provider, purchase, reference } = await pendingPurchaseFixture({ creditAmount: 25 });
        // A provider order id of its own per round. `providerOrderId` is
        // unique-indexed, so reusing the default across rounds would make every
        // round after the first a refusal about the *previous* round's order
        // rather than a test of this one.
        const payload = orderPayload({ reference, orderId: `order-${uniqueSuffix()}` });
        const where = { round, parallelism };
        // Per round, so the receipt assertion below counts this settlement
        // rather than every settlement the loop has produced so far.
        ctx.notifications.clear();

        const responses = await Promise.all(
          Array.from({ length: parallelism }, () => deliver(payload)),
        );

        // Not one delivery may be told to come back. 409 is the answer this
        // endpoint used to give when its rivals exhausted its retry budget, and
        // a payment provider answers a non-2xx by redelivering — into exactly
        // the contention that produced it.
        expect(
          responses.map((response) => response.status),
          `${JSON.stringify(where)}: every delivery must be answered 200`,
        ).toEqual(Array.from({ length: parallelism }, () => 200));

        const statuses = responses.map((response) => response.body.status as string);
        expect(statuses.filter((status) => status === 'processed'), JSON.stringify(where)).toHaveLength(1);
        expect(statuses.filter((status) => status === 'duplicate'), JSON.stringify(where)).toHaveLength(
          parallelism - 1,
        );

        // One of everything, and the same one every round.
        const events = await ctx.prisma.paymentWebhookEvent.findMany({
          where: { purchaseId: purchase.id },
        });
        expect(events, JSON.stringify(where)).toHaveLength(1);
        expect(events[0]!.status).toBe(PaymentWebhookEventStatus.PROCESSED);
        // Every copy is on the audit trail: the one that settled it, and one
        // per redelivery that found it already terminal.
        expect(events[0]!.attemptCount, JSON.stringify(where)).toBe(parallelism);

        expect(await packageLedgerRows(provider.id), JSON.stringify(where)).toHaveLength(1);
        expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);

        const paid = await ctx.prisma.packagePurchase.findMany({
          where: { providerId: provider.id, status: PackagePurchaseStatus.PAID },
        });
        expect(paid, JSON.stringify(where)).toHaveLength(1);

        // Exactly one receipt, however many deliveries arrived.
        expect(
          ctx.notifications.ofTemplate('package-purchase-confirmation'),
          `${JSON.stringify(where)}: one receipt per settlement`,
        ).toHaveLength(1);
      }
    },
  );

  /**
   * The mechanism behind the flake, pinned deterministically.
   *
   * The scenario above depends on the database actually producing a write
   * conflict, which is a race and therefore not something a test may rely on
   * happening. This one removes the race: every serializable attempt is made to
   * fail the way PostgreSQL does under contention (SQLSTATE 40001 → Prisma
   * P2034), so the retry budget is guaranteed to be exhausted. No sleeps, no
   * repetition, no reliance on scheduling.
   *
   * Before the fix this answered 409 CONCURRENT_MODIFICATION — for a delivery
   * whose event was already committed as PROCESSED.
   */
  it('answers a redelivery from committed state even when its own transaction cannot commit', async () => {
    const { provider, reference } = await pendingPurchaseFixture({ creditAmount: 25 });
    const payload = orderPayload({ reference });

    await deliver(payload).expect(200);
    const settledEvent = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow();
    expect(settledEvent.status).toBe(PaymentWebhookEventStatus.PROCESSED);
    expect(settledEvent.attemptCount).toBe(1);
    ctx.notifications.clear();

    const response = await withExhaustedWriteConflicts(() => deliver(payload));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'duplicate' });

    // The redelivery is on the audit trail, and nothing else moved.
    const after = await ctx.prisma.paymentWebhookEvent.findUniqueOrThrow({
      where: { id: settledEvent.id },
    });
    expect(after.attemptCount).toBe(2);
    expect(after.status).toBe(PaymentWebhookEventStatus.PROCESSED);

    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(1);
    expect(await packageLedgerRows(provider.id)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);
    expect(ctx.notifications.ofTemplate('package-purchase-confirmation')).toHaveLength(0);
  });

  /**
   * The other half of that rule: an exhausted budget is only allowed to become
   * `duplicate` when something committed says so.
   *
   * Here nothing settled the order, so the honest answer is the conflict — the
   * provider redelivers and the order settles then. Reporting `duplicate` would
   * tell Lemon Squeezy a payment was handled on the strength of this process
   * having failed to commit, and the paid order would silently load no credits.
   */
  it('still refuses a delivery it could not commit when nothing settled it', async () => {
    const { provider, reference } = await pendingPurchaseFixture({ creditAmount: 25 });

    const response = await withExhaustedWriteConflicts(() =>
      deliver(orderPayload({ reference })),
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONCURRENT_MODIFICATION');

    // And nothing was written on the way to saying so.
    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(0);
    expect(await packageLedgerRows(provider.id)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);

    const purchase = await ctx.prisma.packagePurchase.findFirstOrThrow();
    expect(purchase.status).toBe(PackagePurchaseStatus.PENDING);
  });

  it('lets one settled order load credits onto one purchase only', async () => {
    // Two pending purchases, one order id. Whatever the correlation token says,
    // an order that has already loaded credits somewhere cannot load them
    // again: the unique index on the provider's order id is the second half of
    // the guarantee, next to the event key.
    const first = await pendingPurchaseFixture({ creditAmount: 25 });

    // Expired first, so the endpoint opens a second purchase rather than
    // handing the live session back.
    await ctx.prisma.packagePurchase.update({
      where: { id: first.purchase.id },
      data: { providerCheckoutExpiresAt: new Date(Date.now() - 60_000) },
    });

    const second = await request(ctx.server)
      .post(`/providers/${first.provider.id}/checkout-sessions`)
      .set('Cookie', first.cookie)
      .send({ packageId: first.creditPackage.id })
      .expect(201);

    const secondPurchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: second.body.purchase.id as string },
    });
    expect(secondPurchase.id).not.toBe(first.purchase.id);

    const settled = await deliver(orderPayload({ reference: first.reference })).expect(200);
    expect(settled.body).toEqual({ status: 'processed' });

    const replayed = await deliver(
      orderPayload({ reference: secondPurchase.paymentReference!, eventName: 'order_created' }),
    ).expect(200);
    expect(replayed.body).toEqual({ status: 'duplicate' });

    expect(await packageLedgerRows(first.provider.id)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, first.provider.id)).toBe(25);
    expect(
      await ctx.prisma.packagePurchase.count({ where: { status: PackagePurchaseStatus.PAID } }),
    ).toBe(1);
  });
});

describe('an event that does not agree with this application loads nothing', () => {
  const cases: Array<{ name: string; overrides: OrderOverrides; detail: string }> = [
    { name: 'a live-mode delivery', overrides: { testMode: false }, detail: 'LIVE_MODE_EVENT' },
    { name: 'another store', overrides: { storeId: 999999 }, detail: 'STORE_MISMATCH' },
    { name: 'a different amount', overrides: { itemPrice: 100 }, detail: 'AMOUNT_MISMATCH' },
    { name: 'more than one of the package', overrides: { quantity: 2 }, detail: 'AMOUNT_MISMATCH' },
    { name: 'a line item with no price', overrides: { itemPrice: null }, detail: 'AMOUNT_MISMATCH' },
    { name: 'a line item with no quantity', overrides: { quantity: null }, detail: 'AMOUNT_MISMATCH' },
    { name: 'a different currency', overrides: { currency: 'USD' }, detail: 'CURRENCY_MISMATCH' },
    { name: 'a different variant', overrides: { variantId: '111111' }, detail: 'VARIANT_MISMATCH' },
    { name: 'no correlation token', overrides: { reference: null }, detail: 'MISSING_REFERENCE' },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.name}`, async () => {
      const { provider, purchase, reference } = await pendingPurchaseFixture();

      const response = await deliver(
        orderPayload({ reference, ...testCase.overrides }),
      ).expect(200);

      expect(response.body).toEqual({ status: 'mismatched' });
      expect(await packageLedgerRows(provider.id)).toHaveLength(0);
      expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);

      const still = await ctx.prisma.packagePurchase.findUniqueOrThrow({
        where: { id: purchase.id },
      });
      expect(still.status).toBe(PackagePurchaseStatus.PENDING);
      expect(still.providerOrderId).toBeNull();

      const audit = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow();
      expect(audit.status).toBe(PaymentWebhookEventStatus.MISMATCHED);
      expect(audit.detail).toBe(testCase.detail);
    });
  }

  it('refuses a token that matches no purchase', async () => {
    const { provider } = await pendingPurchaseFixture();

    const response = await deliver(
      orderPayload({ reference: 'a'.repeat(43) }),
    ).expect(200);

    expect(response.body).toEqual({ status: 'mismatched' });
    expect(await packageLedgerRows(provider.id)).toHaveLength(0);

    const audit = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow();
    expect(audit.detail).toBe('UNKNOWN_REFERENCE');
    expect(audit.purchaseId).toBeNull();
  });

  it('refuses a purchase that was opened with another provider', async () => {
    const { provider, purchase, reference } = await pendingPurchaseFixture();
    await ctx.prisma.packagePurchase.update({
      where: { id: purchase.id },
      data: { paymentProvider: 'mock' },
    });

    await deliver(orderPayload({ reference })).expect(200);

    expect(await packageLedgerRows(provider.id)).toHaveLength(0);
    const audit = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow();
    expect(audit.detail).toBe('PROVIDER_MISMATCH');
  });

  it('ignores an unsettled order and an event it does not handle', async () => {
    const { provider, reference } = await pendingPurchaseFixture();

    const pendingOrder = await deliver(
      orderPayload({ reference, status: 'pending', orderId: 'order-a' }),
    ).expect(200);
    expect(pendingOrder.body).toEqual({ status: 'ignored' });

    const unknown = await deliver(
      orderPayload({ reference, eventName: 'subscription_created', orderId: 'order-b' }),
    ).expect(200);
    expect(unknown.body).toEqual({ status: 'ignored' });

    expect(await packageLedgerRows(provider.id)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);

    const details = (await ctx.prisma.paymentWebhookEvent.findMany()).map((row) => row.detail);
    expect(details.sort()).toEqual(['ORDER_NOT_SETTLED', 'UNHANDLED_EVENT']);
  });
});

/**
 * A refusal this application caused — a variant mapped wrongly, a package
 * repriced mid-checkout, a comparison reading the wrong field — is fixed by
 * fixing the deployment and letting the provider send the event again. That
 * only works if the second delivery is judged on its own merits instead of
 * colliding with the record of the first refusal.
 */
describe('a refused event can still settle when it is delivered again', () => {
  it('refuses the first delivery, then settles the same event once the mismatch is gone', async () => {
    const { provider, purchase, reference } = await pendingPurchaseFixture({
      creditAmount: 25,
      priceAmount: 49900,
    });

    // Delivery one: the amount does not agree, so nothing moves.
    const refused = await deliver(orderPayload({ reference, itemPrice: 49800 })).expect(200);
    expect(refused.body).toEqual({ status: 'mismatched' });

    const afterRefusal = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(afterRefusal.status).toBe(PackagePurchaseStatus.PENDING);
    expect(afterRefusal.paidAt).toBeNull();
    expect(await packageLedgerRows(provider.id)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);

    const refusalRow = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow();
    expect(refusalRow.status).toBe(PaymentWebhookEventStatus.MISMATCHED);
    expect(refusalRow.detail).toBe('AMOUNT_MISMATCH');
    expect(refusalRow.attemptCount).toBe(1);
    expect(refusalRow.resolvedAt).toBeNull();
    // The refusal is auditable against the purchase it refused.
    expect(refusalRow.purchaseId).toBe(purchase.id);

    // Delivery two: the same event, now agreeing.
    const settledResponse = await deliver(orderPayload({ reference })).expect(200);
    expect(settledResponse.body).toEqual({ status: 'processed' });

    const settled = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(settled.status).toBe(PackagePurchaseStatus.PAID);
    expect(settled.paidAt).not.toBeNull();
    expect(settled.providerOrderId).toBe('order-991');

    const ledger = await packageLedgerRows(provider.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amount).toBe(25);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);
  });

  it('keeps the first refusal on the record after the event resolves', async () => {
    const { purchase, reference } = await pendingPurchaseFixture({ priceAmount: 49900 });

    await deliver(orderPayload({ reference, itemPrice: 49800 })).expect(200);
    await deliver(orderPayload({ reference })).expect(200);

    // One event, one row: the redelivery updated the refusal rather than
    // colliding with it.
    const rows = await ctx.prisma.paymentWebhookEvent.findMany();
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.status).toBe(PaymentWebhookEventStatus.PROCESSED);
    expect(row.detail).toBeNull();
    expect(row.attemptCount).toBe(2);
    expect(row.purchaseId).toBe(purchase.id);

    // What stopped the first delivery survives the one that succeeded.
    expect(row.firstFailureCode).toBe('AMOUNT_MISMATCH');
    expect(row.firstFailureAt).not.toBeNull();
    expect(row.resolvedAt).not.toBeNull();
    expect(row.resolvedAt!.getTime()).toBeGreaterThanOrEqual(row.firstFailureAt!.getTime());
    expect(row.lastAttemptAt.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());
  });

  it('loads credits once when the settled event keeps arriving, in sequence and at once', async () => {
    const { provider, reference } = await pendingPurchaseFixture({
      creditAmount: 25,
      priceAmount: 49900,
    });

    await deliver(orderPayload({ reference, itemPrice: 49800 })).expect(200);
    await deliver(orderPayload({ reference })).expect(200);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);

    // Sequential redeliveries of the settled event.
    for (const _ of [1, 2]) {
      const again = await deliver(orderPayload({ reference })).expect(200);
      expect(again.body).toEqual({ status: 'duplicate' });
    }

    // And two arriving together.
    const concurrent = await Promise.all([
      deliver(orderPayload({ reference })),
      deliver(orderPayload({ reference })),
    ]);

    for (const response of concurrent) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'duplicate' });
    }

    expect(await packageLedgerRows(provider.id)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);

    const row = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow();
    expect(row.status).toBe(PaymentWebhookEventStatus.PROCESSED);
    // Every delivery is counted, including the ones that changed nothing.
    expect(row.attemptCount).toBe(6);
    expect(row.firstFailureCode).toBe('AMOUNT_MISMATCH');
  });

  it('keeps refusing an event whose mismatch never goes away', async () => {
    const { provider, purchase, reference } = await pendingPurchaseFixture({ priceAmount: 49900 });

    for (const _ of [1, 2, 3]) {
      const response = await deliver(orderPayload({ reference, itemPrice: 100 })).expect(200);
      expect(response.body).toEqual({ status: 'mismatched' });
    }

    const stuck = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(stuck.status).toBe(PackagePurchaseStatus.PENDING);
    expect(await packageLedgerRows(provider.id)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);

    const row = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow();
    expect(row.status).toBe(PaymentWebhookEventStatus.MISMATCHED);
    expect(row.detail).toBe('AMOUNT_MISMATCH');
    expect(row.attemptCount).toBe(3);
    expect(row.resolvedAt).toBeNull();
    expect(row.firstFailureCode).toBe('AMOUNT_MISMATCH');
  });

  it('refuses a differently-keyed event that names an order already settled', async () => {
    const first = await pendingPurchaseFixture({ creditAmount: 25, priceAmount: 49900 });
    await deliver(orderPayload({ reference: first.reference })).expect(200);
    expect(await currentCreditBalance(ctx.prisma, first.provider.id)).toBe(25);

    // A second purchase, and a delivery that keys differently — the object type
    // is not the one Lemon Squeezy sends — while naming the same provider
    // order. The event key does not catch it; the order does.
    const second = await pendingPurchaseFixture({ creditAmount: 25, priceAmount: 49900 });
    configureLemonSqueezy(second.creditPackage.slug);

    const replay = await deliver(
      orderPayload({ reference: second.reference, objectType: 'order' }),
    ).expect(200);
    expect(replay.body).toEqual({ status: 'mismatched' });

    const untouched = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: second.purchase.id },
    });
    expect(untouched.status).toBe(PackagePurchaseStatus.PENDING);
    expect(await packageLedgerRows(second.provider.id)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, second.provider.id)).toBe(0);

    const replayRow = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({
      where: { eventKey: { contains: ':order:' } },
    });
    expect(replayRow.status).toBe(PaymentWebhookEventStatus.MISMATCHED);
    expect(replayRow.detail).toBe('ORDER_ALREADY_SETTLED');

    // And the order that did settle is still settled exactly once.
    expect(await currentCreditBalance(ctx.prisma, first.provider.id)).toBe(25);
  });

  it('shows the attempt history to an admin without showing anything else', async () => {
    const { purchase, reference } = await pendingPurchaseFixture({ priceAmount: 49900 });

    await deliver(orderPayload({ reference, itemPrice: 49800 })).expect(200);
    await deliver(orderPayload({ reference })).expect(200);

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    const view = await request(ctx.server)
      .get(`/package-purchases/${purchase.id}`)
      .set('Cookie', adminCookie)
      .expect(200);

    expect(view.body.webhookEvents).toHaveLength(1);
    const attempt = view.body.webhookEvents[0];
    expect(attempt.status).toBe('PROCESSED');
    expect(attempt.attemptCount).toBe(2);
    expect(attempt.firstFailureCode).toBe('AMOUNT_MISMATCH');
    expect(attempt.firstFailureAt).not.toBeNull();
    expect(attempt.resolvedAt).not.toBeNull();

    // Codes and times, and nothing that could be read back into a payload.
    expect(Object.keys(attempt).sort()).toEqual([
      'attemptCount',
      'createdAt',
      'detail',
      'eventName',
      'firstFailureAt',
      'firstFailureCode',
      'lastAttemptAt',
      'resolvedAt',
      'status',
    ]);

    const serialised = JSON.stringify(view.body);
    expect(serialised).not.toContain(WEBHOOK_SECRET);
    expect(serialised).not.toContain(PLACEHOLDER_API_KEY);
    expect(serialised).not.toContain(BUYER_EMAIL);
    expect(serialised).not.toContain(BUYER_NAME);
    expect(serialised).not.toContain(reference);
  });
});

describe('a refund raises a flag and moves nothing', () => {
  it('leaves the balance and the ledger untouched', async () => {
    const { provider, purchase, reference } = await pendingPurchaseFixture({ creditAmount: 25 });

    await deliver(orderPayload({ reference })).expect(200);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);

    const refund = await deliver(
      orderPayload({ reference, eventName: 'order_refunded', orderId: 'order-991' }),
    ).expect(200);

    expect(refund.body).toEqual({ status: 'manual_review_required' });

    const after = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    // Still PAID, still holding its credits. A person decides what happens next.
    expect(after.status).toBe(PackagePurchaseStatus.PAID);
    expect(after.manualReviewReason).toBe(MANUAL_REVIEW_REASON);
    expect(after.manualReviewAt).not.toBeNull();

    expect(await packageLedgerRows(provider.id)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);

    const audit = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({
      where: { status: PaymentWebhookEventStatus.MANUAL_REVIEW_REQUIRED },
    });
    expect(audit.purchaseId).toBe(purchase.id);
  });

  it('is idempotent when redelivered', async () => {
    const { provider, reference } = await pendingPurchaseFixture({ creditAmount: 25 });
    await deliver(orderPayload({ reference })).expect(200);

    const payload = orderPayload({ reference, eventName: 'order_refunded' });
    await deliver(payload).expect(200);
    const second = await deliver(payload).expect(200);

    expect(second.body).toEqual({ status: 'duplicate' });
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(25);
    expect(
      await ctx.prisma.paymentWebhookEvent.count({
        where: { status: PaymentWebhookEventStatus.MANUAL_REVIEW_REQUIRED },
      }),
    ).toBe(1);
  });
});

describe('nothing but the webhook can settle a sandbox purchase', () => {
  it('refuses the in-app mock payment endpoint', async () => {
    const { provider, purchase, cookie } = await pendingPurchaseFixture({ creditAmount: 25 });

    await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases/${purchase.id}/mock-pay`)
      .set('Cookie', cookie)
      .send({
        cardholderName: 'Test Kullanıcısı',
        cardNumber: '4242424242424242',
        expiryMonth: 12,
        expiryYear: new Date().getFullYear() + 3,
        cvv: '123',
      })
      .expect(409);

    expect(await packageLedgerRows(provider.id)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
  });

  it('leaves the purchase PENDING however often the return screen is read', async () => {
    const { provider, purchase, cookie } = await pendingPurchaseFixture({ creditAmount: 25 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(ctx.server)
        .get(`/providers/${provider.id}/package-purchases/${purchase.id}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.status).toBe('PENDING');
    }

    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
    expect(await packageLedgerRows(provider.id)).toHaveLength(0);
  });
});

describe('what the feature is allowed to write down', () => {
  it('stores no payload, no signature, no credential and no buyer detail', async () => {
    const { provider, purchase, reference, cookie } = await pendingPurchaseFixture();

    await deliver(orderPayload({ reference })).expect(200);
    await deliver(
      orderPayload({ reference, eventName: 'order_refunded', orderId: 'order-991' }),
    ).expect(200);

    const audits = await ctx.prisma.paymentWebhookEvent.findMany();
    const purchases = await ctx.prisma.packagePurchase.findMany();
    const ledger = await ctx.prisma.providerCreditTransaction.findMany();
    const notifications = await ctx.prisma.notificationLog.findMany();

    const written = JSON.stringify({ audits, purchases, ledger, notifications });

    for (const forbidden of [WEBHOOK_SECRET, PLACEHOLDER_API_KEY, BUYER_NAME, BUYER_EMAIL]) {
      expect(written).not.toContain(forbidden);
    }

    // The audit rows carry an opaque event identity and a short code, nothing
    // that could be read back into a payload.
    for (const audit of audits) {
      expect(audit.eventKey).toMatch(/^[a-z_]+:orders:order-991$/);
      expect(audit.detail === null || /^[A-Z_]+$/.test(audit.detail)).toBe(true);
    }

    // The correlation token stays out of every screen but the purchase's own.
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    const adminView = await request(ctx.server)
      .get(`/package-purchases/${purchase.id}`)
      .set('Cookie', adminCookie)
      .expect(200);
    const providerView = await request(ctx.server)
      .get(`/providers/${provider.id}/package-purchases/${purchase.id}`)
      .set('Cookie', cookie)
      .expect(200);

    for (const body of [adminView.body, providerView.body]) {
      const serialised = JSON.stringify(body);
      expect(serialised).not.toContain(WEBHOOK_SECRET);
      expect(serialised).not.toContain(PLACEHOLDER_API_KEY);
      expect(serialised).not.toContain(BUYER_EMAIL);
      // The correlation token is a matter between this application and the
      // payment provider; no screen has a use for it.
      expect(serialised).not.toContain(reference);
      expect(body.paymentReference).toBeUndefined();
    }
  });

  it('never states what was wrong in a public response', async () => {
    const { reference } = await pendingPurchaseFixture();

    const mismatch = await deliver(orderPayload({ reference, itemPrice: 1 })).expect(200);

    expect(Object.keys(mismatch.body)).toEqual(['status']);
    expect(JSON.stringify(mismatch.body)).not.toContain('AMOUNT');
    expect(JSON.stringify(mismatch.body)).not.toContain(reference);
  });
});
