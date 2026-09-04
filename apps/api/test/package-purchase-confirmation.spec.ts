import {
  CreditTransactionType,
  NotificationStatus,
  OfferPackageType,
  PackagePurchaseStatus,
  UserRole,
} from '@prisma/client';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LEMON_SQUEEZY_SIGNATURE_HEADER } from '../src/modules/payments/lemon-squeezy.webhook';
import { TransactionalMailService } from '../src/modules/notifications/transactional-mail.service';
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
 * The receipt for a credit package, and the three things that make it safe.
 *
 * 1. **It follows the money.** A message exists when — and only when — a
 *    purchase really became PAID and a PACKAGE_PURCHASE ledger row really
 *    appeared beside it. A declined card, an abandoned checkout and a
 *    settlement that raised inside its own transaction all produce nothing.
 * 2. **It goes to the buyer.** The address is the one on the provider's own
 *    account, not the contact field somebody typed into an application form and
 *    not an operator.
 * 3. **It happens once.** Both settlement paths key the send on the purchase,
 *    so a webhook the provider redelivers — or a deployment where both paths
 *    somehow ran — still produces exactly one receipt.
 *
 * What the message looks like is `transactional-email-render.spec.ts`; what
 * reaches whom is here.
 */

const TEMPLATE = 'package-purchase-confirmation';
const CREDIT_AMOUNT = 30;
const PRICE_AMOUNT = 49900;

const PLACEHOLDER_API_KEY = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.${'placeholderNotARealCredential'}`;
const WEBHOOK_SECRET = 'placeholder-webhook-secret-not-real';
const STORE_ID = '424242';
const VARIANT_ID = '778899';
const WEBHOOK_PATH = '/payments/lemon-squeezy/webhook';

const MANAGED_KEYS = [
  'PAYMENT_PROVIDER',
  'LEMON_SQUEEZY_API_KEY',
  'LEMON_SQUEEZY_STORE_ID',
  'LEMON_SQUEEZY_WEBHOOK_SECRET',
  'LEMON_SQUEEZY_VARIANT_MAP',
] as const;

let ctx: TestContext;
let original: Record<string, string | undefined>;

beforeAll(async () => {
  ctx = await createTestApp();
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

const card = {
  cardholderName: 'Test Kart',
  cardNumber: '4111111111111111',
  expiryMonth: 12,
  expiryYear: 2030,
  cvv: '123',
};

/**
 * A provider who owns their profile, and an active credit package.
 *
 * The account address and the application's own contact field are deliberately
 * different values, so "which address did the receipt go to" has an answer.
 */
async function providerFixture(
  options: { packageType?: OfferPackageType; creditAmount?: number } = {},
) {
  const suffix = uniqueSuffix();
  const accountEmail = `hesap-${suffix}@example.test`;
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER, email: accountEmail });
  const provider = await createProviderProfile(ctx.prisma, {
    userId: owner.id,
    email: `basvuru-formu-${suffix}@example.test`,
  });

  const type = options.packageType ?? OfferPackageType.ONE_TIME_CREDITS;
  const isOneTime = type === OfferPackageType.ONE_TIME_CREDITS;

  const creditPackage = await ctx.prisma.offerCreditPackage.create({
    data: {
      name: `Başlangıç Paketi ${suffix}`,
      slug: `paket-${suffix}`,
      creditAmount: options.creditAmount ?? (isOneTime ? CREDIT_AMOUNT : 0),
      priceAmount: PRICE_AMOUNT,
      currency: 'TRY',
      isActive: true,
      type,
      ...(isOneTime ? {} : { quotaCredits: 40, periodDays: 30, dailyOfferLimit: 5 }),
    },
  });

  const cookie = await loginAs(ctx.prisma, owner.id);

  return { owner, provider, creditPackage, cookie, accountEmail };
}

/** Opens a PENDING purchase through the provider's own endpoint. */
async function openPurchase(providerId: string, packageId: string, cookie: string) {
  const created = await request(ctx.server)
    .post(`/providers/${providerId}/package-purchases`)
    .set('Cookie', cookie)
    .send({ packageId })
    .expect(201);

  return created.body.id as string;
}

function payMock(providerId: string, purchaseId: string, cookie: string, body = card) {
  return request(ctx.server)
    .post(`/providers/${providerId}/package-purchases/${purchaseId}/mock-pay`)
    .set('Cookie', cookie)
    .send(body);
}

function receipts(to?: string) {
  const sent = ctx.notifications.ofTemplate(TEMPLATE);
  return to ? sent.filter((message) => message.to.toLowerCase() === to.toLowerCase()) : sent;
}

function receiptLogs() {
  return ctx.prisma.notificationLog.findMany({ where: { template: TEMPLATE } });
}

// ─────────────────────────── the mock payment form ───────────────────────────

describe('a settled credit package produces one receipt', () => {
  it('mails the provider’s account address with the package, credits, price and reference', async () => {
    const { provider, creditPackage, cookie, accountEmail } = await providerFixture();
    const purchaseId = await openPurchase(provider.id, creditPackage.id, cookie);

    const paid = await payMock(provider.id, purchaseId, cookie).expect(201);
    expect(paid.body.status).toBe(PackagePurchaseStatus.PAID);

    const sent = receipts();
    expect(sent).toHaveLength(1);

    const message = sent[0]!;
    // The account address, not the contact field on the application form.
    expect(message.to).toBe(accountEmail);
    expect(message.to).not.toBe(provider.email);
    expect(message.subject).toBe('Kredi paketiniz hesabınıza yüklendi');

    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: purchaseId },
    });
    const ledger = await ctx.prisma.providerCreditTransaction.findMany({
      where: { providerId: provider.id, type: CreditTransactionType.PACKAGE_PURCHASE },
    });
    expect(ledger).toHaveLength(1);

    expect(message.data).toMatchObject({
      fullName: provider.contactName,
      packageName: creditPackage.name,
      // The figure the balance actually moved by, read off the ledger row.
      creditAmount: String(ledger[0]!.amount),
      priceAmountMinor: String(PRICE_AMOUNT),
      currency: 'TRY',
      purchaseNumber: purchase.purchaseNumber,
    });
    expect(message.data?.paidAt).toBe(purchase.paidAt?.toISOString());
    expect(message.data?.creditsUrl).toContain(`/providers/${provider.id}/credits`);

    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(CREDIT_AMOUNT);
  });

  it('writes one audit row, keyed on the purchase', async () => {
    const { provider, creditPackage, cookie } = await providerFixture();
    const purchaseId = await openPurchase(provider.id, creditPackage.id, cookie);

    await payMock(provider.id, purchaseId, cookie).expect(201);

    const logs = await receiptLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      status: NotificationStatus.SENT,
      dedupeKey: `package-purchase:${purchaseId}`,
      providerId: provider.id,
    });
    // The row holds no address, only a mask.
    expect(logs[0]?.maskedRecipient).not.toContain('hesap-');
  });

  it('carries nothing about the payment provider or the operator', async () => {
    const { provider, creditPackage, cookie } = await providerFixture();
    const purchaseId = await openPurchase(provider.id, creditPackage.id, cookie);
    await ctx.prisma.packagePurchase.update({
      where: { id: purchaseId },
      data: { adminNote: 'İç not: elle doğrulandı' },
    });

    await payMock(provider.id, purchaseId, cookie).expect(201);

    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: purchaseId },
    });
    const payload = JSON.stringify(receipts()[0]?.data ?? {});

    expect(payload).not.toContain('İç not');
    expect(payload).not.toContain(purchase.mockPaymentReference ?? '@@none@@');
    expect(payload).not.toContain('mock');
  });
});

describe('a purchase that did not settle produces nothing', () => {
  it('sends no receipt for a declined card', async () => {
    const { provider, creditPackage, cookie } = await providerFixture();
    const purchaseId = await openPurchase(provider.id, creditPackage.id, cookie);

    const declined = await payMock(provider.id, purchaseId, cookie, {
      ...card,
      cardNumber: '4111111111110000',
    }).expect(201);

    expect(declined.body.status).toBe(PackagePurchaseStatus.FAILED);
    expect(receipts()).toHaveLength(0);
    expect(await receiptLogs()).toHaveLength(0);
  });

  it('sends no receipt while a purchase is still pending', async () => {
    const { provider, creditPackage, cookie } = await providerFixture();
    await openPurchase(provider.id, creditPackage.id, cookie);

    expect(receipts()).toHaveLength(0);
    expect(await receiptLogs()).toHaveLength(0);
  });

  it('sends no receipt for a cancelled purchase', async () => {
    const { provider, creditPackage, cookie } = await providerFixture();
    const purchaseId = await openPurchase(provider.id, creditPackage.id, cookie);

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    await request(ctx.server)
      .patch(`/package-purchases/${purchaseId}/status`)
      .set('Cookie', adminCookie)
      .send({ status: PackagePurchaseStatus.CANCELLED })
      .expect(200);

    expect(receipts()).toHaveLength(0);
    expect(await receiptLogs()).toHaveLength(0);
  });

  /**
   * The transaction-boundary case.
   *
   * The settlement raises inside its own Serializable transaction — here
   * because the ledger would have to take the balance below zero — so the
   * purchase is still PENDING, no credit moved, and, the part this case exists
   * for, no message and no audit row were produced. The send sits after the
   * commit precisely so that a settlement which never committed cannot leave a
   * receipt claiming it did.
   */
  it('leaves no receipt when the settling transaction rolls back', async () => {
    const { provider, creditPackage, cookie } = await providerFixture();
    const purchaseId = await openPurchase(provider.id, creditPackage.id, cookie);

    await ctx.prisma.packagePurchase.update({
      where: { id: purchaseId },
      data: { creditAmountSnapshot: -CREDIT_AMOUNT },
    });

    await payMock(provider.id, purchaseId, cookie).expect(400);

    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: purchaseId },
    });
    expect(purchase.status).toBe(PackagePurchaseStatus.PENDING);
    expect(purchase.paidAt).toBeNull();
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
    expect(receipts()).toHaveLength(0);
    expect(await receiptLogs()).toHaveLength(0);
  });

  it('sends no receipt for a period package, which moves no balance', async () => {
    const { provider, creditPackage, cookie } = await providerFixture({
      packageType: OfferPackageType.MONTHLY_QUOTA,
    });
    const purchaseId = await openPurchase(provider.id, creditPackage.id, cookie);

    const paid = await payMock(provider.id, purchaseId, cookie).expect(201);
    expect(paid.body.status).toBe(PackagePurchaseStatus.PAID);

    expect(receipts()).toHaveLength(0);
    expect(await receiptLogs()).toHaveLength(0);
  });
});

/**
 * The composer, driven directly.
 *
 * These are the states a rolled-back or half-finished settlement leaves behind.
 * The service re-reads the committed rows and refuses each one rather than
 * trusting that its caller only ever asks about real settlements.
 */
describe('the composer refuses anything it cannot stand behind', () => {
  it('refuses a purchase that is not PAID, has no ledger row, or sold no credits', async () => {
    const mail = ctx.app.get(TransactionalMailService);
    const { provider, creditPackage, cookie } = await providerFixture();
    const purchaseId = await openPurchase(provider.id, creditPackage.id, cookie);

    // PENDING.
    await mail.sendPackagePurchaseConfirmation(purchaseId);
    expect(receipts()).toHaveLength(0);

    // PAID on paper, with no credit movement behind it.
    await ctx.prisma.packagePurchase.update({
      where: { id: purchaseId },
      data: { status: PackagePurchaseStatus.PAID, paidAt: new Date() },
    });
    await mail.sendPackagePurchaseConfirmation(purchaseId);
    expect(receipts()).toHaveLength(0);

    // A purchase that does not exist at all.
    await mail.sendPackagePurchaseConfirmation('does-not-exist');
    expect(receipts()).toHaveLength(0);
    expect(await receiptLogs()).toHaveLength(0);
  });
});

// ──────────────────────────── the payment webhook ────────────────────────────

function configureLemonSqueezy(packageSlug: string) {
  process.env.PAYMENT_PROVIDER = 'lemon-squeezy-test';
  process.env.LEMON_SQUEEZY_API_KEY = PLACEHOLDER_API_KEY;
  process.env.LEMON_SQUEEZY_STORE_ID = STORE_ID;
  process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.LEMON_SQUEEZY_VARIANT_MAP = `${packageSlug}:${VARIANT_ID}`;
}

/** A settlement notice shaped the way Lemon Squeezy sends one. */
function orderPayload(reference: string, orderId = 'order-991') {
  return {
    meta: {
      event_name: 'order_created',
      test_mode: true,
      custom_data: { purchase_reference: reference },
    },
    data: {
      type: 'orders',
      id: orderId,
      attributes: {
        store_id: Number(STORE_ID),
        status: 'paid',
        total: PRICE_AMOUNT + 2,
        currency: 'TRY',
        user_name: 'Ayşe Yılmaz',
        user_email: 'ayse.yilmaz@example.test',
        first_order_item: {
          variant_id: Number(VARIANT_ID),
          price: PRICE_AMOUNT,
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

/** A pending purchase already correlated with a hosted checkout. */
async function hostedCheckoutFixture() {
  const fixture = await providerFixture();
  configureLemonSqueezy(fixture.creditPackage.slug);

  const purchaseId = await openPurchase(
    fixture.provider.id,
    fixture.creditPackage.id,
    fixture.cookie,
  );
  const reference = `ref-${uniqueSuffix()}-${Date.now()}`;

  await ctx.prisma.packagePurchase.update({
    where: { id: purchaseId },
    data: { paymentProvider: 'lemon-squeezy-test', paymentReference: reference },
  });

  return { ...fixture, purchaseId, reference };
}

describe('a verified settlement notice', () => {
  it('produces exactly one receipt for the provider who bought the package', async () => {
    const { provider, purchaseId, reference, accountEmail } = await hostedCheckoutFixture();

    await deliver(orderPayload(reference)).expect(200).expect({ status: 'processed' });

    const sent = receipts(accountEmail);
    expect(sent).toHaveLength(1);
    expect(receipts()).toHaveLength(1);

    const logs = await receiptLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.dedupeKey).toBe(`package-purchase:${purchaseId}`);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(CREDIT_AMOUNT);
  });

  it('adds neither a second credit nor a second receipt when it is redelivered', async () => {
    const { provider, reference } = await hostedCheckoutFixture();

    await deliver(orderPayload(reference)).expect(200).expect({ status: 'processed' });
    await deliver(orderPayload(reference)).expect(200).expect({ status: 'duplicate' });
    await deliver(orderPayload(reference)).expect(200).expect({ status: 'duplicate' });

    expect(
      await ctx.prisma.providerCreditTransaction.count({
        where: { providerId: provider.id, type: CreditTransactionType.PACKAGE_PURCHASE },
      }),
    ).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(CREDIT_AMOUNT);

    expect(receipts()).toHaveLength(1);
    expect(await receiptLogs()).toHaveLength(1);
  });

  it('sends nothing for a notice this application refuses', async () => {
    const { provider, reference } = await hostedCheckoutFixture();

    // The order has not settled on the provider's side.
    const unsettled = orderPayload(reference);
    unsettled.data.attributes.status = 'pending';
    await deliver(unsettled).expect(200).expect({ status: 'ignored' });

    // The amount does not agree with the snapshot this checkout was opened on.
    const wrongAmount = orderPayload(reference, 'order-992');
    wrongAmount.data.attributes.first_order_item.price = PRICE_AMOUNT - 100;
    await deliver(wrongAmount).expect(200).expect({ status: 'mismatched' });

    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
    expect(receipts()).toHaveLength(0);
    expect(await receiptLogs()).toHaveLength(0);
  });

  it('produces one receipt even if a settled purchase is offered to both paths', async () => {
    const { provider, purchaseId, cookie, reference } = await hostedCheckoutFixture();

    await deliver(orderPayload(reference)).expect(200).expect({ status: 'processed' });

    // The mock form refuses an already-PAID purchase, and the dedupe key would
    // refuse a second receipt even if it did not.
    process.env.PAYMENT_PROVIDER = 'mock';
    await payMock(provider.id, purchaseId, cookie).expect(409);

    expect(receipts()).toHaveLength(1);
    expect(await receiptLogs()).toHaveLength(1);
  });
});
