import {
  AdminPermission,
  CancelWinnerRefundDecision,
  CreditTransactionType,
  OfferEntitlementSource,
  OfferRejectionReason,
  OfferStatus,
  ServiceRequestCancelActor,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestCancellationOutbox } from '../src/modules/notifications/request-cancellation-outbox.service';
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';
import { REQUEST_CANCELLED_REFUND_REASON } from '../src/modules/offers/refund-policy';
import { cancelLoserOfferRule } from '../src/modules/service-requests/service-requests.service';
import {
  ACCEPT_OFFER,
  backdateOfferSubmission,
  createAdminWithPermissions,
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  currentCreditBalance,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * PR #118 — the request cancellation contract.
 *
 * - Customer: cancels their own request until an offer is accepted; a matched
 *   request answers 409 with nothing written.
 * - Operations: REQUESTS_CANCEL (a SUPER_ADMIN implicitly) cancels any open
 *   request, a matched one included. The accepted offer's credit comes back by
 *   default; keeping it needs REQUESTS_CANCEL_WITHOUT_REFUND, its own route and
 *   a reason. A missing or stray field never means "no refund".
 * - Money: losing offers (fixed set, see cancelLoserOfferRule) are refunded
 *   whatever was decided for the winner; nothing is paid twice by a repeat, the
 *   unviewed worker or a race.
 * - The accepted offer does not stay ACCEPTED; `acceptedAt` and `matchedOfferId`
 *   stay as the record.
 * - Notices: customer, winner and every affected provider — once each.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

const CATEGORY_COST = 2;

async function openRequest() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });
  const customerCookie = await loginAs(ctx.prisma, customer.id);
  return { category, customer, customerCookie, serviceRequest };
}

async function addOffer(categoryId: string, requestId: string) {
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: ownerUser.id, categoryId });
  const cookie = await loginAs(ctx.prisma, ownerUser.id);
  await grantCredits(ctx.prisma, provider.id, 10);
  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${requestId}/offers`)
    .set('Cookie', cookie)
    .send(offerPayload())
    .expect(201);
  return { provider, offerId: created.body.id as string };
}

function actionUrl(requestId: string, offerId: string) {
  return `/service-requests/${requestId}/offers/${offerId}/action`;
}

/** A matched request: the winner accepted by the customer, one competitor rejected by the cascade. */
async function matchedRequest() {
  const fixture = await openRequest();
  const winner = await addOffer(fixture.category.id, fixture.serviceRequest.id);
  const loser = await addOffer(fixture.category.id, fixture.serviceRequest.id);
  await request(ctx.server)
    .post(actionUrl(fixture.serviceRequest.id, winner.offerId))
    .set('Cookie', fixture.customerCookie)
    .send(ACCEPT_OFFER)
    .expect(201);
  ctx.notifications.clear();
  return { ...fixture, winner, loser };
}

async function staff(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return { admin, cookie: await loginAs(ctx.prisma, admin.id) };
}

async function superAdminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

function cancel(requestId: string, cookie: string, body: Record<string, unknown> = {}) {
  return request(ctx.server).post(`/service-requests/${requestId}/cancel`).set('Cookie', cookie).send(body);
}

function cancelWithholding(requestId: string, cookie: string, body: Record<string, unknown>) {
  return request(ctx.server)
    .post(`/service-requests/${requestId}/cancel/withhold-winner-refund`)
    .set('Cookie', cookie)
    .send(body);
}

async function cancelRefunds(offerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: { type: CreditTransactionType.OFFER_REFUND, referenceId: offerId },
    select: { id: true, reason: true, createdById: true, amount: true },
  });
}

async function snapshot(requestId: string) {
  const [req, offers, ledger, cancellation, notices] = await Promise.all([
    ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { status: true, matchedOfferId: true, cancelledAt: true },
    }),
    ctx.prisma.offer.findMany({
      where: { requestId },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, creditRefundedTransactionId: true, cancelledAt: true },
    }),
    ctx.prisma.providerCreditTransaction.count({ where: { type: CreditTransactionType.OFFER_REFUND } }),
    ctx.prisma.serviceRequestCancellation.count({ where: { requestId } }),
    ctx.prisma.notificationLog.count({ where: { requestId, template: { startsWith: 'request-cancelled' } } }),
  ]);
  return { req, offers, ledger, cancellation, notices };
}

describe('who may cancel', () => {
  it('lets the owning customer cancel an unmatched request: live offers close and are refunded', async () => {
    const { category, customerCookie, serviceRequest } = await openRequest();
    const offer = await addOffer(category.id, serviceRequest.id);
    const before = await currentCreditBalance(ctx.prisma, offer.provider.id);

    await cancel(serviceRequest.id, customerCookie).expect(201);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offer.offerId } });
    expect(stored.status).toBe(OfferStatus.CANCELLED);
    expect(stored.cancelledAt).not.toBeNull();
    const refunds = await cancelRefunds(offer.offerId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ reason: REQUEST_CANCELLED_REFUND_REASON, createdById: null, amount: CATEGORY_COST });
    expect(await currentCreditBalance(ctx.prisma, offer.provider.id)).toBe(before + CATEGORY_COST);

    const audit = await ctx.prisma.serviceRequestCancellation.findUniqueOrThrow({ where: { requestId: serviceRequest.id } });
    expect(audit).toMatchObject({
      actorKind: ServiceRequestCancelActor.CUSTOMER,
      previousStatus: ServiceRequestStatus.APPROVED,
      acceptedOfferId: null,
      winnerRefundDecision: CancelWinnerRefundDecision.NOT_MATCHED,
      withholdReason: null,
      closedOfferIds: [offer.offerId],
      refundedOfferIds: [offer.offerId],
    });
  });

  it('refuses a customer once an offer is accepted — 409, nothing written', async () => {
    const { customerCookie, serviceRequest } = await matchedRequest();
    const before = await snapshot(serviceRequest.id);

    const response = await cancel(serviceRequest.id, customerCookie).expect(409);
    expect(response.body.code).toBe('REQUEST_MATCHED_NOT_CANCELLABLE_BY_CUSTOMER');
    expect(await snapshot(serviceRequest.id)).toEqual(before);
  });

  it('refuses other customers, providers and staff without REQUESTS_CANCEL', async () => {
    const { category, serviceRequest } = await openRequest();
    const offer = await addOffer(category.id, serviceRequest.id);
    const stranger = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const providerOwner = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: offer.provider.id },
      select: { userId: true },
    });
    const reader = await staff([AdminPermission.REQUESTS_READ, AdminPermission.REQUESTS_STATUS]);
    const before = await snapshot(serviceRequest.id);

    await cancel(serviceRequest.id, await loginAs(ctx.prisma, stranger.id)).expect(403);
    await cancel(serviceRequest.id, await loginAs(ctx.prisma, providerOwner.userId!)).expect(403);
    await cancel(serviceRequest.id, reader.cookie).expect(403);
    // Holding the withhold permission alone is not holding REQUESTS_CANCEL.
    const withholdOnly = await staff([AdminPermission.REQUESTS_CANCEL_WITHOUT_REFUND]);
    await cancel(serviceRequest.id, withholdOnly.cookie).expect(403);

    expect(await snapshot(serviceRequest.id)).toEqual(before);
  });

  it('lets staff holding REQUESTS_CANCEL cancel a matched request, refunding the winner by default', async () => {
    const { serviceRequest, winner, loser } = await matchedRequest();
    const operator = await staff([AdminPermission.REQUESTS_CANCEL]);
    const winnerBefore = await currentCreditBalance(ctx.prisma, winner.provider.id);
    const loserBefore = await currentCreditBalance(ctx.prisma, loser.provider.id);

    await cancel(serviceRequest.id, operator.cookie, { expectedMatchedOfferId: winner.offerId }).expect(201);

    const req = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: serviceRequest.id } });
    expect(req.status).toBe(ServiceRequestStatus.CANCELLED);
    // The match stays on the record; the offer no longer holds it.
    expect(req.matchedOfferId).toBe(winner.offerId);
    const accepted = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: winner.offerId } });
    expect(accepted.status).toBe(OfferStatus.CANCELLED);
    expect(accepted.acceptedAt).not.toBeNull();
    expect(accepted.cancelledAt).not.toBeNull();
    expect(await ctx.prisma.offer.count({ where: { requestId: serviceRequest.id, status: OfferStatus.ACCEPTED } })).toBe(0);

    expect(await cancelRefunds(winner.offerId)).toEqual([
      expect.objectContaining({ reason: REQUEST_CANCELLED_REFUND_REASON, createdById: operator.admin.id }),
    ]);
    // The competitor the acceptance rejected stays rejected and gets its credit back.
    const lost = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: loser.offerId } });
    expect(lost.status).toBe(OfferStatus.REJECTED);
    expect(await cancelRefunds(loser.offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, winner.provider.id)).toBe(winnerBefore + CATEGORY_COST);
    expect(await currentCreditBalance(ctx.prisma, loser.provider.id)).toBe(loserBefore + CATEGORY_COST);

    const audit = await ctx.prisma.serviceRequestCancellation.findUniqueOrThrow({ where: { requestId: serviceRequest.id } });
    expect(audit).toMatchObject({
      actorKind: ServiceRequestCancelActor.STAFF,
      actorUserId: operator.admin.id,
      previousStatus: ServiceRequestStatus.MATCHED,
      acceptedOfferId: winner.offerId,
      winnerRefundDecision: CancelWinnerRefundDecision.REFUNDED,
      withholdReason: null,
      closedOfferIds: [winner.offerId],
    });
    expect([...audit.refundedOfferIds].sort()).toEqual([winner.offerId, loser.offerId].sort());
  });

  it('keeps a SUPER_ADMIN able to cancel, withholding included', async () => {
    const { serviceRequest, winner } = await matchedRequest();
    await cancelWithholding(serviceRequest.id, await superAdminCookie(), {
      reason: 'Hizmet veren işi yapmadığını bildirdi.',
      expectedMatchedOfferId: winner.offerId,
    }).expect(201);
    expect(await cancelRefunds(winner.offerId)).toHaveLength(0);
  });
});

describe('keeping the winner’s credit is an explicit, audited exception', () => {
  it('needs REQUESTS_CANCEL_WITHOUT_REFUND on top of REQUESTS_CANCEL', async () => {
    const { serviceRequest, winner } = await matchedRequest();
    const before = await snapshot(serviceRequest.id);
    const body = { reason: 'Müşteri işi başka kanaldan aldı.', expectedMatchedOfferId: winner.offerId };

    await cancelWithholding(serviceRequest.id, (await staff([AdminPermission.REQUESTS_CANCEL])).cookie, body).expect(403);
    await cancelWithholding(
      serviceRequest.id,
      (await staff([AdminPermission.REQUESTS_CANCEL_WITHOUT_REFUND])).cookie,
      body,
    ).expect(403);
    expect(await snapshot(serviceRequest.id)).toEqual(before);
  });

  it('refuses a missing or too short reason — 400, nothing written', async () => {
    const { serviceRequest, winner } = await matchedRequest();
    const operator = await staff([AdminPermission.REQUESTS_CANCEL, AdminPermission.REQUESTS_CANCEL_WITHOUT_REFUND]);
    const before = await snapshot(serviceRequest.id);

    await cancelWithholding(serviceRequest.id, operator.cookie, { expectedMatchedOfferId: winner.offerId }).expect(400);
    const short = await cancelWithholding(serviceRequest.id, operator.cookie, {
      reason: '   kısa   ',
      expectedMatchedOfferId: winner.offerId,
    }).expect(400);
    expect(short.body.code).toBe('CANCEL_WITHHOLD_REASON_REQUIRED');
    expect(await snapshot(serviceRequest.id)).toEqual(before);
  });

  it('never reads a missing or stray field on /cancel as "no refund"', async () => {
    const { serviceRequest, winner } = await matchedRequest();
    const operator = await staff([AdminPermission.REQUESTS_CANCEL, AdminPermission.REQUESTS_CANCEL_WITHOUT_REFUND]);
    const before = await snapshot(serviceRequest.id);

    // A body that tries to carry a refund switch is refused outright.
    for (const body of [{ refundWinner: false }, { refundWinner: 'false' }, { reason: 'x'.repeat(20) }]) {
      await cancel(serviceRequest.id, operator.cookie, body).expect(400);
    }
    expect(await snapshot(serviceRequest.id)).toEqual(before);

    // An empty body is the default: refunded.
    await cancel(serviceRequest.id, operator.cookie).expect(201);
    expect(await cancelRefunds(winner.offerId)).toHaveLength(1);
    const audit = await ctx.prisma.serviceRequestCancellation.findUniqueOrThrow({ where: { requestId: serviceRequest.id } });
    expect(audit.winnerRefundDecision).toBe(CancelWinnerRefundDecision.REFUNDED);
  });

  it('withholds only the winner: losers are refunded, and the actor, decision and reason are kept', async () => {
    const { serviceRequest, winner, loser } = await matchedRequest();
    const operator = await staff([AdminPermission.REQUESTS_CANCEL, AdminPermission.REQUESTS_CANCEL_WITHOUT_REFUND]);
    const reason = 'Hizmet veren müşteriye hiç ulaşmadı; iade yapılmayacak.';

    await cancelWithholding(serviceRequest.id, operator.cookie, {
      reason: `  ${reason}  `,
      expectedMatchedOfferId: winner.offerId,
    }).expect(201);

    expect(await cancelRefunds(winner.offerId)).toHaveLength(0);
    expect(await cancelRefunds(loser.offerId)).toHaveLength(1);
    const accepted = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: winner.offerId } });
    expect(accepted.status).toBe(OfferStatus.CANCELLED);
    expect(accepted.creditRefundedTransactionId).toBeNull();

    const audit = await ctx.prisma.serviceRequestCancellation.findUniqueOrThrow({ where: { requestId: serviceRequest.id } });
    expect(audit).toMatchObject({
      actorKind: ServiceRequestCancelActor.STAFF,
      actorUserId: operator.admin.id,
      winnerRefundDecision: CancelWinnerRefundDecision.WITHHELD,
      withholdReason: reason,
      refundedOfferIds: [loser.offerId],
    });
  });

  it('has no winner decision on an unmatched request', async () => {
    const { category, serviceRequest } = await openRequest();
    await addOffer(category.id, serviceRequest.id);
    const operator = await staff([AdminPermission.REQUESTS_CANCEL, AdminPermission.REQUESTS_CANCEL_WITHOUT_REFUND]);
    const before = await snapshot(serviceRequest.id);

    const response = await cancelWithholding(serviceRequest.id, operator.cookie, {
      reason: 'Eşleşme yokken bu yol kullanılamaz.',
      expectedMatchedOfferId: '',
    }).expect(409);
    expect(response.body.code).toBe('REQUEST_NOT_MATCHED');
    expect(await snapshot(serviceRequest.id)).toEqual(before);
  });

  it('refuses a cancel decided on a state that has since changed', async () => {
    const { customerCookie, category, serviceRequest } = await openRequest();
    const offer = await addOffer(category.id, serviceRequest.id);
    const operator = await staff([AdminPermission.REQUESTS_CANCEL]);
    // The operator decided on an open request; the customer accepts meanwhile.
    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, offer.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);
    const before = await snapshot(serviceRequest.id);

    const response = await cancel(serviceRequest.id, operator.cookie, { expectedMatchedOfferId: '' }).expect(409);
    expect(response.body.code).toBe('REQUEST_CANCEL_STATE_CHANGED');
    expect(await snapshot(serviceRequest.id)).toEqual(before);
  });
});

describe('which offers a cancel closes and refunds', () => {
  it('pins the losing-offer rule (K4)', () => {
    for (const status of [OfferStatus.SUBMITTED, OfferStatus.VIEWED, OfferStatus.SHORTLISTED]) {
      expect(cancelLoserOfferRule({ status }), status).toEqual({ close: true, refund: true });
    }
    // Any rejection — by the acceptance's cascade or by hand — keeps its
    // status and gets its credit back.
    expect(cancelLoserOfferRule({ status: OfferStatus.REJECTED })).toEqual({ close: false, refund: true });
    // Withdrawn and expired keep their own policies; closed and accepted are not losers.
    for (const status of [OfferStatus.WITHDRAWN, OfferStatus.EXPIRED, OfferStatus.CANCELLED, OfferStatus.ACCEPTED]) {
      expect(cancelLoserOfferRule({ status }), status).toEqual({ close: false, refund: false });
    }
  });

  it('applies it to every offer state on a matched request, paying nothing twice', async () => {
    const fixture = await openRequest();
    const { category, serviceRequest, customerCookie } = fixture;
    const winner = await addOffer(category.id, serviceRequest.id);
    const offers = {
      submitted: await addOffer(category.id, serviceRequest.id),
      viewed: await addOffer(category.id, serviceRequest.id),
      shortlisted: await addOffer(category.id, serviceRequest.id),
      handRejected: await addOffer(category.id, serviceRequest.id),
      operatorRejected: await addOffer(category.id, serviceRequest.id),
      competitor: await addOffer(category.id, serviceRequest.id),
      withdrawn: await addOffer(category.id, serviceRequest.id),
      expired: await addOffer(category.id, serviceRequest.id),
      alreadyRefunded: await addOffer(category.id, serviceRequest.id),
      packageSpend: await addOffer(category.id, serviceRequest.id),
    };
    // The customer rejects one by hand before accepting the winner.
    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, offers.handRejected.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'REJECT' })
      .expect(201);
    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, offers.withdrawn.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'SHORTLIST' })
      .expect(201);
    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    // States the acceptance cascade would not leave behind on its own: old
    // rows the rule still has to handle.
    const set = (id: string, data: Record<string, unknown>) => ctx.prisma.offer.update({ where: { id }, data });
    await set(offers.submitted.offerId, { status: OfferStatus.SUBMITTED, rejectedAt: null, rejectionReason: null });
    await set(offers.viewed.offerId, { status: OfferStatus.VIEWED, viewedAt: new Date(), rejectedAt: null, rejectionReason: null });
    await set(offers.shortlisted.offerId, { status: OfferStatus.SHORTLISTED, rejectedAt: null, rejectionReason: null });
    await set(offers.withdrawn.offerId, { status: OfferStatus.WITHDRAWN, withdrawnAt: new Date(), rejectionReason: null });
    // Rejected by an operator on the customer's behalf: the automatic refund
    // is blocked for it, but the cancel refunds it all the same.
    await set(offers.operatorRejected.offerId, {
      status: OfferStatus.REJECTED,
      rejectionReason: null,
      refundBlockedAt: new Date(),
      refundBlockedReason: 'ADMIN_CUSTOMER_DECISION',
    });
    await set(offers.expired.offerId, { status: OfferStatus.EXPIRED, rejectionReason: null });
    await set(offers.packageSpend.offerId, {
      status: OfferStatus.SUBMITTED,
      rejectedAt: null,
      rejectionReason: null,
      entitlementSource: OfferEntitlementSource.MONTHLY_QUOTA,
    });
    // One competitor already got its credit back through the unviewed worker.
    await backdateOfferSubmission(ctx.prisma, offers.alreadyRefunded.offerId, 72);
    await ctx.app.get(UnviewedOfferRefundService).execute({});
    expect(await cancelRefunds(offers.alreadyRefunded.offerId)).toHaveLength(1);
    const competitor = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offers.competitor.offerId } });
    expect(competitor).toMatchObject({ status: OfferStatus.REJECTED, rejectionReason: OfferRejectionReason.COMPETITOR_ACCEPTED });

    await cancel(serviceRequest.id, await superAdminCookie()).expect(201);

    const status = async (id: string) => (await ctx.prisma.offer.findUniqueOrThrow({ where: { id } })).status;
    const refundCount = async (id: string) => (await cancelRefunds(id)).length;

    expect(await status(winner.offerId)).toBe(OfferStatus.CANCELLED);
    expect(await refundCount(winner.offerId)).toBe(1);
    for (const key of ['submitted', 'viewed', 'shortlisted'] as const) {
      expect(await status(offers[key].offerId), key).toBe(OfferStatus.CANCELLED);
      expect(await refundCount(offers[key].offerId), key).toBe(1);
    }
    expect(await status(offers.competitor.offerId)).toBe(OfferStatus.REJECTED);
    expect(await refundCount(offers.competitor.offerId)).toBe(1);
    // K4: a hand rejection keeps its status and its credit comes back.
    for (const key of ['handRejected', 'operatorRejected'] as const) {
      expect(await status(offers[key].offerId), key).toBe(OfferStatus.REJECTED);
      expect(await refundCount(offers[key].offerId), key).toBe(1);
    }
    expect(await status(offers.withdrawn.offerId)).toBe(OfferStatus.WITHDRAWN);
    expect(await refundCount(offers.withdrawn.offerId)).toBe(0);
    expect(await status(offers.expired.offerId)).toBe(OfferStatus.EXPIRED);
    expect(await refundCount(offers.expired.offerId)).toBe(0);
    // Already refunded by the worker: the competitor keeps that one refund.
    expect(await refundCount(offers.alreadyRefunded.offerId)).toBe(1);
    // A period-package offer closes with no ledger row.
    expect(await status(offers.packageSpend.offerId)).toBe(OfferStatus.CANCELLED);
    expect(await refundCount(offers.packageSpend.offerId)).toBe(0);
  });

  it('refunds a hand-rejected offer on an unmatched request too, and a second cancel pays nothing', async () => {
    const { category, serviceRequest, customerCookie } = await openRequest();
    const rejected = await addOffer(category.id, serviceRequest.id);
    const live = await addOffer(category.id, serviceRequest.id);
    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, rejected.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'REJECT' })
      .expect(201);
    const before = await currentCreditBalance(ctx.prisma, rejected.provider.id);

    await cancel(serviceRequest.id, customerCookie).expect(201);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: rejected.offerId } });
    expect(stored.status).toBe(OfferStatus.REJECTED);
    expect(await cancelRefunds(rejected.offerId)).toHaveLength(1);
    expect(await cancelRefunds(live.offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, rejected.provider.id)).toBe(before + CATEGORY_COST);
    const audit = await ctx.prisma.serviceRequestCancellation.findUniqueOrThrow({ where: { requestId: serviceRequest.id } });
    expect([...audit.refundedOfferIds].sort()).toEqual([rejected.offerId, live.offerId].sort());
    expect(audit.closedOfferIds).toEqual([live.offerId]);

    const after = await snapshot(serviceRequest.id);
    await cancel(serviceRequest.id, customerCookie).expect(409);
    await ctx.app.get(UnviewedOfferRefundService).execute({});
    expect(await snapshot(serviceRequest.id)).toEqual(after);
  });

  it('refunds losers the same way whether the winner is refunded or withheld', async () => {
    const operator = await staff([AdminPermission.REQUESTS_CANCEL, AdminPermission.REQUESTS_CANCEL_WITHOUT_REFUND]);
    for (const withhold of [false, true]) {
      const fixture = await openRequest();
      const winner = await addOffer(fixture.category.id, fixture.serviceRequest.id);
      const declined = await addOffer(fixture.category.id, fixture.serviceRequest.id);
      const competitor = await addOffer(fixture.category.id, fixture.serviceRequest.id);
      await request(ctx.server)
        .post(actionUrl(fixture.serviceRequest.id, declined.offerId))
        .set('Cookie', fixture.customerCookie)
        .send({ action: 'REJECT' })
        .expect(201);
      await request(ctx.server)
        .post(actionUrl(fixture.serviceRequest.id, winner.offerId))
        .set('Cookie', fixture.customerCookie)
        .send(ACCEPT_OFFER)
        .expect(201);

      if (withhold) {
        await cancelWithholding(fixture.serviceRequest.id, operator.cookie, {
          reason: 'Kazanan hizmet veren işi reddetti.',
          expectedMatchedOfferId: winner.offerId,
        }).expect(201);
      } else {
        await cancel(fixture.serviceRequest.id, operator.cookie, { expectedMatchedOfferId: winner.offerId }).expect(201);
      }

      expect(await cancelRefunds(winner.offerId), `withhold=${withhold}`).toHaveLength(withhold ? 0 : 1);
      expect(await cancelRefunds(declined.offerId), `withhold=${withhold}`).toHaveLength(1);
      expect(await cancelRefunds(competitor.offerId), `withhold=${withhold}`).toHaveLength(1);
      // The newly refunded hand-rejected offer's owner is notified too.
      const keys = (
        await ctx.prisma.notificationLog.findMany({
          where: { requestId: fixture.serviceRequest.id, template: 'request-cancelled-offer' },
          select: { dedupeKey: true },
        })
      ).map((row) => row.dedupeKey);
      expect(keys.sort(), `withhold=${withhold}`).toEqual(
        [`request-cancelled-offer:${declined.offerId}`, `request-cancelled-offer:${competitor.offerId}`].sort(),
      );
    }
  });

  it('pays nothing twice: a repeat cancel, a later worker run and a race with the worker', async () => {
    // Repeat + later worker.
    const first = await matchedRequest();
    const admin = await superAdminCookie();
    await backdateOfferSubmission(ctx.prisma, first.loser.offerId, 72);
    await cancel(first.serviceRequest.id, admin).expect(201);
    const after = await snapshot(first.serviceRequest.id);
    const second = await cancel(first.serviceRequest.id, admin).expect(409);
    expect(second.body.code).toBe('REQUEST_NOT_CANCELLABLE');
    await ctx.app.get(UnviewedOfferRefundService).execute({});
    expect(await snapshot(first.serviceRequest.id)).toEqual(after);

    // Race with the worker on an unviewed, eligible offer, several times over —
    // a live one on even attempts, a rejected one (rejected without being
    // opened, so the worker also wants it) on odd ones.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { category, serviceRequest, customerCookie } = await openRequest();
      const offer = await addOffer(category.id, serviceRequest.id);
      if (attempt % 2 === 1) {
        await ctx.prisma.offer.update({
          where: { id: offer.offerId },
          data: { status: OfferStatus.REJECTED, rejectedAt: new Date() },
        });
      }
      await backdateOfferSubmission(ctx.prisma, offer.offerId, 72);
      const [cancelResponse] = await Promise.all([
        cancel(serviceRequest.id, customerCookie),
        ctx.app.get(UnviewedOfferRefundService).execute({}),
      ]);
      expect(cancelResponse.status, `attempt ${attempt}`).toBe(201);
      expect(await cancelRefunds(offer.offerId), `attempt ${attempt}`).toHaveLength(1);
      expect(await currentCreditBalance(ctx.prisma, offer.provider.id), `attempt ${attempt}`).toBe(10);
    }
  });
});

describe('an acceptance and a customer cancel racing each other', () => {
  it('lets exactly one win and leaves no partial side effect', async () => {
    let acceptWins = 0;
    let cancelWins = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const { category, serviceRequest, customerCookie } = await openRequest();
      const offer = await addOffer(category.id, serviceRequest.id);

      const [accepted, cancelled] = await Promise.all([
        request(ctx.server).post(actionUrl(serviceRequest.id, offer.offerId)).set('Cookie', customerCookie).send(ACCEPT_OFFER),
        cancel(serviceRequest.id, customerCookie),
      ]);
      const statuses = [accepted.status, cancelled.status].sort();
      expect(statuses, `attempt ${attempt}`).toEqual([201, 409]);

      const state = await snapshot(serviceRequest.id);
      if (accepted.status === 201) {
        acceptWins += 1;
        expect(state.req.status).toBe(ServiceRequestStatus.MATCHED);
        expect(state.req.matchedOfferId).toBe(offer.offerId);
        expect(state.offers[0]?.status).toBe(OfferStatus.ACCEPTED);
        expect(state.cancellation).toBe(0);
        expect(await cancelRefunds(offer.offerId)).toHaveLength(0);
      } else {
        cancelWins += 1;
        expect(state.req.status).toBe(ServiceRequestStatus.CANCELLED);
        expect(state.req.matchedOfferId).toBeNull();
        expect(state.offers[0]?.status).toBe(OfferStatus.CANCELLED);
        expect(state.cancellation).toBe(1);
        expect(await cancelRefunds(offer.offerId)).toHaveLength(1);
        expect(await ctx.prisma.contactRevealEvent.count({ where: { requestId: serviceRequest.id } })).toBe(0);
      }
    }
    expect(acceptWins + cancelWins).toBe(12);
  });
});

describe('the historical match is never read as a live one', () => {
  it('shows the customer and both providers an ended match after an operations cancel', async () => {
    const { serviceRequest, winner, loser, customerCookie } = await matchedRequest();
    const winnerOwner = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: winner.provider.id },
      select: { userId: true },
    });
    const loserOwner = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: loser.provider.id },
      select: { userId: true },
    });
    const winnerCookie = await loginAs(ctx.prisma, winnerOwner.userId!);
    const loserCookie = await loginAs(ctx.prisma, loserOwner.userId!);

    await cancel(serviceRequest.id, await superAdminCookie()).expect(201);

    // The row keeps the pointer as history…
    expect((await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: serviceRequest.id } })).matchedOfferId).toBe(
      winner.offerId,
    );

    // …the customer's own reads say cancelled and open no contact.
    const mine = await request(ctx.server).get(`/service-requests/my/${serviceRequest.id}`).set('Cookie', customerCookie).expect(200);
    expect(mine.body.status).toBe(ServiceRequestStatus.CANCELLED);
    await request(ctx.server).get(`/service-requests/${serviceRequest.id}/matched-contact`).set('Cookie', customerCookie).expect(404);

    // …the winner's offer reads closed, with no work brief, no contact and the right notice.
    const won = await request(ctx.server)
      .get(`/providers/${winner.provider.id}/offers/${winner.offerId}`)
      .set('Cookie', winnerCookie)
      .expect(200);
    expect(won.body.status).toBe(OfferStatus.CANCELLED);
    expect(won.body.acceptedWorkScope ?? null).toBeNull();
    expect(won.body.closureNotice).toBe('Talep iptal edildi. Harcanan teklif krediniz iade edildi.');
    await request(ctx.server)
      .get(`/providers/${winner.provider.id}/offers/${winner.offerId}/matched-contact`)
      .set('Cookie', winnerCookie)
      .expect(404);

    // …and the competitor's stays rejected, never re-labelled as anything live.
    const lost = await request(ctx.server)
      .get(`/providers/${loser.provider.id}/offers/${loser.offerId}`)
      .set('Cookie', loserCookie)
      .expect(200);
    expect(lost.body.status).toBe(OfferStatus.REJECTED);
    expect(lost.body.closureNotice).toBeNull();
  });
});

describe('cancellation notices', () => {
  it('tells the customer, the winner and every affected provider once — without personal details', async () => {
    const { serviceRequest, winner, loser, customer } = await matchedRequest();
    const operator = await staff([AdminPermission.REQUESTS_CANCEL, AdminPermission.REQUESTS_CANCEL_WITHOUT_REFUND]);
    const reason = 'GİZLİ-OPERASYON-NOTU müşteri şikayeti';
    await cancelWithholding(serviceRequest.id, operator.cookie, {
      reason,
      expectedMatchedOfferId: winner.offerId,
    }).expect(201);

    const outbox = ctx.app.get(RequestCancellationOutbox);
    await outbox.deliverPending();
    const again = await outbox.deliverPending();
    expect(again.claimed).toBe(0);

    const logs = await ctx.prisma.notificationLog.findMany({
      where: { requestId: serviceRequest.id, template: { startsWith: 'request-cancelled' } },
      select: { template: true, dedupeKey: true, status: true, providerId: true },
      orderBy: { template: 'asc' },
    });
    expect(logs).toEqual([
      expect.objectContaining({ template: 'request-cancelled-customer', dedupeKey: `request-cancelled-customer:${serviceRequest.id}`, status: 'SENT' }),
      expect.objectContaining({ template: 'request-cancelled-offer', dedupeKey: `request-cancelled-offer:${loser.offerId}`, status: 'SENT', providerId: loser.provider.id }),
      expect.objectContaining({ template: 'request-cancelled-winner', dedupeKey: `request-cancelled-winner:${winner.offerId}`, status: 'SENT', providerId: winner.provider.id }),
    ]);

    const sent = ctx.notifications.sent.filter((message) => message.template.startsWith('request-cancelled'));
    expect(sent).toHaveLength(3);
    const storedRequest = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: serviceRequest.id } });
    for (const message of sent) {
      const payload = JSON.stringify(message.data ?? {});
      expect(payload, message.template).not.toContain(reason);
      expect(payload, message.template).not.toContain('GİZLİ');
      if (message.template !== 'request-cancelled-customer') {
        expect(payload).not.toContain(storedRequest.customerPhone);
        if (storedRequest.customerEmail) expect(payload).not.toContain(storedRequest.customerEmail);
        expect(payload).not.toContain(storedRequest.customerName);
      }
    }
    expect(ctx.notifications.lastOfTemplate('request-cancelled-winner')?.data).toMatchObject({ withheld: '1', refundedCredits: null });
    expect(ctx.notifications.lastOfTemplate('request-cancelled-offer')?.data).toMatchObject({ refundedCredits: String(CATEGORY_COST) });
    expect(ctx.notifications.lastOfTemplate('request-cancelled-customer')?.to).toBe(storedRequest.customerEmail);
    expect(customer.id).toBeTruthy();
  });

  it('writes no notice when the cancel is refused', async () => {
    const { serviceRequest, customerCookie } = await matchedRequest();
    await cancel(serviceRequest.id, customerCookie).expect(409);
    await ctx.app.get(RequestCancellationOutbox).deliverPending();
    expect(await ctx.prisma.notificationLog.count({ where: { template: { startsWith: 'request-cancelled' } } })).toBe(0);
  });
});
