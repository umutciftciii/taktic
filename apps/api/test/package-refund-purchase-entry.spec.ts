import { PackagePurchaseStatus, PackageRefundRequestStatus, SupportTicketTopic, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PACKAGE_REFUND_WINDOW_MS } from '../src/modules/package-refunds/package-refund-eligibility';
import { PURCHASE_TERMS_TEST_DOCUMENT_SET } from '../src/modules/purchase-terms/purchase-terms.test-documents';
import { createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';
import {
  consumeLinkedPromo,
  gateSwitch,
  offerSpend,
  openRefundTicket,
  paidPurchase,
  providerAccount,
  requestOfTicket,
} from './package-refund-fixtures';

/**
 * CMP-006 PR-B.1 — the refund request reached from the purchase itself, and
 * the flow on the TEST document set.
 *
 *   1. `GET /support/package-refund/purchases/:id/availability` — the answer
 *      behind the "İade talebi oluştur" button — is the canonical evaluation
 *      plus ownership, evidence and "no open request", and one bare boolean
 *      that is the same `false` for everything that is not the caller's own
 *      requestable purchase.
 *   2. The gate matrix: off / invalid closed, `on` and `test` open; `test`
 *      says so to the form.
 *   3. On `test`, a purchase bought under the TEST set enters the same atomic
 *      ticket + request path, and a spoofed purchase id writes nothing.
 */

let ctx: TestContext;
const gate = gateSwitch();

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  gate.remember();
  gate.openTest();
});

afterEach(() => {
  gate.restore();
});

async function providerWithPurchase(options: { paidAt?: Date; status?: PackagePurchaseStatus } = {}) {
  const account = await providerAccount(ctx);
  const purchase = await paidPurchase(ctx.prisma, {
    providerId: account.provider.id,
    userId: account.owner.id,
    terms: PURCHASE_TERMS_TEST_DOCUMENT_SET,
    ...options,
  });
  return { ...account, purchase };
}

function availability(cookie: string, purchaseId: string) {
  return request(ctx.server)
    .get(`/support/package-refund/purchases/${encodeURIComponent(purchaseId)}/availability`)
    .set('Cookie', cookie);
}

function options(cookie: string) {
  return request(ctx.server).get('/support/package-refund/options').set('Cookie', cookie);
}

async function counts() {
  const [tickets, messages, requests, events, ledger] = await Promise.all([
    ctx.prisma.supportTicket.count(),
    ctx.prisma.supportTicketMessage.count(),
    ctx.prisma.packageRefundRequest.count(),
    ctx.prisma.packageRefundRequestEvent.count(),
    ctx.prisma.providerCreditTransaction.count(),
  ]);
  return { tickets, messages, requests, events, ledger };
}

describe('the purchase page’s answer: availability', () => {
  it('is true for the caller’s own new purchase bought under the TEST set', async () => {
    const fixture = await providerWithPurchase();
    const response = await availability(fixture.cookie, fixture.purchase.id).expect(200);
    expect(response.body).toEqual({ available: true });
  });

  it('is the same bare false for another provider’s purchase and for an invented id', async () => {
    const mine = await providerAccount(ctx);
    const theirs = await providerWithPurchase();

    const foreign = await availability(mine.cookie, theirs.purchase.id).expect(200);
    const invented = await availability(mine.cookie, 'pp-does-not-exist').expect(200);
    expect(foreign.body).toEqual({ available: false });
    expect(invented.body).toEqual(foreign.body);
    // The owner still gets true: the refusal above was about the caller.
    expect((await availability(theirs.cookie, theirs.purchase.id)).body).toEqual({ available: true });
  });

  it('is false for a purchase from before the gate (no terms evidence)', async () => {
    const account = await providerAccount(ctx);
    const legacy = await paidPurchase(ctx.prisma, {
      providerId: account.provider.id,
      userId: account.owner.id,
      evidence: false,
    });
    expect((await availability(account.cookie, legacy.id).expect(200)).body).toEqual({ available: false });
  });

  it('follows the 14-day window to the edge', async () => {
    const inside = await providerWithPurchase({ paidAt: new Date(Date.now() - PACKAGE_REFUND_WINDOW_MS + 60_000) });
    const outside = await providerWithPurchase({ paidAt: new Date(Date.now() - PACKAGE_REFUND_WINDOW_MS - 1000) });
    expect((await availability(inside.cookie, inside.purchase.id)).body).toEqual({ available: true });
    expect((await availability(outside.cookie, outside.purchase.id)).body).toEqual({ available: false });
  });

  it('is false once any offer credit was spent after payment', async () => {
    const fixture = await providerWithPurchase();
    await offerSpend(ctx.prisma, fixture.provider.id);
    expect((await availability(fixture.cookie, fixture.purchase.id)).body).toEqual({ available: false });
  });

  it('is false once a promo credit linked to the purchase was consumed', async () => {
    const fixture = await providerWithPurchase();
    await consumeLinkedPromo(ctx.prisma, fixture.provider.id, fixture.purchase.id);
    expect((await availability(fixture.cookie, fixture.purchase.id)).body).toEqual({ available: false });
  });

  it('is false while a request is open, and true again after it is withdrawn', async () => {
    const fixture = await providerWithPurchase();
    const opened = await openRefundTicket(ctx, fixture.cookie, fixture.purchase.id).expect(201);
    expect((await availability(fixture.cookie, fixture.purchase.id)).body).toEqual({ available: false });

    await request(ctx.server)
      .post(`/support/package-refund/tickets/${opened.body.id}/withdraw`)
      .set('Cookie', fixture.cookie)
      .expect(200);
    expect((await availability(fixture.cookie, fixture.purchase.id)).body).toEqual({ available: true });
  });

  it('is false for a purchase that is not PAID', async () => {
    const fixture = await providerWithPurchase({ status: PackagePurchaseStatus.REFUNDED });
    expect((await availability(fixture.cookie, fixture.purchase.id)).body).toEqual({ available: false });
  });

  it('a customer is refused, and an anonymous caller is asked to sign in', async () => {
    const owner = await providerWithPurchase();
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await availability(await loginAs(ctx.prisma, customer.id), owner.purchase.id).expect(403);
    await request(ctx.server)
      .get(`/support/package-refund/purchases/${owner.purchase.id}/availability`)
      .expect(401);
  });
});

describe('the gate matrix', () => {
  it.each([
    ['unset', () => gate.close()],
    ['off', () => { process.env.PURCHASE_TERMS_GATE = 'off'; }],
    ['an unknown value', () => { process.env.PURCHASE_TERMS_GATE = 'maybe'; }],
  ])('%s: no button, no refund type, no request — and nothing written', async (_label, setGate) => {
    const fixture = await providerWithPurchase();
    setGate();
    const before = await counts();

    expect((await availability(fixture.cookie, fixture.purchase.id).expect(200)).body).toEqual({ available: false });
    expect((await options(fixture.cookie).expect(200)).body).toEqual({ available: false, testMode: false, purchases: [] });
    const refused = await openRefundTicket(ctx, fixture.cookie, fixture.purchase.id).expect(403);
    expect(refused.body.code).toBe('PACKAGE_REFUND_UNAVAILABLE');
    expect(await counts()).toEqual(before);
  });

  it('on: open, not marked as test', async () => {
    const fixture = await providerWithPurchase();
    gate.open();
    expect((await availability(fixture.cookie, fixture.purchase.id)).body).toEqual({ available: true });
    const body = (await options(fixture.cookie).expect(200)).body;
    expect(body).toMatchObject({ available: true, testMode: false });
  });

  it('test: open, and the form is told it is a test environment', async () => {
    const fixture = await providerWithPurchase();
    const body = (await options(fixture.cookie).expect(200)).body;
    expect(body).toMatchObject({ available: true, testMode: true });
    expect(body.purchases.map((p: { id: string }) => p.id)).toEqual([fixture.purchase.id]);
  });
});

describe('on the TEST set: the same atomic ticket + request path', () => {
  it('opens ticket, message, SUBMITTED request and audit row together, with the server’s subject', async () => {
    const fixture = await providerWithPurchase();
    const offered = (await options(fixture.cookie).expect(200)).body.purchases[0];
    const before = await counts();

    const response = await openRefundTicket(ctx, fixture.cookie, fixture.purchase.id).expect(201);
    expect(response.body).toMatchObject({
      topic: SupportTicketTopic.PACKAGE_AND_CREDIT_REFUND,
      subject: offered.ticketSubject,
    });

    const refund = await requestOfTicket(ctx.prisma, response.body.id);
    expect(refund).toMatchObject({
      status: PackageRefundRequestStatus.SUBMITTED,
      purchaseId: fixture.purchase.id,
      providerId: fixture.provider.id,
      submittedRecommendation: 'REFUNDABLE',
    });
    expect(await counts()).toEqual({
      ...before,
      tickets: before.tickets + 1,
      messages: before.messages + 1,
      requests: before.requests + 1,
      events: before.events + 1,
    });

    const acceptance = await ctx.prisma.purchaseTermsAcceptance.findUniqueOrThrow({
      where: { purchaseId: fixture.purchase.id },
    });
    expect(acceptance.documentVersion).toBe(PURCHASE_TERMS_TEST_DOCUMENT_SET.version);
  });

  it('a subject sent by the caller is ignored: the server writes its own', async () => {
    const fixture = await providerWithPurchase();
    const offered = (await options(fixture.cookie).expect(200)).body.purchases[0];
    const response = await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', fixture.cookie)
      .send({
        topic: 'PACKAGE_AND_CREDIT_REFUND',
        packagePurchaseId: fixture.purchase.id,
        subject: 'Serbest konu',
        message: 'İade rica ediyorum.',
      })
      .expect(201);
    expect(response.body.subject).toBe(offered.ticketSubject);
    const ticket = await ctx.prisma.supportTicket.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(ticket.subject).toBe(offered.ticketSubject);
  });

  it('a spoofed purchase id — another provider’s — writes nothing and says nothing about it', async () => {
    const mine = await providerAccount(ctx);
    const theirs = await providerWithPurchase();
    const before = await counts();

    const refused = await openRefundTicket(ctx, mine.cookie, theirs.purchase.id).expect(404);
    const invented = await openRefundTicket(ctx, mine.cookie, 'pp-does-not-exist').expect(404);
    expect(refused.body).toEqual(invented.body);
    expect(JSON.stringify(refused.body)).not.toContain(theirs.purchase.packageNameSnapshot);
    expect(await counts()).toEqual(before);
  });
});
