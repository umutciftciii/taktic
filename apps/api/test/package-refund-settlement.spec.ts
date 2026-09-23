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
import { PackageRefundNotificationOutbox } from '../src/modules/notifications/package-refund-notification-outbox.service';
import { vi } from 'vitest';
import { CampaignRevokeService } from '../src/modules/campaigns/engine/campaign-revoke.service';
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
async function paidThroughWebhook(createdOverrides: Record<string, unknown> = {}) {
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
  await deliverLemonWebhook(ctx, lemonOrderPayload({ reference, orderId, ...createdOverrides })).expect(200);
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

  it('with no webhook, the operator can only record a reasoned SETTLEMENT_FAILED, which moves nothing — and a late proven refund still settles it', async () => {
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

    // SETTLEMENT_FAILED is an unfinished reconciliation, not an end: the
    // refund that does arrive later, proven full, settles it — by webhook only.
    await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);
    const current = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(current.status).toBe(PackageRefundRequestStatus.SETTLED);
    expect(current.settlementFailedById).not.toBeNull();
    expect(current.settlementFailureReason).toContain('webhook gelmedi');
    const settledPurchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } });
    expect(settledPurchase.status).toBe(PackagePurchaseStatus.REFUNDED);
    const settledAudit = await ctx.prisma.packageRefundRequestEvent.findFirstOrThrow({
      where: { requestId, action: 'SETTLED' },
    });
    expect(settledAudit.fromStatus).toBe('SETTLEMENT_FAILED');
  });
});

describe('full-refund proof against the provider total stored at payment', () => {
  it('stores the provider total once, from the signed settlement, and nothing can change or read it', async () => {
    const fixture = await paidThroughWebhook();
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } });
    expect(purchase.priceAmountSnapshot).toBe(49900);
    expect(purchase.providerOrderTotalAmount).toBe(49902);
    expect(purchase.providerOrderCurrency).toBe('TRY');

    await expect(
      ctx.prisma.packagePurchase.update({ where: { id: purchase.id }, data: { providerOrderTotalAmount: 49900 } }),
    ).rejects.toThrow(/provider order total is immutable/);
    await expect(
      ctx.prisma.packagePurchase.update({
        where: { id: purchase.id },
        data: { providerOrderTotalAmount: null, providerOrderCurrency: null },
      }),
    ).rejects.toThrow(/provider order total is immutable/);

    // No purchase projection carries it.
    const mine = await request(ctx.server)
      .get(`/providers/${fixture.provider.id}/package-purchases/${purchase.id}`)
      .set('Cookie', fixture.cookie)
      .expect(200);
    expect(mine.body).not.toHaveProperty('providerOrderTotalAmount');
    expect(mine.body).not.toHaveProperty('providerOrderCurrency');
    expect(JSON.stringify(mine.body)).not.toContain('49902');
  });

  it.each([
    ['partial refund', { refunded: false, status: 'partial_refund', refundedAmount: 20000 }, 'NOT_FULLY_REFUNDED'],
    ['refunded flag but partial status', { status: 'partial_refund' }, 'REFUND_STATUS_NOT_FULL'],
    ['full flag, amount one under', { refundedAmount: 49901 }, 'REFUND_AMOUNT_MISMATCH'],
    ['full flag, amount one over', { refundedAmount: 49903 }, 'REFUND_AMOUNT_MISMATCH'],
    ['the TakTic price instead of the provider total', { refundedAmount: 49900 }, 'REFUND_AMOUNT_MISMATCH'],
    ['another currency', { currency: 'USD' }, 'REFUND_CURRENCY_MISMATCH'],
    ['no amount', { refundedAmount: null }, 'REFUND_AMOUNT_MISSING'],
    ['no refunded flag', { refunded: null }, 'NOT_FULLY_REFUNDED'],
  ])('%s → one reasoned SETTLEMENT_FAILED, nothing financial', async (_label, overrides, code) => {
    const fixture = await paidThroughWebhook();
    const { requestId, ticketId } = await approvedRequest(fixture);
    const ledgerBefore = await ledgerCount(fixture.provider.id);

    await deliverLemonWebhook(ctx, refunded(fixture, overrides)).expect(200);
    // A replay of the same event: nothing more.
    await deliverLemonWebhook(ctx, refunded(fixture, overrides)).expect(200);

    const event = await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({ where: { eventName: 'order_refunded' } });
    const failed = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(failed.status).toBe(PackageRefundRequestStatus.SETTLEMENT_FAILED);
    expect(failed.settledByWebhookEventId).toBeNull();
    expect(failed.settlementFailedByWebhookEventId).toBe(event.id);
    expect(failed.settlementFailedById).toBeNull();
    expect(failed.settlementFailureReason).toBe(
      `Dış iade tutarı paketin tamamıyla uyuşmadı; manuel inceleme gerekli. (${code})`,
    );

    const audit = await ctx.prisma.packageRefundRequestEvent.findMany({ where: { requestId, action: 'SETTLEMENT_FAILED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: 'PAYMENT_WEBHOOK', actorId: null, webhookEventId: event.id });

    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } });
    expect(purchase.status).toBe(PackagePurchaseStatus.PAID);
    expect(purchase.refundedAt).toBeNull();
    expect(await ledgerCount(fixture.provider.id)).toBe(ledgerBefore);

    // The provider's ticket shows the outcome, not the code or any figure.
    const ticket = await request(ctx.server).get(`/support/tickets/${ticketId}`).set('Cookie', fixture.cookie).expect(200);
    const failedEntry = ticket.body.timeline.filter(
      (entry: { kind: string; toStatus?: string }) => entry.kind === 'PACKAGE_REFUND_EVENT' && entry.toStatus === 'SETTLEMENT_FAILED',
    );
    expect(failedEntry).toHaveLength(1);
    expect(failedEntry[0].detail).toBe('Dış iade tutarı paketin tamamıyla uyuşmadı; manuel inceleme gerekli.');
    expect(JSON.stringify(ticket.body)).not.toContain(code);

    // The operator's view carries the reason.
    const { cookie } = await operator(ctx);
    const detail = await adminCall(ctx, cookie).detail(requestId).expect(200);
    expect(detail.body.settlementFailureReason).toContain('manuel inceleme gerekli');
    expect(detail.body.events.at(-1)).toMatchObject({ actorKind: 'PAYMENT_WEBHOOK', toStatus: 'SETTLEMENT_FAILED' });
  });

  it('a purchase paid before its provider total was stored can never settle automatically', async () => {
    const fixture = await paidThroughWebhook({ total: null });
    const stored = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } });
    expect(stored.providerOrderTotalAmount).toBeNull();
    expect(stored.providerOrderCurrency).toBeNull();
    const { requestId } = await approvedRequest(fixture);

    await deliverLemonWebhook(ctx, refunded(fixture, { total: 49902, refundedAmount: 49902 })).expect(200);

    const failed = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(failed.status).toBe('SETTLEMENT_FAILED');
    expect(failed.settlementFailureReason).toContain('PROVIDER_TOTAL_MISSING');
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } });
    expect(purchase.status).toBe('PAID');
  });
});

describe('provider status e-mails, through the outbox', () => {
  async function deliver() {
    await ctx.app.get(PackageRefundNotificationOutbox).deliverPending();
  }

  async function intents() {
    return ctx.prisma.notificationLog.findMany({
      where: { template: 'package-refund-status' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { dedupeKey: true, status: true, providerId: true },
    });
  }

  function statusesSent() {
    return ctx.notifications.ofTemplate('package-refund-status').map((message) => message.data?.status);
  }

  it('submitted → under review → approved → settled: one message each, and a replayed webhook adds none', async () => {
    ctx.notifications.clear();
    const fixture = await paidThroughWebhook();
    await approvedRequest(fixture);
    await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);
    await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);
    await deliver();

    const rows = await intents();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(4);
    expect(rows.every((row) => row.status === 'SENT')).toBe(true);
    expect(statusesSent()).toEqual(['SUBMITTED', 'UNDER_REVIEW', 'APPROVED_PENDING_SETTLEMENT', 'SETTLED']);

    // A second sweep sends nothing again.
    await deliver();
    expect(ctx.notifications.ofTemplate('package-refund-status')).toHaveLength(4);

    // Nothing sensitive in any of them.
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } });
    const acceptance = await ctx.prisma.purchaseTermsAcceptance.findUniqueOrThrow({ where: { purchaseId: purchase.id } });
    for (const message of ctx.notifications.ofTemplate('package-refund-status')) {
      const serialised = JSON.stringify(message);
      for (const canary of [
        fixture.reference,
        fixture.orderId,
        acceptance.documentSha256,
        acceptance.id,
        '49902',
        'order_refunded',
      ]) {
        expect(serialised).not.toContain(canary);
      }
      if (acceptance.userAgent) expect(serialised).not.toContain(acceptance.userAgent);
    }
  });

  it('a rejection and an operator-recorded failure each mail once, with a fixed summary rather than the reason', async () => {
    ctx.notifications.clear();
    const first = await paidThroughWebhook();
    const opened = await openRefundTicket(ctx, first.cookie, first.purchaseId).expect(201);
    const refund = await requestOfTicket(ctx.prisma, opened.body.id);
    const { cookie } = await operator(ctx);
    const admin = adminCall(ctx, cookie);
    await admin.take(refund.id).expect(200);
    await admin.reject(refund.id, 'İç not: hizmet verildi, iade yok.').expect(200);

    const second = await paidThroughWebhook();
    const { requestId, admin: secondAdmin } = await approvedRequest(second);
    await secondAdmin.settlementFailed(requestId, 'İç not: Lemon panelinde iade 3 gündür bekliyor.').expect(200);
    await deliver();

    const statuses = statusesSent();
    expect(statuses.filter((status) => status === 'REJECTED')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'SETTLEMENT_FAILED')).toHaveLength(1);
    const serialised = JSON.stringify(ctx.notifications.ofTemplate('package-refund-status'));
    expect(serialised).not.toContain('İç not');
  });

  it('a mismatched webhook mails SETTLEMENT_FAILED once, however often it is replayed', async () => {
    ctx.notifications.clear();
    const fixture = await paidThroughWebhook();
    await approvedRequest(fixture);
    const partial = { refunded: false, status: 'partial_refund', refundedAmount: 10000 };
    await deliverLemonWebhook(ctx, refunded(fixture, partial)).expect(200);
    await deliverLemonWebhook(ctx, refunded(fixture, partial)).expect(200);
    await deliver();

    const failures = ctx.notifications.ofTemplate('package-refund-status').filter((m) => m.data?.status === 'SETTLEMENT_FAILED');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.data?.failureSource).toBe('WEBHOOK');
    expect(JSON.stringify(failures[0])).not.toContain('10000');
  });

  it('a withdrawal mails nothing, and a failed send leaves the transition in place', async () => {
    ctx.notifications.clear();
    const fixture = await paidThroughWebhook();
    const opened = await openRefundTicket(ctx, fixture.cookie, fixture.purchaseId).expect(201);
    await deliver();
    expect(statusesSent()).toEqual(['SUBMITTED']);

    await request(ctx.server)
      .post(`/support/package-refund/tickets/${opened.body.id}/withdraw`)
      .set('Cookie', fixture.cookie)
      .expect(200);
    await deliver();
    expect(statusesSent()).toEqual(['SUBMITTED']);

    // A second request, taken into review while the transport is down. Taking
    // a request mails nothing else, so the failure lands on this notice alone.
    const other = await paidThroughWebhook();
    const second = await openRefundTicket(ctx, other.cookie, other.purchaseId).expect(201);
    await deliver();
    const refund = await requestOfTicket(ctx.prisma, second.body.id);
    const { cookie } = await operator(ctx);
    ctx.notifications.failNextSend = true;
    await adminCall(ctx, cookie).take(refund.id).expect(200);
    await deliver();

    const current = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: refund.id } });
    expect(current.status).toBe('UNDER_REVIEW');
    const reviewEvent = await ctx.prisma.packageRefundRequestEvent.findFirstOrThrow({
      where: { requestId: refund.id, action: 'REVIEW_STARTED' },
    });
    const failedIntent = await ctx.prisma.notificationLog.findFirstOrThrow({
      where: { template: 'package-refund-status', dedupeKey: `package-refund-status:${reviewEvent.id}` },
    });
    expect(failedIntent.status).toBe('FAILED');
  });
});

describe('one order, several refund notices: each refund state is its own event', () => {
  const PARTIAL_1 = { refunded: false, status: 'partial_refund', refundedAmount: 10000 };
  const PARTIAL_2 = { refunded: false, status: 'partial_refund', refundedAmount: 20000 };

  async function deliver() {
    await ctx.app.get(PackageRefundNotificationOutbox).deliverPending();
  }

  async function snapshot(fixture: { purchaseId: string; provider: { id: string } }, requestId: string, ticketId: string, cookie: string) {
    await deliver();
    const [events, refundRow, audit, purchase, ledger, ticket] = await Promise.all([
      ctx.prisma.paymentWebhookEvent.count({ where: { eventName: 'order_refunded' } }),
      ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: requestId } }),
      ctx.prisma.packageRefundRequestEvent.findMany({ where: { requestId, actorKind: 'PAYMENT_WEBHOOK' } }),
      ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } }),
      ctx.prisma.providerCreditTransaction.count({ where: { providerId: fixture.provider.id } }),
      request(ctx.server).get(`/support/tickets/${ticketId}`).set('Cookie', cookie),
    ]);
    const mails = ctx.notifications.ofTemplate('package-refund-status').map((m) => m.data?.status);
    return {
      events,
      status: refundRow.status,
      failedAudits: audit.filter((row) => row.action === 'SETTLEMENT_FAILED').length,
      settledAudits: audit.filter((row) => row.action === 'SETTLED').length,
      ticketFailed: ticket.body.timeline.filter((e: { kind: string; toStatus?: string }) => e.kind === 'PACKAGE_REFUND_EVENT' && e.toStatus === 'SETTLEMENT_FAILED').length,
      ticketSettled: ticket.body.timeline.filter((e: { kind: string; toStatus?: string }) => e.kind === 'PACKAGE_REFUND_EVENT' && e.toStatus === 'SETTLED').length,
      failedMails: mails.filter((status) => status === 'SETTLEMENT_FAILED').length,
      settledMails: mails.filter((status) => status === 'SETTLED').length,
      purchase: purchase.status,
      ledger,
    };
  }

  it('partial → duplicate partial → full → duplicate full', async () => {
    ctx.notifications.clear();
    const revokes = vi.spyOn(ctx.app.get(CampaignRevokeService), 'revokeForRefundedPurchase');
    try {
      const fixture = await paidThroughWebhook();
      const { requestId, ticketId } = await approvedRequest(fixture);
      const ledger = await ledgerCount(fixture.provider.id);
      const look = () => snapshot(fixture, requestId, ticketId, fixture.cookie);

      await deliverLemonWebhook(ctx, refunded(fixture, PARTIAL_1)).expect(200);
      expect(await look()).toEqual({
        events: 1, status: 'SETTLEMENT_FAILED', failedAudits: 1, settledAudits: 0, ticketFailed: 1, ticketSettled: 0,
        failedMails: 1, settledMails: 0, purchase: 'PAID', ledger,
      });
      expect(revokes).not.toHaveBeenCalled();

      const duplicate = await deliverLemonWebhook(ctx, refunded(fixture, PARTIAL_1)).expect(200);
      expect(duplicate.body).toEqual({ status: 'duplicate' });
      expect(await look()).toEqual({
        events: 1, status: 'SETTLEMENT_FAILED', failedAudits: 1, settledAudits: 0, ticketFailed: 1, ticketSettled: 0,
        failedMails: 1, settledMails: 0, purchase: 'PAID', ledger,
      });

      const full = await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);
      expect(full.body).toEqual({ status: 'manual_review_required' });
      expect(await look()).toEqual({
        events: 2, status: 'SETTLED', failedAudits: 1, settledAudits: 1, ticketFailed: 1, ticketSettled: 1,
        failedMails: 1, settledMails: 1, purchase: 'REFUNDED', ledger,
      });
      expect(revokes).toHaveBeenCalledTimes(1);

      const again = await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);
      expect(again.body).toEqual({ status: 'duplicate' });
      expect(await look()).toEqual({
        events: 2, status: 'SETTLED', failedAudits: 1, settledAudits: 1, ticketFailed: 1, ticketSettled: 1,
        failedMails: 1, settledMails: 1, purchase: 'REFUNDED', ledger,
      });
      expect(revokes).toHaveBeenCalledTimes(1);

      const settled = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: requestId } });
      const events = await ctx.prisma.paymentWebhookEvent.findMany({ where: { eventName: 'order_refunded' }, orderBy: { createdAt: 'asc' } });
      expect(settled.settlementFailedByWebhookEventId).toBe(events[0]!.id);
      expect(settled.settledByWebhookEventId).toBe(events[1]!.id);
      // The keys are opaque: no amount, currency or status written out.
      for (const event of events) {
        expect(event.eventKey).toMatch(new RegExp(`^order_refunded:orders:${fixture.orderId}:[0-9a-f]{32}$`));
      }
    } finally {
      revokes.mockRestore();
    }
  });

  it('full → any later notice is a new event with no effect at all', async () => {
    ctx.notifications.clear();
    const revokes = vi.spyOn(ctx.app.get(CampaignRevokeService), 'revokeForRefundedPurchase');
    try {
      const fixture = await paidThroughWebhook();
      const { requestId, ticketId } = await approvedRequest(fixture);
      const ledger = await ledgerCount(fixture.provider.id);
      await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);
      const settled = await snapshot(fixture, requestId, ticketId, fixture.cookie);
      expect(settled).toMatchObject({ status: 'SETTLED', settledAudits: 1, settledMails: 1, purchase: 'REFUNDED', ledger });
      expect(revokes).toHaveBeenCalledTimes(1);

      for (const later of [PARTIAL_1, { currency: 'USD' }, { refundedAmount: 49903 }]) {
        await deliverLemonWebhook(ctx, refunded(fixture, later)).expect(200);
      }
      const after = await snapshot(fixture, requestId, ticketId, fixture.cookie);
      expect(after).toEqual({ ...settled, events: 4 });
      expect(revokes).toHaveBeenCalledTimes(1);
    } finally {
      revokes.mockRestore();
    }
  });

  it('two different partial amounts are two events and one failure; a mismatched "full" keeps it failed; the proven one settles', async () => {
    ctx.notifications.clear();
    const fixture = await paidThroughWebhook();
    const { requestId, ticketId } = await approvedRequest(fixture);
    const ledger = await ledgerCount(fixture.provider.id);
    const look = () => snapshot(fixture, requestId, ticketId, fixture.cookie);

    await deliverLemonWebhook(ctx, refunded(fixture, PARTIAL_1)).expect(200);
    await deliverLemonWebhook(ctx, refunded(fixture, PARTIAL_2)).expect(200);
    expect(await look()).toMatchObject({ events: 2, status: 'SETTLEMENT_FAILED', failedAudits: 1, ticketFailed: 1, failedMails: 1, purchase: 'PAID', ledger });

    for (const almost of [
      { currency: 'USD' },
      { status: 'partial_refund' },
      { refunded: false },
      { refunded: null },
      { refundedAmount: 49903 },
    ]) {
      await deliverLemonWebhook(ctx, refunded(fixture, almost)).expect(200);
    }
    expect(await look()).toMatchObject({
      events: 7, status: 'SETTLEMENT_FAILED', failedAudits: 1, settledAudits: 0, ticketFailed: 1, failedMails: 1, settledMails: 0, purchase: 'PAID', ledger,
    });

    await deliverLemonWebhook(ctx, refunded(fixture)).expect(200);
    expect(await look()).toMatchObject({
      events: 8, status: 'SETTLED', failedAudits: 1, settledAudits: 1, ticketSettled: 1, failedMails: 1, settledMails: 1, purchase: 'REFUNDED', ledger,
    });
  });

  it('the operator still cannot write SETTLED, nor move a failed request anywhere', async () => {
    const fixture = await paidThroughWebhook();
    const { requestId, admin } = await approvedRequest(fixture);
    await deliverLemonWebhook(ctx, refunded(fixture, PARTIAL_1)).expect(200);

    expect((await admin.settlementFailed(requestId, 'İkinci kez başarısız kaydı.').expect(409)).body.code).toBe(
      'PACKAGE_REFUND_INVALID_TRANSITION',
    );
    await admin.reject(requestId, 'Başarısız isteği reddetme denemesi.').expect(409);
    await admin.approve(requestId, { kind: 'NORMAL' }).expect(409);
    await expect(
      ctx.prisma.packageRefundRequest.update({ where: { id: requestId }, data: { status: 'REJECTED' } }),
    ).rejects.toThrow(/may only become SETTLED/);
    await expect(
      ctx.prisma.packageRefundRequest.update({ where: { id: requestId }, data: { status: 'SETTLED', settledAt: new Date() } }),
    ).rejects.toThrow(/settled_by_webhook/);
    // And the provider cannot open a second request while the first awaits reconciliation.
    await openRefundTicket(ctx, fixture.cookie, fixture.purchaseId).expect(409);
  });
});
