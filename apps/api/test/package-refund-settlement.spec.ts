import {
  PackagePurchaseStatus,
  PackageRefundActorKind,
  PackageRefundRequestStatus,
  PaymentWebhookEventStatus,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LemonSqueezyCheckoutAdapter } from '../src/modules/payments/lemon-squeezy.adapter';
import { MANUAL_REVIEW_REASON } from '../src/modules/payments/payments-webhook.service';
import { createTestApp, resetDatabase, uniqueSuffix, type TestContext } from './harness';
import {
  LEMON_HOSTED_URL,
  configureLemonSqueezy,
  deliverLemonWebhook,
  lemonOrderPayload,
  restoreLemonEnv,
  snapshotLemonEnv,
} from './lemon-squeezy-fixtures';
import {
  ACCEPTED_TERMS,
  adminCall,
  gateSwitch,
  openRefundTicket,
  operator,
  providerAccount,
  requestOfTicket,
} from './package-refund-fixtures';

/**
 * CMP-006 PR-B — SETTLED is the webhook's fact and nobody else's.
 *
 * Every scenario runs the real chain against the sandbox wiring: a checkout
 * opened with the purchase-terms gate on (so the purchase carries evidence),
 * the signed `order_created` delivery that makes it PAID, a refund request
 * opened from the support form, the operator's take and approval, and then the
 * signed `order_refunded` delivery. Nothing reaches Lemon Squeezy.
 *
 * What is asserted beyond "it settled": the S3 path still runs exactly as it
 * did (flag, event row), a purchase with no request produces no request, the
 * settlement writes no ledger row, a redelivery writes nothing twice, and an
 * irrelevant or unsigned reversal settles nothing.
 */

let ctx: TestContext;
let originalLemon: Record<string, string | undefined>;
const gate = gateSwitch();

beforeAll(async () => {
  ctx = await createTestApp({
    paymentProvider: new LemonSqueezyCheckoutAdapter(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        data: { type: 'checkouts', id: `checkout-${uniqueSuffix()}`, attributes: { url: LEMON_HOSTED_URL } },
      }),
    })),
  });
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  originalLemon = snapshotLemonEnv();
  gate.remember();
  gate.open();
});

afterEach(() => {
  restoreLemonEnv(originalLemon);
  gate.restore();
});

/** A provider with one sandbox purchase, settled PAID through the signed webhook. */
async function paidThroughWebhook() {
  const suffix = uniqueSuffix();
  const slug = `iade-paketi-${suffix}`;
  const pkg = await ctx.prisma.offerCreditPackage.create({
    data: { name: `İade Paketi ${suffix}`, slug, creditAmount: 25, priceAmount: 49900, currency: 'TRY', isActive: true },
  });
  configureLemonSqueezy(slug);

  const account = await providerAccount(ctx);
  const created = await request(ctx.server)
    .post(`/providers/${account.provider.id}/checkout-sessions`)
    .set('Cookie', account.cookie)
    .send({ packageId: pkg.id, ...ACCEPTED_TERMS })
    .expect(201);
  const purchaseId = created.body.purchase.id as string;
  const pending = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchaseId } });
  expect(pending.termsAcceptanceRequired).toBe(true);

  const orderId = `order-${suffix}`;
  const reference = pending.paymentReference!;
  await deliverLemonWebhook(ctx, lemonOrderPayload({ reference, orderId })).expect(200);
  const paid = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchaseId } });
  expect(paid.status).toBe(PackagePurchaseStatus.PAID);

  return { ...account, purchaseId, orderId, reference };
}

async function approvedRequest(fixture: Awaited<ReturnType<typeof paidThroughWebhook>>) {
  const opened = await openRefundTicket(ctx, fixture.cookie, fixture.purchaseId).expect(201);
  const refund = await requestOfTicket(ctx.prisma, opened.body.id);
  const { cookie } = await operator(ctx);
  const admin = adminCall(ctx, cookie);
  await admin.take(refund.id).expect(200);
  await admin.approve(refund.id, { kind: 'NORMAL' }).expect(200);
  return { ticketId: opened.body.id as string, requestId: refund.id, admin };
}

function refunded(fixture: { reference: string; orderId: string }, overrides: Record<string, unknown> = {}) {
  return lemonOrderPayload({
    eventName: 'order_refunded',
    reference: fixture.reference,
    orderId: fixture.orderId,
    status: 'refunded',
    ...overrides,
  });
}

async function ledgerCount(providerId: string) {
  return ctx.prisma.providerCreditTransaction.count({ where: { providerId } });
}

describe('an approved request, and the signed order_refunded for its order', () => {
  it('settles the request naming the webhook event, marks the purchase REFUNDED, and moves no credit', async () => {
    const fixture = await paidThroughWebhook();
    const { requestId, ticketId } = await approvedRequest(fixture);
    const ledgerBefore = await ledgerCount(fixture.provider.id);

    const response = await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);
    expect(response.body).toEqual({ status: 'manual_review_required' });

    const event = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({
      where: { eventName: 'order_refunded' },
    });
    const settled = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(settled.status).toBe(PackageRefundRequestStatus.SETTLED);
    expect(settled.settledByWebhookEventId).toBe(event.id);
    expect(settled.settledAt).not.toBeNull();
    expect(settled.creditClawbackCredits).toBe(0);

    // The S3 half is untouched: the purchase is flagged and the event recorded
    // exactly as before this slice.
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } });
    expect(purchase.manualReviewReason).toBe(MANUAL_REVIEW_REASON);
    expect(event.status).toBe(PaymentWebhookEventStatus.MANUAL_REVIEW_REQUIRED);
    // And the new half: REFUNDED, written by the webhook only.
    expect(purchase.status).toBe(PackagePurchaseStatus.REFUNDED);
    expect(purchase.refundedAt).not.toBeNull();

    // No money, no credit: the settlement wrote no ledger row.
    expect(await ledgerCount(fixture.provider.id)).toBe(ledgerBefore);

    const audit = await ctx.prisma.packageRefundRequestEvent.findMany({
      where: { requestId, action: 'SETTLED' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorKind: PackageRefundActorKind.PAYMENT_WEBHOOK,
      actorId: null,
      webhookEventId: event.id,
      fromStatus: 'APPROVED_PENDING_SETTLEMENT',
      toStatus: 'SETTLED',
    });

    // The provider's ticket says so, without naming anybody.
    const ticket = await request(ctx.server)
      .get(`/support/tickets/${ticketId}`)
      .set('Cookie', fixture.cookie)
      .expect(200);
    expect(ticket.body.packageRefundRequest.status).toBe('SETTLED');
    const settledEntry = ticket.body.timeline.find(
      (entry: { kind: string; action?: string }) => entry.kind === 'PACKAGE_REFUND_EVENT' && entry.action === 'SETTLED',
    );
    expect(Object.keys(settledEntry).sort()).toEqual(
      ['action', 'createdAt', 'id', 'kind', 'statusLabel', 'toStatus'].sort(),
    );
  });

  it('a redelivery is idempotent: one state change, one audit row, no second write anywhere', async () => {
    const fixture = await paidThroughWebhook();
    const { requestId } = await approvedRequest(fixture);

    await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);
    const afterFirst = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: requestId } });
    const ledgerAfterFirst = await ledgerCount(fixture.provider.id);

    const again = await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);
    expect(again.body).toEqual({ status: 'duplicate' });
    const concurrent = await Promise.all([
      deliverLemonWebhook(ctx, refunded(fixture)),
      deliverLemonWebhook(ctx, refunded(fixture)),
    ]);
    for (const response of concurrent) {
      expect(response.status).toBe(200);
    }

    const afterAll = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(afterAll.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
    expect(await ctx.prisma.packageRefundRequestEvent.count({ where: { requestId, action: 'SETTLED' } })).toBe(1);
    expect(await ledgerCount(fixture.provider.id)).toBe(ledgerAfterFirst);
    const event = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({ where: { eventName: 'order_refunded' } });
    expect(event.attemptCount).toBe(4);
  });

  it('after settlement the operator can neither fail it nor open another request for the purchase', async () => {
    const fixture = await paidThroughWebhook();
    const { requestId, admin } = await approvedRequest(fixture);
    await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);

    const failed = await admin.settlementFailed(requestId, 'Lemon panelinde iade görünmüyor.').expect(409);
    expect(failed.body.code).toBe('PACKAGE_REFUND_INVALID_TRANSITION');

    const second = await openRefundTicket(ctx, fixture.cookie, fixture.purchaseId).expect(409);
    expect(second.body.code).toBe('PACKAGE_REFUND_NOT_ELIGIBLE');
    expect(second.body.blockingCodes).toEqual(['PURCHASE_ALREADY_REFUNDED']);
  });
});

describe('a reversal that must not settle anything', () => {
  it('no request: the S3 path runs exactly as before and no request appears', async () => {
    const fixture = await paidThroughWebhook();

    const response = await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);
    expect(response.body).toEqual({ status: 'manual_review_required' });

    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } });
    expect(purchase.status).toBe(PackagePurchaseStatus.PAID);
    expect(purchase.refundedAt).toBeNull();
    expect(purchase.manualReviewReason).toBe(MANUAL_REVIEW_REASON);
    expect(await ctx.prisma.packageRefundRequest.count()).toBe(0);
    expect(await ctx.prisma.packageRefundRequestEvent.count()).toBe(0);
  });

  it('a request still under review is not settled, and cannot be approved once the reversal is recorded', async () => {
    const fixture = await paidThroughWebhook();
    const opened = await openRefundTicket(ctx, fixture.cookie, fixture.purchaseId).expect(201);
    const refund = await requestOfTicket(ctx.prisma, opened.body.id);
    const { cookie } = await operator(ctx);
    const admin = adminCall(ctx, cookie);
    await admin.take(refund.id).expect(200);

    await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);

    const current = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: refund.id } });
    expect(current.status).toBe(PackageRefundRequestStatus.UNDER_REVIEW);
    expect(current.settledByWebhookEventId).toBeNull();

    const approval = await admin.approve(refund.id, { kind: 'NORMAL' }).expect(409);
    expect(approval.body.code).toBe('PACKAGE_REFUND_NOT_APPLICABLE');
    expect(approval.body.blockingCodes).toEqual(['PAYMENT_REVERSAL_RECORDED']);

    await admin.reject(refund.id, 'Ödeme sağlayıcısı iadeyi zaten bildirdi.').expect(200);
  });

  it.each([
    ['a subscription refund', { eventName: 'subscription_payment_refunded' }],
    ['a live-mode event', { testMode: false }],
    ['another store', { storeId: 999_999 }],
  ])('%s leaves the approved request waiting', async (_label, overrides) => {
    const fixture = await paidThroughWebhook();
    const { requestId } = await approvedRequest(fixture);

    await deliverLemonWebhook(ctx, refunded(fixture, overrides)).expect(200);

    const current = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(current.status).toBe(PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT);
    expect(await ctx.prisma.packageRefundRequestEvent.count({ where: { action: 'SETTLED' } })).toBe(0);
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } });
    expect(purchase.status).toBe(PackagePurchaseStatus.PAID);
  });

  it('an order_refunded naming a different order leaves the approved request waiting', async () => {
    const fixture = await paidThroughWebhook();
    const { requestId } = await approvedRequest(fixture);

    await deliverLemonWebhook(ctx, refunded({ reference: fixture.reference, orderId: 'order-someone-else' })).expect(200);

    const current = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(current.status).toBe(PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT);
  });

  it('an unsigned delivery is refused before anything is read or written', async () => {
    const fixture = await paidThroughWebhook();
    const { requestId } = await approvedRequest(fixture);

    await deliverLemonWebhook(ctx, refunded(fixture), { secret: 'not-the-secret' }).expect(401);

    const current = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(current.status).toBe(PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT);
    expect(await ctx.prisma.paymentWebhookEvent.count({ where: { eventName: 'order_refunded' } })).toBe(0);
  });

  it('with no webhook, the only way out is a reasoned SETTLEMENT_FAILED, which moves nothing', async () => {
    const fixture = await paidThroughWebhook();
    const { requestId, admin } = await approvedRequest(fixture);
    const ledgerBefore = await ledgerCount(fixture.provider.id);

    await admin.settlementFailed(requestId, 'kısa').expect(400);
    const failed = await admin
      .settlementFailed(requestId, 'Lemon panelinde iade 3 gündür beklemede, webhook gelmedi.')
      .expect(200);
    expect(failed.body.status).toBe('SETTLEMENT_FAILED');

    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } });
    expect(purchase.status).toBe(PackagePurchaseStatus.PAID);
    expect(await ledgerCount(fixture.provider.id)).toBe(ledgerBefore);

    // A late webhook does not resurrect a terminal request.
    await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);
    const current = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(current.status).toBe(PackageRefundRequestStatus.SETTLEMENT_FAILED);
  });
});
