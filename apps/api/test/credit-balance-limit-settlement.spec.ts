import {
  CreditTransactionType,
  OfferEntitlementSource,
  OfferPackageType,
  PackagePurchaseStatus,
  PaymentWebhookEventStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDIT_LEDGER_INTEGER_MAX } from '../src/common/credit-limits';
import { EntitlementResolverService } from '../src/modules/entitlements/entitlement-resolver.service';
import { LemonSqueezyCheckoutAdapter } from '../src/modules/payments/lemon-squeezy.adapter';
import {
  createEntitlement,
  createOfferPackage,
  createProviderProfile,
  createTestApp,
  createUser,
  currentCreditBalance,
  grantCredits,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';
import {
  LEMON_HOSTED_URL,
  configureLemonSqueezy,
  deliverLemonWebhook,
  lemonOrderPayload,
  restoreLemonEnv,
  snapshotLemonEnv,
} from './lemon-squeezy-fixtures';

/**
 * API-HARDENING-001 (4/4): the ledger's integer bound on every credit write
 * that is not a person's manual grant.
 *
 * The manual path was bounded in PR #122. The others used to let an
 * overflowing balance reach PostgreSQL, which answered with a 500 after the
 * transaction rolled back — correct about the money, wrong about everything
 * else: the payment webhook was answered non-2xx and redelivered for as long
 * as the provider retries, and the mock form showed an unexplained error.
 *
 * | path                           | outcome at max + 1                               |
 * | ------------------------------ | ------------------------------------------------ |
 * | checkout / purchase creation   | 400 CREDIT_BALANCE_LIMIT_EXCEEDED, no row        |
 * | mock payment (settlement)      | 400, purchase PENDING, no ledger row             |
 * | webhook (settlement)           | 200 `mismatched`, event MISMATCHED (recoverable), |
 * |                                | purchase PENDING, no ledger row, no campaign event|
 * | period packages, quota, offers | no positive ledger write — unaffected             |
 */
let ctx: TestContext;
let originalEnv: Record<string, string | undefined>;
let checkoutCalls = 0;

const MAX = CREDIT_LEDGER_INTEGER_MAX;
const LIMIT_CODE = 'CREDIT_BALANCE_LIMIT_EXCEEDED';
const MOCK_CARD = {
  cardholderName: 'Test Kart',
  cardNumber: '4111111111111111',
  expiryMonth: 12,
  expiryYear: 2030,
  cvv: '123',
};

beforeAll(async () => {
  ctx = await createTestApp({
    paymentProvider: new LemonSqueezyCheckoutAdapter(async () => {
      checkoutCalls += 1;
      return {
        ok: true,
        status: 201,
        json: async () => ({
          data: { type: 'checkouts', id: `checkout-${checkoutCalls}`, attributes: { url: LEMON_HOSTED_URL } },
        }),
      };
    }),
  });
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  originalEnv = snapshotLemonEnv();
  checkoutCalls = 0;
});

afterEach(() => {
  restoreLemonEnv(originalEnv);
});

async function providerAccount() {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, { userId: user.id });
  return { provider, cookie: await loginAs(ctx.prisma, user.id) };
}

/** Brings the provider's balance to exactly `balance` with one ledger row. */
async function setBalance(providerId: string, balance: number) {
  const current = await currentCreditBalance(ctx.prisma, providerId);
  if (balance !== current) {
    await grantCredits(ctx.prisma, providerId, balance - current);
  }
}

async function ledgerRows(providerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: { providerId, type: CreditTransactionType.PACKAGE_PURCHASE },
  });
}

describe('opening a purchase for a credit package', () => {
  it('opens a checkout that lands exactly on the bound', async () => {
    const { provider, cookie } = await providerAccount();
    const pkg = await createOfferPackage(ctx.prisma, { creditAmount: 25, priceAmount: 49900 });
    configureLemonSqueezy(pkg.slug);
    await setBalance(provider.id, MAX - 25);

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: pkg.id });

    expect(response.status).toBe(201);
    expect(checkoutCalls).toBe(1);
  });

  it('refuses one credit past the bound before any row or payment page exists', async () => {
    const { provider, cookie } = await providerAccount();
    const pkg = await createOfferPackage(ctx.prisma, { creditAmount: 25, priceAmount: 49900 });
    configureLemonSqueezy(pkg.slug);
    await setBalance(provider.id, MAX - 24);

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: pkg.id });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: LIMIT_CODE, currentBalance: MAX - 24, maxBalance: MAX });
    expect(checkoutCalls).toBe(0);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });

  it('refuses the mock-form purchase the same way, and leaves period packages alone', async () => {
    const { provider, cookie } = await providerAccount();
    const credits = await createOfferPackage(ctx.prisma, { creditAmount: 10 });
    const quota = await createOfferPackage(ctx.prisma, { type: OfferPackageType.MONTHLY_QUOTA, quotaCredits: 40 });
    await setBalance(provider.id, MAX);

    const refused = await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases`)
      .set('Cookie', cookie)
      .send({ packageId: credits.id });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe(LIMIT_CODE);

    // A period package moves no balance, so a full balance does not stop it.
    const period = await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases`)
      .set('Cookie', cookie)
      .send({ packageId: quota.id });
    expect(period.status).toBe(201);
    expect(await ctx.prisma.packagePurchase.count()).toBe(1);
  });
});

describe('settling through the mock form', () => {
  async function pendingMockPurchase(creditAmount: number, balanceAtCheckout: number) {
    const account = await providerAccount();
    const pkg = await createOfferPackage(ctx.prisma, { creditAmount });
    await setBalance(account.provider.id, balanceAtCheckout);
    const created = await request(ctx.server)
      .post(`/providers/${account.provider.id}/package-purchases`)
      .set('Cookie', account.cookie)
      .send({ packageId: pkg.id })
      .expect(201);
    const payUrl = `/providers/${account.provider.id}/package-purchases/${created.body.id}/mock-pay`;
    return { ...account, purchaseId: created.body.id as string, payUrl };
  }

  it('settles a purchase that lands exactly on the bound', async () => {
    const { provider, cookie, payUrl, purchaseId } = await pendingMockPurchase(10, MAX - 10);

    const paid = await request(ctx.server).post(payUrl).set('Cookie', cookie).send(MOCK_CARD);

    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe(PackagePurchaseStatus.PAID);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(MAX);
    const rows = await ledgerRows(provider.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 10, balanceAfter: MAX, referenceId: purchaseId });
  });

  it('refuses one past the bound with nothing written, and settles once there is room', async () => {
    const { provider, cookie, payUrl, purchaseId } = await pendingMockPurchase(10, MAX - 10);
    // The balance grows between the checkout and the payment.
    await grantCredits(ctx.prisma, provider.id, 1);

    const refused = await request(ctx.server).post(payUrl).set('Cookie', cookie).send(MOCK_CARD);

    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: LIMIT_CODE, currentBalance: MAX - 9, maxBalance: MAX });
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(purchase).toMatchObject({ status: PackagePurchaseStatus.PENDING, paidAt: null, creditTransactionId: null });
    expect(await ledgerRows(provider.id)).toHaveLength(0);
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(0);
    expect(ctx.notifications.sent).toHaveLength(0);

    // The same request again is refused the same way — no partial state to trip over.
    expect((await request(ctx.server).post(payUrl).set('Cookie', cookie).send(MOCK_CARD)).status).toBe(400);

    await grantCredits(ctx.prisma, provider.id, -1);
    const paid = await request(ctx.server).post(payUrl).set('Cookie', cookie).send(MOCK_CARD);
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe(PackagePurchaseStatus.PAID);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(MAX);
    expect(await ledgerRows(provider.id)).toHaveLength(1);
  });

  it('lets only one of two concurrent settlements through when both would not fit', async () => {
    const account = await providerAccount();
    const pkg = await createOfferPackage(ctx.prisma, { creditAmount: 10 });
    await setBalance(account.provider.id, MAX - 15);
    const open = async () =>
      (
        await request(ctx.server)
          .post(`/providers/${account.provider.id}/package-purchases`)
          .set('Cookie', account.cookie)
          .send({ packageId: pkg.id })
          .expect(201)
      ).body.id as string;
    const [first, second] = [await open(), await open()];

    const results = await Promise.all(
      [first, second].map((id) =>
        request(ctx.server)
          .post(`/providers/${account.provider.id}/package-purchases/${id}/mock-pay`)
          .set('Cookie', account.cookie)
          .send(MOCK_CARD),
      ),
    );

    expect(results.map((result) => result.status).sort()).toEqual([201, 400]);
    expect(results.find((result) => result.status === 400)?.body.code).toBe(LIMIT_CODE);
    expect(await currentCreditBalance(ctx.prisma, account.provider.id)).toBe(MAX - 5);
    expect(await ledgerRows(account.provider.id)).toHaveLength(1);
    const statuses = await ctx.prisma.packagePurchase.findMany({ select: { status: true } });
    expect(statuses.map((row) => row.status).sort()).toEqual([PackagePurchaseStatus.PAID, PackagePurchaseStatus.PENDING]);
  });
});

describe('settling through the payment webhook', () => {
  async function pendingLemonPurchase(creditAmount: number, balanceAtCheckout = 0) {
    const account = await providerAccount();
    const pkg = await createOfferPackage(ctx.prisma, { creditAmount, priceAmount: 49900 });
    configureLemonSqueezy(pkg.slug);
    await setBalance(account.provider.id, balanceAtCheckout);
    const created = await request(ctx.server)
      .post(`/providers/${account.provider.id}/checkout-sessions`)
      .set('Cookie', account.cookie)
      .send({ packageId: pkg.id })
      .expect(201);
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: created.body.purchase.id as string },
    });
    return { ...account, purchase, payload: lemonOrderPayload({ reference: purchase.paymentReference! }) };
  }

  async function eventRow() {
    return ctx.prisma.paymentWebhookEvent.findFirstOrThrow({ where: { eventName: 'order_created' } });
  }

  it('settles an order that lands exactly on the bound', async () => {
    const { provider, payload, purchase } = await pendingLemonPurchase(25, MAX - 25);

    const response = await deliverLemonWebhook(ctx, payload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'processed' });
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(MAX);
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe(
      PackagePurchaseStatus.PAID,
    );
  });

  it('answers one past the bound with a recorded, recoverable refusal and no partial write', async () => {
    const { provider, payload, purchase } = await pendingLemonPurchase(25, MAX - 25);
    await grantCredits(ctx.prisma, provider.id, 1);

    const response = await deliverLemonWebhook(ctx, payload);

    // 2xx: the provider must not redeliver in a loop over a refusal this
    // application recorded on purpose.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'mismatched' });
    const event = await eventRow();
    expect(event).toMatchObject({
      status: PaymentWebhookEventStatus.MISMATCHED,
      detail: LIMIT_CODE,
      firstFailureCode: LIMIT_CODE,
      purchaseId: purchase.id,
      attemptCount: 1,
      resolvedAt: null,
    });
    const after = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } });
    expect(after).toMatchObject({
      status: PackagePurchaseStatus.PENDING,
      paidAt: null,
      providerOrderId: null,
      creditTransactionId: null,
    });
    expect(await ledgerRows(provider.id)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(MAX - 24);
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(0);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('refuses a redelivery the same way while there is no room, then settles one once there is', async () => {
    const { provider, payload, purchase } = await pendingLemonPurchase(25, MAX - 25);
    await grantCredits(ctx.prisma, provider.id, 1);

    expect((await deliverLemonWebhook(ctx, payload)).body).toEqual({ status: 'mismatched' });
    expect((await deliverLemonWebhook(ctx, payload)).body).toEqual({ status: 'mismatched' });
    expect((await eventRow()).attemptCount).toBe(2);
    expect(await ledgerRows(provider.id)).toHaveLength(0);

    // The provider spends a credit; the next delivery is judged from the top.
    await grantCredits(ctx.prisma, provider.id, -1);
    expect((await deliverLemonWebhook(ctx, payload)).body).toEqual({ status: 'processed' });

    const event = await eventRow();
    expect(event).toMatchObject({
      status: PaymentWebhookEventStatus.PROCESSED,
      firstFailureCode: LIMIT_CODE,
      attemptCount: 3,
    });
    expect(event.resolvedAt).not.toBeNull();
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(MAX);
    expect(await ledgerRows(provider.id)).toHaveLength(1);
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe(
      PackagePurchaseStatus.PAID,
    );

    // And a redelivery after that is the ordinary duplicate.
    expect((await deliverLemonWebhook(ctx, payload)).body).toEqual({ status: 'duplicate' });
    expect(await ledgerRows(provider.id)).toHaveLength(1);
  });

  it('writes nothing under concurrent deliveries of an order that does not fit', async () => {
    const { provider, payload, purchase } = await pendingLemonPurchase(25, MAX - 25);
    await grantCredits(ctx.prisma, provider.id, 1);

    const results = await Promise.all([1, 2, 3].map(() => deliverLemonWebhook(ctx, payload)));

    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ status: 'mismatched' });
    }
    expect(await ledgerRows(provider.id)).toHaveLength(0);
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe(
      PackagePurchaseStatus.PENDING,
    );
    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(1);
  });

  it('settles a period package whatever the balance, because it moves none', async () => {
    const account = await providerAccount();
    const pkg = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 40,
      priceAmount: 49900,
    });
    configureLemonSqueezy(pkg.slug);
    await setBalance(account.provider.id, MAX);
    const created = await request(ctx.server)
      .post(`/providers/${account.provider.id}/checkout-sessions`)
      .set('Cookie', account.cookie)
      .send({ packageId: pkg.id })
      .expect(201);
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: created.body.purchase.id as string },
    });

    const response = await deliverLemonWebhook(ctx, lemonOrderPayload({ reference: purchase.paymentReference! }));

    expect(response.body).toEqual({ status: 'processed' });
    expect(await ctx.prisma.providerPackageEntitlement.count({ where: { purchaseId: purchase.id } })).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, account.provider.id)).toBe(MAX);
  });
});

describe('the entitlement resolver (offer spend and quota)', () => {
  it('spends from a balance at the bound: debits cannot overflow upwards', async () => {
    const { provider } = await providerAccount();
    await setBalance(provider.id, MAX);
    const resolver = ctx.app.get(EntitlementResolverService);

    const result = await ctx.prisma.$transaction((tx) =>
      resolver.consume(
        tx,
        { source: OfferEntitlementSource.ONE_TIME_CREDIT, entitlementId: null, creditCost: 3, balanceBefore: MAX },
        { providerId: provider.id, offerId: 'offer-at-bound', reason: 'Teklif', now: new Date() },
      ),
    );

    const row = await ctx.prisma.providerCreditTransaction.findUniqueOrThrow({
      where: { id: result.creditTransactionId! },
    });
    expect(row).toMatchObject({ type: CreditTransactionType.OFFER_SPEND, amount: -3, balanceAfter: MAX - 3 });
  });

  it('spends quota without touching the ledger, whatever the balance', async () => {
    const { provider } = await providerAccount();
    await setBalance(provider.id, MAX);
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.MONTHLY_QUOTA, quotaCredits: 5 });
    const entitlement = await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: pkg.id,
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 5,
    });
    const resolver = ctx.app.get(EntitlementResolverService);
    const ledgerBefore = await ctx.prisma.providerCreditTransaction.count();

    const result = await ctx.prisma.$transaction((tx) =>
      resolver.consume(
        tx,
        { source: OfferEntitlementSource.MONTHLY_QUOTA, entitlementId: entitlement.id, creditCost: 2 },
        { providerId: provider.id, offerId: 'offer-on-quota', reason: 'Teklif', now: new Date() },
      ),
    );

    expect(result.creditTransactionId).toBeNull();
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(ledgerBefore);
    expect(
      (await ctx.prisma.providerPackageEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } })).remainingQuota,
    ).toBe(3);
  });
});
