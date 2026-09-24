import { AdminPermission, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdminWithPermissions,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';
import {
  ALL_REFUND_PERMISSIONS,
  TERMS,
  adminCall,
  gateSwitch,
  openRefundTicket,
  operator,
  paidPurchase,
  providerAccount,
  requestOfTicket,
} from './package-refund-fixtures';

/**
 * CMP-006 PR-B — who can learn what about a refund request.
 *
 * The matrix: anonymous, customer, another provider, staff without the refund
 * permissions, staff with each one of them. And the canary: whatever the
 * route, no refund projection carries the purchase-terms evidence (address,
 * user agent, snapshot, digest, acceptance id) or a payment identifier.
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

async function scenario() {
  const owner = await providerAccount(ctx);
  const purchase = await paidPurchase(ctx.prisma, { providerId: owner.provider.id, userId: owner.owner.id });
  const opened = await openRefundTicket(ctx, owner.cookie, purchase.id).expect(201);
  const refund = await requestOfTicket(ctx.prisma, opened.body.id);
  return { owner, purchase, ticketId: opened.body.id as string, refund };
}

async function staff(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return loginAs(ctx.prisma, admin.id);
}

describe('who reaches what', () => {
  it('anonymous: 401 everywhere', async () => {
    const { refund, ticketId } = await scenario();
    await request(ctx.server).get('/admin/package-refund-requests').expect(401);
    await request(ctx.server).get(`/admin/package-refund-requests/${refund.id}`).expect(401);
    await request(ctx.server).post(`/admin/package-refund-requests/${refund.id}/take`).expect(401);
    await request(ctx.server).get('/support/package-refund/options').expect(401);
    await request(ctx.server).post(`/support/package-refund/tickets/${ticketId}/withdraw`).expect(401);
  });

  it('a customer: 403 on every refund route, and no refund on anything they can read', async () => {
    const { refund, ticketId } = await scenario();
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await loginAs(ctx.prisma, customer.id);

    await request(ctx.server).get('/admin/package-refund-requests').set('Cookie', cookie).expect(403);
    await request(ctx.server).get(`/admin/package-refund-requests/${refund.id}`).set('Cookie', cookie).expect(403);
    await request(ctx.server).get('/support/package-refund/options').set('Cookie', cookie).expect(403);
    await request(ctx.server).post(`/support/package-refund/tickets/${ticketId}/withdraw`).set('Cookie', cookie).expect(403);
    await request(ctx.server).get(`/support/tickets/${ticketId}`).set('Cookie', cookie).expect(404);
  });

  it('another provider: the ticket, the request and the purchase are all the same 404 as nothing', async () => {
    const { purchase, ticketId, refund } = await scenario();
    const stranger = await providerAccount(ctx);

    await request(ctx.server).get(`/support/tickets/${ticketId}`).set('Cookie', stranger.cookie).expect(404);
    await request(ctx.server)
      .post(`/support/package-refund/tickets/${ticketId}/withdraw`)
      .set('Cookie', stranger.cookie)
      .expect(404);
    await openRefundTicket(ctx, stranger.cookie, purchase.id).expect(404);
    const options = await request(ctx.server).get('/support/package-refund/options').set('Cookie', stranger.cookie);
    expect(options.body).toEqual({ available: false, testMode: false, purchases: [] });
    await request(ctx.server).get(`/admin/package-refund-requests/${refund.id}`).set('Cookie', stranger.cookie).expect(403);

    const unchanged = await ctx.prisma.packageRefundRequest.findUniqueOrThrow({ where: { id: refund.id } });
    expect(unchanged.status).toBe('SUBMITTED');
  });

  it('staff without PACKAGE_REFUND_READ: no queue, and the ticket shows the topic but no request', async () => {
    const { refund, ticketId } = await scenario();
    const cookie = await staff([AdminPermission.SUPPORT_READ, AdminPermission.PACKAGE_PURCHASES_READ]);

    const denied = await request(ctx.server).get('/admin/package-refund-requests').set('Cookie', cookie).expect(403);
    expect(denied.body.code).toBe('INSUFFICIENT_PERMISSION');
    await request(ctx.server).get(`/admin/package-refund-requests/${refund.id}`).set('Cookie', cookie).expect(403);

    const ticket = await request(ctx.server).get(`/admin/support/tickets/${ticketId}`).set('Cookie', cookie).expect(200);
    expect(ticket.body.topic).toBe('PACKAGE_AND_CREDIT_REFUND');
    expect(ticket.body.packageRefund).toBeNull();
    expect(ticket.body.timeline.some((entry: { kind: string }) => entry.kind === 'PACKAGE_REFUND_EVENT')).toBe(false);
    expect(JSON.stringify(ticket.body)).not.toContain(refund.id);
  });

  it('READ alone: reads, and every write is 403', async () => {
    const { refund, ticketId } = await scenario();
    const cookie = await staff([AdminPermission.PACKAGE_REFUND_READ]);
    const admin = adminCall(ctx, cookie);

    await admin.list().expect(200);
    const detail = await admin.detail(refund.id).expect(200);
    expect(detail.body.allowedActions).toEqual({
      take: false,
      approveNormal: false,
      approveException: false,
      reject: false,
      markSettlementFailed: false,
    });
    await admin.take(refund.id).expect(403);
    await admin.approve(refund.id, { kind: 'NORMAL' }).expect(403);
    await admin.reject(refund.id, 'Yetkisiz ret denemesi.').expect(403);
    await admin.settlementFailed(refund.id, 'Yetkisiz kayıt denemesi.').expect(403);
    await admin.create({ supportTicketId: ticketId, purchaseId: refund.purchaseId }).expect(403);
  });

  it('REQUEST_CREATE may take but not decide; APPROVE may decide but not take', async () => {
    const { refund } = await scenario();
    const maker = adminCall(ctx, await staff([AdminPermission.PACKAGE_REFUND_REQUEST_CREATE]));
    const checker = adminCall(ctx, await staff([AdminPermission.PACKAGE_REFUND_APPROVE]));

    await checker.take(refund.id).expect(403);
    await maker.take(refund.id).expect(200);
    await maker.approve(refund.id, { kind: 'NORMAL' }).expect(403);
    await maker.reject(refund.id, 'Yapıcı ret denemesi.').expect(403);
    await checker.approve(refund.id, { kind: 'NORMAL' }).expect(200);
  });

  it('SUPER_ADMIN holds all three without an assignment', async () => {
    const { refund } = await scenario();
    const root = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const admin = adminCall(ctx, await loginAs(ctx.prisma, root.id));
    await admin.take(refund.id).expect(200);
    await admin.approve(refund.id, { kind: 'NORMAL' }).expect(200);
  });
});

describe('the canary: nothing sensitive in any refund projection', () => {
  it('no address, user agent, text, digest, acceptance id or payment identifier on any surface', async () => {
    const { owner, purchase, ticketId, refund } = await scenario();
    const cookie = await staff([...ALL_REFUND_PERMISSIONS, AdminPermission.SUPPORT_READ]);
    const admin = adminCall(ctx, cookie);
    await admin.take(refund.id).expect(200);

    const acceptance = await ctx.prisma.purchaseTermsAcceptance.findUniqueOrThrow({
      where: { purchaseId: purchase.id },
    });

    const bodies = [
      (await admin.list().expect(200)).body,
      (await admin.detail(refund.id).expect(200)).body,
      (await request(ctx.server).get(`/admin/support/tickets/${ticketId}`).set('Cookie', cookie).expect(200)).body,
      (await request(ctx.server).get(`/support/tickets/${ticketId}`).set('Cookie', owner.cookie).expect(200)).body,
      (await request(ctx.server).get('/support/package-refund/options').set('Cookie', owner.cookie).expect(200)).body,
    ].map((body) => JSON.stringify(body));

    const canaries = [
      acceptance.clientIp!,
      acceptance.userAgent!,
      acceptance.documentSha256,
      acceptance.id,
      TERMS.documents[0]!.text.slice(0, 60),
      purchase.paymentReference!,
      purchase.providerOrderId!,
    ];
    for (const body of bodies) {
      for (const canary of canaries) {
        expect(body).not.toContain(canary);
      }
    }

    // The evidence the operator does see is the version and the moment, nothing else.
    const detail = JSON.parse(bodies[1]!);
    expect(detail.termsEvidence).toEqual({
      documentVersion: TERMS.version,
      acceptedAt: acceptance.acceptedAt.toISOString(),
    });
  });

  it('the list row and the provider view are exact key sets', async () => {
    const { owner, ticketId } = await scenario();
    const cookie = await staff([AdminPermission.PACKAGE_REFUND_READ]);
    const list = await adminCall(ctx, cookie).list().expect(200);

    expect(Object.keys(list.body.items[0]).sort()).toEqual(
      [
        'approvalKind',
        'createdAt',
        'exceptionGround',
        'id',
        'origin',
        'provider',
        'purchase',
        'status',
        'statusLabel',
        'submittedRecommendation',
        'supportTicketId',
        'updatedAt',
      ].sort(),
    );
    expect(Object.keys(list.body.items[0].provider).sort()).toEqual(['businessName', 'id']);
    expect(Object.keys(list.body.items[0].purchase).sort()).toEqual(
      ['creditAmount', 'currency', 'id', 'packageName', 'paidAt', 'priceAmount', 'purchaseNumber'].sort(),
    );

    const mine = await request(ctx.server).get(`/support/tickets/${ticketId}`).set('Cookie', owner.cookie);
    expect(Object.keys(mine.body.packageRefundRequest).sort()).toEqual(
      ['canWithdraw', 'createdAt', 'id', 'purchase', 'status', 'statusLabel'].sort(),
    );
  });

  it('the operator view of a ticket with no request offers the provider’s own candidates only to a maker', async () => {
    const owner = await providerAccount(ctx);
    await paidPurchase(ctx.prisma, { providerId: owner.provider.id, userId: owner.owner.id });
    const other = await providerAccount(ctx);
    const othersPurchase = await paidPurchase(ctx.prisma, { providerId: other.provider.id, userId: other.owner.id });
    const ticket = await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', owner.cookie)
      .send({ subject: 'Genel', message: 'Merhaba' })
      .expect(201);

    const reader = await staff([AdminPermission.SUPPORT_READ, AdminPermission.PACKAGE_REFUND_READ]);
    const readerView = await request(ctx.server).get(`/admin/support/tickets/${ticket.body.id}`).set('Cookie', reader);
    expect(readerView.body.packageRefund).toEqual({ request: null, canOpen: false, candidatePurchases: [] });

    const { cookie: maker } = await operator(ctx, [...ALL_REFUND_PERMISSIONS, AdminPermission.SUPPORT_READ]);
    const makerView = await request(ctx.server).get(`/admin/support/tickets/${ticket.body.id}`).set('Cookie', maker);
    expect(makerView.body.packageRefund.canOpen).toBe(true);
    expect(makerView.body.packageRefund.candidatePurchases).toHaveLength(1);
    expect(JSON.stringify(makerView.body)).not.toContain(othersPurchase.id);
  });
});
