import {
  CreditTransactionType,
  OfferEntitlementSource,
  OfferStatus,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';
import {
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
 * Taking a request off the market — today the moderation screen's "Reddet",
 * later a report's "Talebi kaldır" — closes every live offer on it and gives
 * every one-time credit those offers spent back, atomically and exactly once.
 * These cases are the money-side contract of that cascade.
 */
let ctx: TestContext;
const COST = 2;
const STARTING_CREDITS = 10;

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

async function providerWithOffer(
  categoryId: string,
  requestId: string,
  opts: { viewed?: boolean } = {},
) {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { categoryId, userId: user.id });
  await grantCredits(ctx.prisma, provider.id, STARTING_CREDITS);
  const cookie = await loginAs(ctx.prisma, user.id);
  const res = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${requestId}/offers`)
    .set('Cookie', cookie)
    .send(offerPayload({ expectedCreditCost: COST }))
    .expect(201);
  if (opts.viewed) {
    await ctx.prisma.offer.update({
      where: { id: res.body.id },
      data: { viewedAt: new Date(), status: OfferStatus.VIEWED },
    });
  }
  return { provider, offerId: res.body.id as string, cookie };
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

async function rejectAsAdmin(requestId: string, expectedStatus: number) {
  const cookie = await adminCookie();
  return request(ctx.server)
    .patch(`/service-requests/${requestId}/status`)
    .set('Cookie', cookie)
    .send({ status: 'REJECTED', rejectionReason: 'Sahte talep' })
    .expect(expectedStatus);
}

function refundRows(providerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: { providerId, type: CreditTransactionType.OFFER_REFUND },
  });
}

async function scenario() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: COST });
  const req = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    approvedAt: new Date(),
  });
  return { category, req };
}

describe('removing a request closes offers and refunds credits', () => {
  it('viewed offer: CANCELLED, one full refund, balance restored', async () => {
    const { category, req } = await scenario();
    const { provider, offerId } = await providerWithOffer(category.id, req.id, { viewed: true });
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS - COST);

    const response = await rejectAsAdmin(req.id, 200);
    expect(response.body.status).toBe(ServiceRequestStatus.REJECTED);
    expect(response.body.rejectionReason).toBe('Sahte talep');

    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.status).toBe(OfferStatus.CANCELLED);
    expect(offer.cancelledAt).not.toBeNull();
    expect(offer.creditRefundReason).toBe('REQUEST_REMOVED');
    expect(offer.creditRefundedTransactionId).not.toBeNull();
    expect(offer.creditRefundedAt).not.toBeNull();
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);

    const rows = await refundRows(provider.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount: COST,
      reason: 'REQUEST_REMOVED',
      referenceType: 'Offer',
      referenceId: offerId,
    });
    expect(rows[0]?.id).toBe(offer.creditRefundedTransactionId);
    // The operator who removed the request is the ledger's actor.
    expect(rows[0]?.createdById).not.toBeNull();

    // The provider learns about it in the panel, not by mail.
    expect(ctx.notifications.sent.some((m) => m.template === 'credit-refunded')).toBe(false);

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe(ServiceRequestStatus.REJECTED);
    expect(row.moderatedAt).not.toBeNull();
  });

  it('unviewed offer: refunded once; the unviewed sweeper never pays it again', async () => {
    const { category, req } = await scenario();
    const { provider, offerId } = await providerWithOffer(category.id, req.id);

    await rejectAsAdmin(req.id, 200);
    expect(await refundRows(provider.id)).toHaveLength(1);

    // Age the offer past its own refund moment so the sweeper would pay it if
    // the removal had not already.
    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: { unviewedRefundEligibleAt: new Date(Date.now() - 1000) },
    });

    const sweeper = ctx.app.get(UnviewedOfferRefundService);
    const result = await sweeper.execute({ limit: 50 });
    expect(result.refunded).toBe(0);
    expect(result.processed).toBe(0);

    expect(await refundRows(provider.id)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.status).toBe(OfferStatus.CANCELLED);
    expect(offer.creditRefundReason).toBe('REQUEST_REMOVED');
  });

  it('several offers: one refund each; a second removal attempt changes nothing', async () => {
    const { category, req } = await scenario();
    const a = await providerWithOffer(category.id, req.id, { viewed: true });
    const b = await providerWithOffer(category.id, req.id);

    await rejectAsAdmin(req.id, 200);
    const second = await rejectAsAdmin(req.id, 409);
    expect(second.body.code).toBe('REQUEST_NOT_REMOVABLE');

    expect(await refundRows(a.provider.id)).toHaveLength(1);
    expect(await refundRows(b.provider.id)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, a.provider.id)).toBe(STARTING_CREDITS);
    expect(await currentCreditBalance(ctx.prisma, b.provider.id)).toBe(STARTING_CREDITS);

    for (const offerId of [a.offerId, b.offerId]) {
      const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
      expect(offer.status).toBe(OfferStatus.CANCELLED);
      expect(offer.cancelledAt).not.toBeNull();
    }

    // The database's own bar: a second refund row for one offer is unrepresentable.
    await expect(
      ctx.prisma.providerCreditTransaction.create({
        data: {
          providerId: a.provider.id,
          type: CreditTransactionType.OFFER_REFUND,
          amount: COST,
          balanceAfter: STARTING_CREDITS + COST,
          referenceType: 'Offer',
          referenceId: a.offerId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('zero-credit and period-package offers close without a ledger row', async () => {
    const { category, req } = await scenario();
    const { provider, offerId } = await providerWithOffer(category.id, req.id);
    // Rewrite the spend as a period-package offer: no ledger row to give back.
    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: {
        entitlementSource: OfferEntitlementSource.MONTHLY_QUOTA,
        creditSpentTransactionId: null,
      },
    });
    const before = await currentCreditBalance(ctx.prisma, provider.id);

    await rejectAsAdmin(req.id, 200);

    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.status).toBe(OfferStatus.CANCELLED);
    expect(offer.cancelledAt).not.toBeNull();
    expect(offer.creditRefundedTransactionId).toBeNull();
    expect(offer.creditRefundedAt).toBeNull();
    expect(offer.creditRefundReason).toBeNull();
    expect(await refundRows(provider.id)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(before);
  });

  it('an offer the provider already withdrew is left alone', async () => {
    const { category, req } = await scenario();
    const { provider, offerId } = await providerWithOffer(category.id, req.id);
    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: { status: OfferStatus.WITHDRAWN, withdrawnAt: new Date() },
    });

    await rejectAsAdmin(req.id, 200);

    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.status).toBe(OfferStatus.WITHDRAWN);
    expect(offer.cancelledAt).toBeNull();
    expect(await refundRows(provider.id)).toHaveLength(0);
  });

  it('a MATCHED request cannot be removed and nothing moves', async () => {
    const { category, req } = await scenario();
    const { provider, offerId } = await providerWithOffer(category.id, req.id);
    await ctx.prisma.$transaction([
      ctx.prisma.offer.update({
        where: { id: offerId },
        data: { status: OfferStatus.ACCEPTED, acceptedAt: new Date() },
      }),
      ctx.prisma.serviceRequest.update({
        where: { id: req.id },
        data: {
          status: ServiceRequestStatus.MATCHED,
          matchedOfferId: offerId,
          matchedAt: new Date(),
        },
      }),
    ]);

    const response = await rejectAsAdmin(req.id, 409);
    expect(response.body.code).toBe('REQUEST_NOT_REMOVABLE');

    expect(await refundRows(provider.id)).toHaveLength(0);
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.status).toBe(OfferStatus.ACCEPTED);
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe(ServiceRequestStatus.MATCHED);
  });

  it('a failing refund rolls the whole removal back', async () => {
    const { category, req } = await scenario();
    const { provider, offerId } = await providerWithOffer(category.id, req.id);
    // Poison the offer so refundOfferCreditInTransaction's conditional update
    // matches nothing: the cascade's candidate filter still sees it (no refund
    // transaction id), the helper's own guard refuses it.
    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: { creditRefundedAt: new Date() },
    });

    await rejectAsAdmin(req.id, 409);

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe(ServiceRequestStatus.APPROVED);
    expect(row.rejectionReason).toBeNull();
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.status).toBe(OfferStatus.SUBMITTED);
    expect(offer.cancelledAt).toBeNull();
    // The ledger row the helper inserted before its guard fired is gone too.
    expect(await refundRows(provider.id)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS - COST);
  });

  it('a manual refund after removal is refused as already refunded', async () => {
    const { category, req } = await scenario();
    const { provider, offerId } = await providerWithOffer(category.id, req.id, { viewed: true });
    await rejectAsAdmin(req.id, 200);

    const cookie = await adminCookie();
    await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', cookie)
      .send({ reasonCode: 'INVALID_REQUEST' })
      .expect(409);

    expect(await refundRows(provider.id)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('the provider panel shows the closed offer with a closure notice', async () => {
    const { category, req } = await scenario();
    const { provider, offerId, cookie } = await providerWithOffer(category.id, req.id, {
      viewed: true,
    });
    await rejectAsAdmin(req.id, 200);

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}/offers`)
      .set('Cookie', cookie)
      .expect(200);
    const offer = response.body.find((item: { id: string }) => item.id === offerId);
    expect(offer).toBeDefined();
    expect(offer.status).toBe(OfferStatus.CANCELLED);
    expect(offer.cancelledAt).not.toBeNull();
    expect(offer.closureNotice).toBe(
      'Talep yayından kaldırıldı. Harcanan teklif krediniz iade edildi.',
    );
    // The operations code stays inside the admin surfaces.
    expect(offer.creditRefundReason).toBeUndefined();
    expect(offer.refundEligibility.policyStatus).toBe('REFUNDED');
  });
});
