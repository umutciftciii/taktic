import {
  AdminPermission,
  OfferPackageType,
  PackagePurchaseStatus,
  PackageRefundRequestStatus,
  SupportTicketTopic,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PACKAGE_REFUND_WINDOW_MS } from '../src/modules/package-refunds/package-refund-eligibility';
import {
  createAdminWithPermissions,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';
import {
  adminCall,
  ALL_REFUND_PERMISSIONS,
  consumeLinkedPromo,
  gateSwitch,
  offerSpend,
  openRefundTicket,
  operator,
  paidPurchase,
  providerAccount,
  requestOfTicket,
} from './package-refund-fixtures';

/**
 * CMP-006 PR-B — the package refund request, from the support form to the
 * operator's decision.
 *
 *   1. The provider opens a refund ticket for their own PAID purchase; ticket,
 *      message, request and audit row are one transaction, and nothing about
 *      money or credit moves.
 *   2. Gate closed, evidence missing, another provider's purchase, a customer:
 *      fail-closed, with nothing written.
 *   3. The 14-day, credit-spend and linked-promo rules at submission and again
 *      at approval.
 *   4. The state machine: take, normal/exception approval with maker-checker,
 *      reject, withdraw, failed settlement — each audited, each on the
 *      ticket's timeline.
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
  gate.open();
});

afterEach(() => {
  gate.restore();
});

async function providerWithPurchase(options: { paidAt?: Date; type?: OfferPackageType } = {}) {
  const account = await providerAccount(ctx);
  const purchase = await paidPurchase(ctx.prisma, {
    providerId: account.provider.id,
    userId: account.owner.id,
    ...options,
  });
  return { ...account, purchase };
}

async function submitted() {
  const fixture = await providerWithPurchase();
  const opened = await openRefundTicket(ctx, fixture.cookie, fixture.purchase.id).expect(201);
  const refund = await requestOfTicket(ctx.prisma, opened.body.id);
  return { ...fixture, ticketId: opened.body.id as string, refund };
}

async function counts() {
  const [tickets, requests, events, ledger] = await Promise.all([
    ctx.prisma.supportTicket.count(),
    ctx.prisma.packageRefundRequest.count(),
    ctx.prisma.packageRefundRequestEvent.count(),
    ctx.prisma.providerCreditTransaction.count(),
  ]);
  return { tickets, requests, events, ledger };
}

describe('provider: opening a refund ticket', () => {
  it('lists only the caller’s own PAID purchases that carry evidence', async () => {
    const mine = await providerWithPurchase();
    await paidPurchase(ctx.prisma, { providerId: mine.provider.id, userId: mine.owner.id, evidence: false });
    await providerWithPurchase(); // somebody else's

    const response = await request(ctx.server)
      .get('/support/package-refund/options')
      .set('Cookie', mine.cookie)
      .expect(200);

    expect(response.body.available).toBe(true);
    expect(response.body.purchases.map((p: { id: string }) => p.id)).toEqual([mine.purchase.id]);
    expect(response.body.purchases[0]).toMatchObject({ selectable: true, packageName: mine.purchase.packageNameSnapshot });
    expect(Object.keys(response.body.purchases[0]).sort()).toEqual(
      ['creditAmount', 'currency', 'id', 'notes', 'packageName', 'paidAt', 'priceAmount', 'purchaseNumber', 'selectable', 'windowEndsAt'].sort(),
    );
  });

  it('writes the ticket, its message, the SUBMITTED request and one audit row together — and moves no money', async () => {
    const fixture = await providerWithPurchase();
    const before = await counts();

    const response = await openRefundTicket(ctx, fixture.cookie, fixture.purchase.id).expect(201);
    expect(response.body.topic).toBe(SupportTicketTopic.PACKAGE_AND_CREDIT_REFUND);
    expect(response.body.subject).toContain(fixture.purchase.packageNameSnapshot);

    const refund = await requestOfTicket(ctx.prisma, response.body.id);
    expect(refund).toMatchObject({
      status: PackageRefundRequestStatus.SUBMITTED,
      origin: 'PROVIDER',
      purchaseId: fixture.purchase.id,
      providerId: fixture.provider.id,
      createdById: fixture.owner.id,
      submittedRecommendation: 'REFUNDABLE',
      creditClawbackCredits: 0,
    });
    expect((refund.submittedEligibility as { recommendation: string }).recommendation).toBe('REFUNDABLE');

    const after = await counts();
    expect(after).toEqual({ ...before, tickets: before.tickets + 1, requests: 1, events: 1 });
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: fixture.purchase.id } });
    expect(purchase.status).toBe(PackagePurchaseStatus.PAID);

    const ticket = await request(ctx.server)
      .get(`/support/tickets/${response.body.id}`)
      .set('Cookie', fixture.cookie)
      .expect(200);
    expect(ticket.body.packageRefundRequest).toMatchObject({ status: 'SUBMITTED', canWithdraw: true });
    const kinds = ticket.body.timeline.map((entry: { kind: string }) => entry.kind);
    expect(kinds).toEqual(['MESSAGE', 'PACKAGE_REFUND_EVENT']);
  });

  it('another provider’s purchase is the same 404 as an invented one, and nothing is written', async () => {
    const mine = await providerAccount(ctx);
    const theirs = await providerWithPurchase();
    const before = await counts();

    await openRefundTicket(ctx, mine.cookie, theirs.purchase.id).expect(404);
    await openRefundTicket(ctx, mine.cookie, 'pp-does-not-exist').expect(404);
    expect(await counts()).toEqual(before);
  });

  it('a purchase from before the gate (no evidence) is refused; the general topic stays open', async () => {
    const account = await providerAccount(ctx);
    const legacy = await paidPurchase(ctx.prisma, { providerId: account.provider.id, userId: account.owner.id, evidence: false });

    const refused = await openRefundTicket(ctx, account.cookie, legacy.id).expect(403);
    expect(refused.body.code).toBe('PACKAGE_REFUND_UNAVAILABLE');
    expect(await ctx.prisma.supportTicket.count()).toBe(0);

    await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', account.cookie)
      .send({ subject: 'Eski paketim hakkında', message: 'Eski paketimi iade ettirebilir miyim?' })
      .expect(201);
  });

  it('one open request per purchase', async () => {
    const fixture = await providerWithPurchase();
    await openRefundTicket(ctx, fixture.cookie, fixture.purchase.id).expect(201);
    const second = await openRefundTicket(ctx, fixture.cookie, fixture.purchase.id).expect(409);
    expect(second.body.code).toBe('PACKAGE_REFUND_REQUEST_ALREADY_OPEN');
    expect(await ctx.prisma.supportTicket.count()).toBe(1);

    const options = await request(ctx.server).get('/support/package-refund/options').set('Cookie', fixture.cookie);
    expect(options.body.purchases[0].selectable).toBe(false);
  });

  it('two simultaneous submissions for one purchase open exactly one request', async () => {
    const fixture = await providerWithPurchase();
    const responses = await Promise.all([
      openRefundTicket(ctx, fixture.cookie, fixture.purchase.id),
      openRefundTicket(ctx, fixture.cookie, fixture.purchase.id),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await ctx.prisma.packageRefundRequest.count()).toBe(1);
    expect(await ctx.prisma.supportTicket.count()).toBe(1);
  });

  it('the 14-day window is checked at submission', async () => {
    const inside = await providerWithPurchase({ paidAt: new Date(Date.now() - PACKAGE_REFUND_WINDOW_MS + 60_000) });
    await openRefundTicket(ctx, inside.cookie, inside.purchase.id).expect(201);

    const outside = await providerWithPurchase({ paidAt: new Date(Date.now() - PACKAGE_REFUND_WINDOW_MS - 1000) });
    const refused = await openRefundTicket(ctx, outside.cookie, outside.purchase.id).expect(409);
    expect(refused.body).toMatchObject({ code: 'PACKAGE_REFUND_NOT_ELIGIBLE', blockingCodes: ['REFUND_WINDOW_EXPIRED'] });
  });

  it('any offer credit spent after payment blocks submission, and the picker says why', async () => {
    const fixture = await providerWithPurchase();
    await offerSpend(ctx.prisma, fixture.provider.id);

    const refused = await openRefundTicket(ctx, fixture.cookie, fixture.purchase.id).expect(409);
    expect(refused.body.blockingCodes).toEqual(['CREDIT_SPENT_SINCE_PAYMENT']);

    const options = await request(ctx.server).get('/support/package-refund/options').set('Cookie', fixture.cookie);
    expect(options.body.purchases[0].selectable).toBe(false);
    expect(options.body.purchases[0].notes).toEqual(['Ödemeden sonra hesabınızda teklif kredisi kullanıldı.']);
  });

  it('a consumed promo credit linked to the purchase blocks submission', async () => {
    const fixture = await providerWithPurchase();
    await consumeLinkedPromo(ctx.prisma, fixture.provider.id, fixture.purchase.id);

    const refused = await openRefundTicket(ctx, fixture.cookie, fixture.purchase.id).expect(409);
    expect(refused.body.blockingCodes).toContain('LINKED_PROMO_CONSUMED');
  });

  it('a periodic package is outside the normal policy and cannot be submitted by the provider', async () => {
    const fixture = await providerWithPurchase({ type: OfferPackageType.MONTHLY_QUOTA });
    const refused = await openRefundTicket(ctx, fixture.cookie, fixture.purchase.id).expect(409);
    expect(refused.body.blockingCodes).toEqual(['PACKAGE_TYPE_NOT_COVERED']);
  });

  it('refuses a package on a general ticket, and a refund ticket with no package', async () => {
    const fixture = await providerWithPurchase();
    await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', fixture.cookie)
      .send({ subject: 'Genel', message: 'Merhaba', packagePurchaseId: fixture.purchase.id })
      .expect(400);
    await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', fixture.cookie)
      .send({ topic: 'PACKAGE_AND_CREDIT_REFUND', message: 'Merhaba' })
      .expect(400);
    expect(await ctx.prisma.supportTicket.count()).toBe(0);
  });
});

describe('fail-closed: gate closed or invalid, customer', () => {
  it.each([
    ['closed', () => gate.close()],
    ['set to a value it does not accept', () => { process.env.PURCHASE_TERMS_GATE = 'maybe'; }],
  ])('gate %s: no topic offered, submission refused, nothing written', async (_label, setGate) => {
    const fixture = await providerWithPurchase();
    setGate();

    const options = await request(ctx.server).get('/support/package-refund/options').set('Cookie', fixture.cookie).expect(200);
    expect(options.body).toEqual({ available: false, purchases: [] });

    const refused = await openRefundTicket(ctx, fixture.cookie, fixture.purchase.id).expect(403);
    expect(refused.body.code).toBe('PACKAGE_REFUND_UNAVAILABLE');
    expect(await ctx.prisma.supportTicket.count()).toBe(0);
    expect(await ctx.prisma.packageRefundRequest.count()).toBe(0);
  });

  it('a customer can neither see options nor open a refund ticket', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await loginAs(ctx.prisma, customer.id);
    const provider = await providerWithPurchase();

    await request(ctx.server).get('/support/package-refund/options').set('Cookie', cookie).expect(403);
    const refused = await openRefundTicket(ctx, cookie, provider.purchase.id).expect(403);
    expect(refused.body.code).toBe('PACKAGE_REFUND_UNAVAILABLE');
    expect(await ctx.prisma.supportTicket.count()).toBe(0);
  });

  it('closing the gate later halts take and approval, but not reject or withdraw', async () => {
    const first = await submitted();
    const second = await submitted();
    const { cookie } = await operator(ctx);
    const admin = adminCall(ctx, cookie);
    await admin.take(second.refund.id).expect(200);

    gate.close();
    expect((await admin.take(first.refund.id).expect(409)).body.code).toBe('PACKAGE_REFUND_UNAVAILABLE');
    expect((await admin.approve(second.refund.id, { kind: 'NORMAL' }).expect(409)).body.code).toBe(
      'PACKAGE_REFUND_UNAVAILABLE',
    );
    await admin.reject(second.refund.id, 'Kapı kapalıyken değerlendirilemez.').expect(200);
    await request(ctx.server)
      .post(`/support/package-refund/tickets/${first.ticketId}/withdraw`)
      .set('Cookie', first.cookie)
      .expect(200);
  });
});

describe('operator: the state machine', () => {
  it('take → normal approval, with the eligibility recomputed and stored, every step audited', async () => {
    const { refund, ticketId } = await submitted();
    const { admin: staff, cookie } = await operator(ctx, [...ALL_REFUND_PERMISSIONS, AdminPermission.SUPPORT_READ]);
    const admin = adminCall(ctx, cookie);

    const taken = await admin.take(refund.id).expect(200);
    expect(taken.body).toMatchObject({ status: 'UNDER_REVIEW', reviewStartedBy: { id: staff.id } });

    const approved = await admin.approve(refund.id, { kind: 'NORMAL' }).expect(200);
    expect(approved.body).toMatchObject({
      status: 'APPROVED_PENDING_SETTLEMENT',
      approvalKind: 'NORMAL',
      exceptionGround: null,
      approvedBy: { id: staff.id },
    });
    expect(approved.body.approvalEligibility.recommendation).toBe('REFUNDABLE');
    // Nothing on the admin side can settle it.
    expect(approved.body.allowedActions).toEqual({
      take: false,
      approveNormal: false,
      approveException: false,
      reject: false,
      markSettlementFailed: true,
    });

    const audit = await ctx.prisma.packageRefundRequestEvent.findMany({
      where: { requestId: refund.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(audit.map((row) => [row.action, row.fromStatus, row.toStatus, row.actorKind])).toEqual([
      ['SUBMITTED', null, 'SUBMITTED', 'PROVIDER'],
      ['REVIEW_STARTED', 'SUBMITTED', 'UNDER_REVIEW', 'ADMIN'],
      ['APPROVED', 'UNDER_REVIEW', 'APPROVED_PENDING_SETTLEMENT', 'ADMIN'],
    ]);

    // The admin's ticket screen shows the same trail, with actors.
    const adminTicket = await request(ctx.server)
      .get(`/admin/support/tickets/${ticketId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(adminTicket.body.packageRefund.request).toEqual({ id: refund.id, status: 'APPROVED_PENDING_SETTLEMENT' });
    const refundEntries = adminTicket.body.timeline.filter((entry: { kind: string }) => entry.kind === 'PACKAGE_REFUND_EVENT');
    expect(refundEntries).toHaveLength(3);
    expect(refundEntries[2].actor).toEqual({ id: staff.id, name: staff.name });
  });

  it('approval recomputes: a spend after submission turns a normal approval into a 409', async () => {
    const { refund, provider } = await submitted();
    const { cookie } = await operator(ctx);
    const admin = adminCall(ctx, cookie);
    await admin.take(refund.id).expect(200);

    await offerSpend(ctx.prisma, provider.id);

    const refused = await admin.approve(refund.id, { kind: 'NORMAL' }).expect(409);
    expect(refused.body).toMatchObject({
      code: 'PACKAGE_REFUND_NOT_NORMALLY_ELIGIBLE',
      blockingCodes: ['CREDIT_SPENT_SINCE_PAYMENT'],
    });
    const current = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: refund.id } });
    expect(current.status).toBe('UNDER_REVIEW');
  });

  it('an exception needs a closed-set ground, a reason, and a second operator', async () => {
    const { refund, provider } = await submitted();
    const maker = await operator(ctx);
    const checker = await operator(ctx);
    const makerCalls = adminCall(ctx, maker.cookie);
    const checkerCalls = adminCall(ctx, checker.cookie);
    await makerCalls.take(refund.id).expect(200);
    await offerSpend(ctx.prisma, provider.id);

    // The maker's own screen says why the button is not there.
    const makerView = await makerCalls.detail(refund.id).expect(200);
    expect(makerView.body.allowedActions.approveException).toBe(false);
    expect(makerView.body.exceptionBlockedByMakerChecker).toBe(true);

    const selfApproval = await makerCalls
      .approve(refund.id, { kind: 'EXCEPTION', exceptionGround: 'PLATFORM_SERVICE_FAULT', exceptionReason: 'Teklif ekranı hatası nedeniyle harcandı.' })
      .expect(409);
    expect(selfApproval.body.code).toBe('PACKAGE_REFUND_MAKER_CHECKER');

    await checkerCalls.approve(refund.id, { kind: 'EXCEPTION', exceptionGround: 'PLATFORM_SERVICE_FAULT' }).expect(400);
    await checkerCalls
      .approve(refund.id, { kind: 'EXCEPTION', exceptionGround: 'NOT_A_GROUND', exceptionReason: 'Geçerli uzunlukta gerekçe.' })
      .expect(400);
    await checkerCalls.approve(refund.id, { kind: 'EXCEPTION', exceptionGround: 'PLATFORM_SERVICE_FAULT', exceptionReason: 'kısa' }).expect(400);

    const approved = await checkerCalls
      .approve(refund.id, {
        kind: 'EXCEPTION',
        exceptionGround: 'PLATFORM_SERVICE_FAULT',
        exceptionReason: 'Teklif ekranı hatası nedeniyle harcandı.',
      })
      .expect(200);
    expect(approved.body).toMatchObject({
      status: 'APPROVED_PENDING_SETTLEMENT',
      approvalKind: 'EXCEPTION',
      exceptionGround: 'PLATFORM_SERVICE_FAULT',
      exceptionReason: 'Teklif ekranı hatası nedeniyle harcandı.',
      approvedBy: { id: checker.admin.id },
    });
    const audit = await ctx.prisma.packageRefundRequestEvent.findFirstOrThrow({
      where: { requestId: refund.id, action: 'APPROVED' },
    });
    expect(audit.note).toBe('Teklif ekranı hatası nedeniyle harcandı.');
  });

  it('an operator-opened exception: neither the opener nor the reviewer may approve it', async () => {
    const account = await providerAccount(ctx);
    const purchase = await paidPurchase(ctx.prisma, { providerId: account.provider.id, userId: account.owner.id });
    await offerSpend(ctx.prisma, account.provider.id);
    const ticket = await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', account.cookie)
      .send({ subject: 'Çift çekim', message: 'Kartımdan iki kez çekildi.' })
      .expect(201);

    const opener = await operator(ctx);
    const reviewer = await operator(ctx);
    const approver = await operator(ctx);

    const created = await adminCall(ctx, opener.cookie)
      .create({ supportTicketId: ticket.body.id, purchaseId: purchase.id })
      .expect(201);
    expect(created.body).toMatchObject({ status: 'SUBMITTED', origin: 'ADMIN', submittedRecommendation: 'EXCEPTION_ONLY' });

    await adminCall(ctx, reviewer.cookie).take(created.body.id).expect(200);
    const body = { kind: 'EXCEPTION', exceptionGround: 'DUPLICATE_CHARGE', exceptionReason: 'İkinci sipariş aynı tutarda çekilmiş.' };
    expect((await adminCall(ctx, opener.cookie).approve(created.body.id, body).expect(409)).body.code).toBe(
      'PACKAGE_REFUND_MAKER_CHECKER',
    );
    expect((await adminCall(ctx, reviewer.cookie).approve(created.body.id, body).expect(409)).body.code).toBe(
      'PACKAGE_REFUND_MAKER_CHECKER',
    );
    await adminCall(ctx, approver.cookie).approve(created.body.id, body).expect(200);

    // The provider's own ticket now carries the request.
    const mine = await request(ctx.server).get(`/support/tickets/${ticket.body.id}`).set('Cookie', account.cookie);
    expect(mine.body.packageRefundRequest.status).toBe('APPROVED_PENDING_SETTLEMENT');
  });

  it('one role may hold all three permissions; the row-level rule still separates maker and checker', async () => {
    const { refund, provider } = await submitted();
    const { admin: one, role } = await createAdminWithPermissions(ctx.prisma, ALL_REFUND_PERMISSIONS);
    const cookie = await loginAs(ctx.prisma, one.id);
    const admin = adminCall(ctx, cookie);
    expect(await ctx.prisma.adminRolePermission.count({ where: { roleId: role.id } })).toBe(3);

    await admin.take(refund.id).expect(200);
    await offerSpend(ctx.prisma, provider.id);
    await admin
      .approve(refund.id, { kind: 'EXCEPTION', exceptionGround: 'STATUTORY_RIGHT', exceptionReason: 'Kanuni cayma hakkı kullanıldı.' })
      .expect(409);
  });

  it('an exception where the normal rule already holds is refused; a normal approval carries no ground', async () => {
    const { refund } = await submitted();
    const maker = await operator(ctx);
    const checker = await operator(ctx);
    await adminCall(ctx, maker.cookie).take(refund.id).expect(200);

    const refused = await adminCall(ctx, checker.cookie)
      .approve(refund.id, { kind: 'EXCEPTION', exceptionGround: 'STATUTORY_RIGHT', exceptionReason: 'Gerekçe metni burada.' })
      .expect(409);
    expect(refused.body.code).toBe('PACKAGE_REFUND_EXCEPTION_NOT_NEEDED');
    await adminCall(ctx, checker.cookie)
      .approve(refund.id, { kind: 'NORMAL', exceptionGround: 'STATUTORY_RIGHT' })
      .expect(400);
  });

  it('reject needs a reason; a rejected request is terminal for everybody', async () => {
    const { refund, ticketId, cookie: providerCookie } = await submitted();
    const { cookie } = await operator(ctx);
    const admin = adminCall(ctx, cookie);

    expect((await admin.reject(refund.id, 'Gerekçe yok').expect(409)).body.code).toBe('PACKAGE_REFUND_INVALID_TRANSITION');
    await admin.take(refund.id).expect(200);
    await admin.reject(refund.id, 'kısa').expect(400);
    const rejected = await admin.reject(refund.id, 'Satın alma kullanıcı hatası değil, hizmet verildi.').expect(200);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'Satın alma kullanıcı hatası değil, hizmet verildi.' });

    await admin.approve(refund.id, { kind: 'NORMAL' }).expect(409);
    await request(ctx.server)
      .post(`/support/package-refund/tickets/${ticketId}/withdraw`)
      .set('Cookie', providerCookie)
      .expect(409);

    // The provider sees the outcome, never the operator's reason.
    const ticket = await request(ctx.server).get(`/support/tickets/${ticketId}`).set('Cookie', providerCookie);
    expect(ticket.body.packageRefundRequest.status).toBe('REJECTED');
    expect(JSON.stringify(ticket.body)).not.toContain('hizmet verildi');
  });

  it('the provider may withdraw before approval and not after', async () => {
    const early = await submitted();
    const withdrawn = await request(ctx.server)
      .post(`/support/package-refund/tickets/${early.ticketId}/withdraw`)
      .set('Cookie', early.cookie)
      .expect(200);
    expect(withdrawn.body).toMatchObject({ status: 'WITHDRAWN', canWithdraw: false });
    // A new request may be opened afterwards.
    await openRefundTicket(ctx, early.cookie, early.purchase.id).expect(201);

    const reviewed = await submitted();
    const { cookie } = await operator(ctx);
    await adminCall(ctx, cookie).take(reviewed.refund.id).expect(200);
    await request(ctx.server)
      .post(`/support/package-refund/tickets/${reviewed.ticketId}/withdraw`)
      .set('Cookie', reviewed.cookie)
      .expect(200);

    const late = await submitted();
    await adminCall(ctx, cookie).take(late.refund.id).expect(200);
    await adminCall(ctx, cookie).approve(late.refund.id, { kind: 'NORMAL' }).expect(200);
    const refused = await request(ctx.server)
      .post(`/support/package-refund/tickets/${late.ticketId}/withdraw`)
      .set('Cookie', late.cookie)
      .expect(409);
    expect(refused.body.code).toBe('PACKAGE_REFUND_INVALID_TRANSITION');
  });

  it('there is no route that writes SETTLED, and no field that smuggles a status', async () => {
    const { refund } = await submitted();
    const { cookie } = await operator(ctx);
    const admin = adminCall(ctx, cookie);
    await admin.take(refund.id).expect(200);

    for (const path of ['settle', 'settled', 'complete', 'mark-settled']) {
      await request(ctx.server).post(`/admin/package-refund-requests/${refund.id}/${path}`).set('Cookie', cookie).expect(404);
    }
    await admin.approve(refund.id, { kind: 'NORMAL', status: 'SETTLED' }).expect(400);
    await request(ctx.server)
      .patch(`/admin/package-refund-requests/${refund.id}`)
      .set('Cookie', cookie)
      .send({ status: 'SETTLED' })
      .expect(404);
    const current = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: refund.id } });
    expect(current.status).toBe('UNDER_REVIEW');
  });

  it('an operator cannot attach a request to a customer’s ticket or to another provider’s purchase', async () => {
    const account = await providerAccount(ctx);
    const other = await providerAccount(ctx);
    const othersPurchase = await paidPurchase(ctx.prisma, { providerId: other.provider.id, userId: other.owner.id });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const customerTicket = await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', customerCookie)
      .send({ subject: 'Soru', message: 'Merhaba' })
      .expect(201);
    const providerTicket = await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', account.cookie)
      .send({ subject: 'Soru', message: 'Merhaba' })
      .expect(201);

    const { cookie } = await operator(ctx);
    const admin = adminCall(ctx, cookie);
    expect(
      (await admin.create({ supportTicketId: customerTicket.body.id, purchaseId: othersPurchase.id }).expect(409)).body.code,
    ).toBe('PACKAGE_REFUND_TICKET_NOT_ELIGIBLE');
    await admin.create({ supportTicketId: providerTicket.body.id, purchaseId: othersPurchase.id }).expect(404);
    expect(await ctx.prisma.packageRefundRequest.count()).toBe(0);
  });

  it('the list is paged, filterable by status, and counts every status', async () => {
    const a = await submitted();
    await submitted();
    const { cookie } = await operator(ctx);
    const admin = adminCall(ctx, cookie);
    await admin.take(a.refund.id).expect(200);

    const all = await admin.list().expect(200);
    expect(all.body.total).toBe(2);
    expect(all.body.statusCounts).toMatchObject({ SUBMITTED: 1, UNDER_REVIEW: 1, SETTLED: 0 });

    const underReview = await admin.list('?status=UNDER_REVIEW').expect(200);
    expect(underReview.body.items.map((item: { id: string }) => item.id)).toEqual([a.refund.id]);
    await admin.list('?status=NOPE').expect(400);
  });

  it('a request’s permission set never includes anything but the three refund permissions for the queue', async () => {
    // Sanity on the fixture: SUPPORT_WRITE alone cannot take a request.
    const { refund } = await submitted();
    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.SUPPORT_WRITE, AdminPermission.SUPPORT_READ]);
    const cookie = await loginAs(ctx.prisma, admin.id);
    await adminCall(ctx, cookie).take(refund.id).expect(403);
  });
});
