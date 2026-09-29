import {
  CreditTransactionType,
  PackagePurchaseStatus,
  PaymentWebhookEventStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDIT_LEDGER_INTEGER_MAX } from '../src/common/credit-limits';
import { LemonSqueezyCheckoutAdapter } from '../src/modules/payments/lemon-squeezy.adapter';
import { setEngineEnabled } from './campaign-fixtures';
import {
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
 * API-HARDENING-001: a captured Lemon payment refused at the credit bound.
 *
 * The whole flow, end to end:
 *
 * 1. The provider pays; the webhook's delivery is genuine and matches, but the
 *    credit would pass the ledger's integer column.
 * 2. The delivery is answered **200** (`mismatched`), so the provider stops
 *    redelivering. The event is MISMATCHED (recoverable), the purchase stays
 *    PENDING, no ledger row, no campaign event, no receipt.
 * 3. A `PackagePurchaseCreditHold` is OPEN: captured amount against the
 *    undelivered credit, filterable by an operator (`?creditHold=OPEN`),
 *    visible on the purchase detail, and on the provider's own projection as
 *    "paid, credit held" — never reused as a checkout, never cancellable by
 *    hand.
 * 4. It closes exactly once: SETTLED when a later delivery of the same order
 *    loads the credit, or REFUND_REPORTED when a reversal for that order
 *    arrives — after which the order can never become credit.
 */
let ctx: TestContext;
let originalEnv: Record<string, string | undefined>;
let checkoutCalls = 0;

const MAX = CREDIT_LEDGER_INTEGER_MAX;
const CREDITS = 25;
const ORDER = 'order-991';

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

async function setBalance(providerId: string, balance: number) {
  const current = await currentCreditBalance(ctx.prisma, providerId);
  if (balance !== current) await grantCredits(ctx.prisma, providerId, balance - current);
}

/** A paid-for checkout whose credit no longer fits: MAX − 24 at delivery. */
async function heldScenario() {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, { userId: user.id });
  const cookie = await loginAs(ctx.prisma, user.id);
  const pkg = await createOfferPackage(ctx.prisma, { creditAmount: CREDITS, priceAmount: 49900 });
  configureLemonSqueezy(pkg.slug);
  await setBalance(provider.id, MAX - CREDITS);
  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/checkout-sessions`)
    .set('Cookie', cookie)
    .send({ packageId: pkg.id })
    .expect(201);
  const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
    where: { id: created.body.purchase.id as string },
  });
  // The balance grows between the checkout and the capture.
  await grantCredits(ctx.prisma, provider.id, 1);
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return {
    provider,
    cookie,
    pkg,
    purchase,
    adminCookie: await loginAs(ctx.prisma, admin.id),
    paid: lemonOrderPayload({ reference: purchase.paymentReference!, orderId: ORDER }),
    refunded: lemonOrderPayload({ eventName: 'order_refunded', reference: purchase.paymentReference!, orderId: ORDER }),
  };
}

const hold = (purchaseId: string) => ctx.prisma.packagePurchaseCreditHold.findUnique({ where: { purchaseId } });
const purchaseRow = (id: string) => ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id } });
const creditRows = () =>
  ctx.prisma.providerCreditTransaction.findMany({ where: { type: CreditTransactionType.PACKAGE_PURCHASE } });
const paidEvent = () => ctx.prisma.paymentWebhookEvent.findFirstOrThrow({ where: { eventName: 'order_created' } });

describe('a captured payment refused at the credit bound', () => {
  it('answers 200, records MISMATCHED, keeps the purchase PENDING and opens one hold', async () => {
    const s = await heldScenario();

    const response = await deliverLemonWebhook(ctx, s.paid);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'mismatched' });
    const event = await paidEvent();
    expect(event).toMatchObject({
      status: PaymentWebhookEventStatus.MISMATCHED,
      detail: 'CREDIT_BALANCE_LIMIT_EXCEEDED',
      attemptCount: 1,
      purchaseId: s.purchase.id,
    });
    expect(await purchaseRow(s.purchase.id)).toMatchObject({
      status: PackagePurchaseStatus.PENDING,
      paidAt: null,
      providerOrderId: null,
      creditTransactionId: null,
      // The reversal slot is untouched: a hold is not a chargeback.
      manualReviewAt: null,
      manualReviewReason: null,
    });
    expect(await hold(s.purchase.id)).toMatchObject({
      status: 'OPEN',
      reason: 'CREDIT_BALANCE_LIMIT_EXCEEDED',
      providerOrderId: ORDER,
      chargedAmountMinor: 49900,
      currency: 'TRY',
      creditAmount: CREDITS,
      balanceAtOpen: MAX - CREDITS + 1,
      refusedDeliveries: 1,
      openedEventId: event.id,
      resolvedAt: null,
      creditTransactionId: null,
    });
    expect(await creditRows()).toHaveLength(0);
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(0);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('shows the operator the gap: an OPEN filter on the list and the whole hold on the detail', async () => {
    const s = await heldScenario();
    await deliverLemonWebhook(ctx, s.paid).expect(200);
    // An ordinary unpaid checkout of another provider, which must not appear under the filter.
    const other = await heldScenario();

    const open = await request(ctx.server).get('/package-purchases?creditHold=OPEN').set('Cookie', s.adminCookie);
    expect(open.status).toBe(200);
    expect(open.body.map((row: { id: string }) => row.id)).toEqual([s.purchase.id]);
    expect(open.body[0].creditHold).toMatchObject({ status: 'OPEN', chargedAmountMinor: 49900, creditAmount: CREDITS });

    const all = await request(ctx.server).get('/package-purchases').set('Cookie', s.adminCookie);
    const otherRow = all.body.find((row: { id: string }) => row.id === other.purchase.id);
    expect(otherRow.creditHold).toBeNull();

    const detail = await request(ctx.server).get(`/package-purchases/${s.purchase.id}`).set('Cookie', s.adminCookie);
    expect(detail.body.creditHold).toMatchObject({
      status: 'OPEN',
      providerOrderId: ORDER,
      balanceAtOpen: MAX - CREDITS + 1,
      refusedDeliveries: 1,
      openedEvent: { eventName: 'order_created' },
      resolvedEvent: null,
    });

    expect((await request(ctx.server).get('/package-purchases?creditHold=maybe').set('Cookie', s.adminCookie)).status).toBe(400);
  });

  it("tells the provider it was paid and held — without the order id — and never hands the checkout back", async () => {
    const s = await heldScenario();
    await deliverLemonWebhook(ctx, s.paid).expect(200);

    const own = await request(ctx.server)
      .get(`/providers/${s.provider.id}/package-purchases/${s.purchase.id}`)
      .set('Cookie', s.cookie);
    expect(own.body.status).toBe('PENDING');
    expect(own.body.creditHold).toEqual({
      status: 'OPEN',
      chargedAmountMinor: 49900,
      currency: 'TRY',
      creditAmount: CREDITS,
      openedAt: expect.any(String),
      resolvedAt: null,
    });

    // Room appears; buying the same package again opens a *new* checkout
    // rather than handing back the one that was already paid.
    await grantCredits(ctx.prisma, s.provider.id, -CREDITS);
    const again = await request(ctx.server)
      .post(`/providers/${s.provider.id}/checkout-sessions`)
      .set('Cookie', s.cookie)
      .send({ packageId: s.pkg.id })
      .expect(201);
    expect(again.body.purchase.id).not.toBe(s.purchase.id);
  });

  it('refuses a manual cancel or expire while the hold is open', async () => {
    const s = await heldScenario();
    await deliverLemonWebhook(ctx, s.paid).expect(200);

    for (const status of ['CANCELLED', 'EXPIRED']) {
      const response = await request(ctx.server)
        .patch(`/package-purchases/${s.purchase.id}/status`)
        .set('Cookie', s.adminCookie)
        .send({ status, adminNote: 'kapat' });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('PURCHASE_CREDIT_HOLD_OPEN');
    }
    expect((await purchaseRow(s.purchase.id)).status).toBe(PackagePurchaseStatus.PENDING);
  });

  it('counts redeliveries of the same event on the one hold, and stays unresolved while there is no room', async () => {
    const s = await heldScenario();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await deliverLemonWebhook(ctx, s.paid)).body).toEqual({ status: 'mismatched' });
    }

    expect(await ctx.prisma.packagePurchaseCreditHold.count()).toBe(1);
    expect(await hold(s.purchase.id)).toMatchObject({ status: 'OPEN', refusedDeliveries: 3 });
    expect((await paidEvent()).attemptCount).toBe(3);
    expect(await creditRows()).toHaveLength(0);
    expect((await purchaseRow(s.purchase.id)).status).toBe(PackagePurchaseStatus.PENDING);
  });

  it('opens one hold under two concurrent deliveries and writes no credit', async () => {
    const s = await heldScenario();

    const results = await Promise.all([deliverLemonWebhook(ctx, s.paid), deliverLemonWebhook(ctx, s.paid)]);

    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ status: 'mismatched' });
    }
    expect(await ctx.prisma.packagePurchaseCreditHold.count()).toBe(1);
    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(1);
    expect(await creditRows()).toHaveLength(0);
    expect((await hold(s.purchase.id))?.status).toBe('OPEN');
  });
});

describe('closing a hold', () => {
  it('SETTLED once, by the later delivery that loads the credit', async () => {
    // With the campaign engine on, so "no payment event while held" is a real
    // statement rather than the engine being off.
    await setEngineEnabled(ctx.prisma, true);
    const s = await heldScenario();
    await deliverLemonWebhook(ctx, s.paid).expect(200);
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(0);
    await grantCredits(ctx.prisma, s.provider.id, -1);

    const settled = await deliverLemonWebhook(ctx, s.paid);

    expect(settled.body).toEqual({ status: 'processed' });
    const purchase = await purchaseRow(s.purchase.id);
    expect(purchase).toMatchObject({ status: PackagePurchaseStatus.PAID, providerOrderId: ORDER });
    const rows = await creditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: CREDITS, balanceAfter: MAX });
    const event = await paidEvent();
    expect(await hold(s.purchase.id)).toMatchObject({
      status: 'SETTLED',
      creditTransactionId: purchase.creditTransactionId,
      resolvedEventId: event.id,
      refusedDeliveries: 1,
    });
    // The settlement's own effects arrive exactly once, now.
    expect(await ctx.prisma.campaignTriggerEvent.count({ where: { purchaseId: s.purchase.id } })).toBe(1);
    expect(ctx.notifications.sent.map((message) => message.template)).toEqual(['package-purchase-confirmation']);

    // A redelivery after that is the ordinary duplicate; the hold does not move.
    const before = await hold(s.purchase.id);
    expect((await deliverLemonWebhook(ctx, s.paid)).body).toEqual({ status: 'duplicate' });
    expect(await hold(s.purchase.id)).toEqual(before);
    expect(await creditRows()).toHaveLength(1);
  });

  it('SETTLED once under concurrent deliveries after room appears', async () => {
    const s = await heldScenario();
    await deliverLemonWebhook(ctx, s.paid).expect(200);
    await grantCredits(ctx.prisma, s.provider.id, -1);

    const results = await Promise.all([deliverLemonWebhook(ctx, s.paid), deliverLemonWebhook(ctx, s.paid)]);

    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(results.map((result) => result.body.status)).toContain('processed');
    expect(await creditRows()).toHaveLength(1);
    expect((await hold(s.purchase.id))?.status).toBe('SETTLED');
    expect(await currentCreditBalance(ctx.prisma, s.provider.id)).toBe(MAX);
  });

  it('REFUND_REPORTED by a reversal for the held order, after which the order never becomes credit', async () => {
    const s = await heldScenario();
    await deliverLemonWebhook(ctx, s.paid).expect(200);

    const reversal = await deliverLemonWebhook(ctx, s.refunded);

    expect(reversal.status).toBe(200);
    const reversalEvent = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({ where: { eventName: 'order_refunded' } });
    expect(await hold(s.purchase.id)).toMatchObject({
      status: 'REFUND_REPORTED',
      resolvedEventId: reversalEvent.id,
      creditTransactionId: null,
    });
    expect((await purchaseRow(s.purchase.id)).manualReviewReason).toBe('PAYMENT_REVERSAL_REPORTED');

    // Room appears and the provider redelivers the paid event: refused.
    await grantCredits(ctx.prisma, s.provider.id, -CREDITS);
    const late = await deliverLemonWebhook(ctx, s.paid);
    expect(late.body).toEqual({ status: 'mismatched' });
    expect((await paidEvent()).detail).toBe('CREDIT_HOLD_REFUND_REPORTED');
    expect(await creditRows()).toHaveLength(0);
    expect((await purchaseRow(s.purchase.id)).status).toBe(PackagePurchaseStatus.PENDING);
    // A second reversal delivery does not reopen or move it.
    await deliverLemonWebhook(ctx, s.refunded).expect(200);
    expect((await hold(s.purchase.id))?.resolvedEventId).toBe(reversalEvent.id);
  });

  it('ignores a reversal for a different order, and refuses a capture of another order for the held purchase', async () => {
    const s = await heldScenario();
    await deliverLemonWebhook(ctx, s.paid).expect(200);

    await deliverLemonWebhook(
      ctx,
      lemonOrderPayload({ eventName: 'order_refunded', reference: s.purchase.paymentReference!, orderId: 'order-other' }),
    ).expect(200);
    expect((await hold(s.purchase.id))?.status).toBe('OPEN');

    await grantCredits(ctx.prisma, s.provider.id, -CREDITS);
    const otherOrder = await deliverLemonWebhook(
      ctx,
      lemonOrderPayload({ reference: s.purchase.paymentReference!, orderId: 'order-second-capture' }),
    );
    expect(otherOrder.body).toEqual({ status: 'mismatched' });
    const refused = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({
      where: { eventName: 'order_created', detail: 'CREDIT_HOLD_ORDER_MISMATCH' },
    });
    expect(refused.purchaseId).toBe(s.purchase.id);
    expect(await creditRows()).toHaveLength(0);
    expect((await hold(s.purchase.id))?.status).toBe('OPEN');
  });
});

describe('the database keeps a hold honest', () => {
  it('refuses a delete, a second close, a rewritten identity and a status without its resolution', async () => {
    const s = await heldScenario();
    await deliverLemonWebhook(ctx, s.paid).expect(200);
    const id = (await hold(s.purchase.id))!.id;

    await expect(ctx.prisma.packagePurchaseCreditHold.delete({ where: { id } })).rejects.toThrow(/never deleted/);
    await expect(
      ctx.prisma.packagePurchaseCreditHold.update({ where: { id }, data: { creditAmount: 1 } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      ctx.prisma.packagePurchaseCreditHold.update({ where: { id }, data: { status: 'SETTLED' } }),
    ).rejects.toThrow(/resolution_matches_status/);

    await deliverLemonWebhook(ctx, s.refunded).expect(200);
    await expect(
      ctx.prisma.packagePurchaseCreditHold.update({ where: { id }, data: { refusedDeliveries: 9 } }),
    ).rejects.toThrow(/is closed/);
  });
});
