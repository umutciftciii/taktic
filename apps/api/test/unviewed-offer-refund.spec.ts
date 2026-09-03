import { CreditTransactionType, OfferStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCEPT_OFFER,
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
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';

/**
 * The whole refund policy, end to end.
 *
 * One rule is under test and it has two halves that must both hold: a credit
 * comes back when the authorised customer never opened the offer inside 48
 * hours, and it comes back at no other time and never twice. The cases below
 * are written from the money's point of view — every assertion is about ledger
 * rows and balances, because that is what a provider is actually paid in.
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
});

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;

async function policyFixture() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });
  const customerCookie = await loginAs(ctx.prisma, customer.id);
  const offer = await addOffer(category.id, serviceRequest.id);

  return { category, customer, customerCookie, serviceRequest, ...offer };
}

async function addOffer(categoryId: string, requestId: string) {
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId,
  });
  const cookie = await loginAs(ctx.prisma, ownerUser.id);
  await grantCredits(ctx.prisma, provider.id, STARTING_CREDITS);

  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${requestId}/offers`)
    .set('Cookie', cookie)
    .send(offerPayload())
    .expect(201);

  return { provider, cookie, offerId: created.body.id as string };
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

/** Backdates the offer past the 48-hour window. Nothing else about it changes. */
function ageBeyondWindow(offerId: string, hours = 72) {
  return ctx.prisma.offer.update({
    where: { id: offerId },
    data: { submittedAt: new Date(Date.now() - hours * 60 * 60 * 1000) },
  });
}

function refundRows(offerId?: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: {
      type: CreditTransactionType.OFFER_REFUND,
      ...(offerId ? { referenceType: 'Offer', referenceId: offerId } : {}),
    },
  });
}

function viewUrl(requestId: string, offerId: string) {
  return `/service-requests/${requestId}/offers/${offerId}/view`;
}

function actionUrl(requestId: string, offerId: string) {
  return `/service-requests/${requestId}/offers/${offerId}/action`;
}

/** The worker itself, driven directly. The scheduler only decides when. */
function worker() {
  return ctx.app.get(UnviewedOfferRefundService);
}

describe('recording that the customer viewed an offer', () => {
  it('stamps viewedAt on the first open and never moves it again', async () => {
    const { serviceRequest, offerId, customerCookie } = await policyFixture();

    const before = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(before.viewedAt).toBeNull();
    expect(before.status).toBe(OfferStatus.SUBMITTED);

    await request(ctx.server)
      .post(viewUrl(serviceRequest.id, offerId))
      .set('Cookie', customerCookie)
      .expect(201);

    const firstView = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(firstView.viewedAt).not.toBeNull();
    expect(firstView.status).toBe(OfferStatus.VIEWED);

    // Re-opening is not a second view. The recorded moment is the first one.
    await request(ctx.server)
      .post(viewUrl(serviceRequest.id, offerId))
      .set('Cookie', customerCookie)
      .expect(201);

    const secondView = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(secondView.viewedAt?.getTime()).toBe(firstView.viewedAt?.getTime());
  });

  it('records one timestamp when the customer opens it several times at once', async () => {
    const { serviceRequest, offerId, customerCookie } = await policyFixture();

    await Promise.all(
      Array.from({ length: 5 }, () =>
        request(ctx.server).post(viewUrl(serviceRequest.id, offerId)).set('Cookie', customerCookie),
      ),
    );

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.viewedAt).not.toBeNull();
  });

  it('does not count an admin reading the same screen as a view', async () => {
    const { serviceRequest, offerId } = await policyFixture();
    const admin = await adminCookie();

    // The admin is allowed to read it — support has to be able to look — and
    // that read must not cost the provider its refund.
    await request(ctx.server)
      .post(viewUrl(serviceRequest.id, offerId))
      .set('Cookie', admin)
      .expect(201);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.viewedAt).toBeNull();
    expect(stored.status).toBe(OfferStatus.SUBMITTED);
  });

  it('does not count the provider reading its own offer as a view', async () => {
    const { provider, cookie, offerId } = await policyFixture();

    await request(ctx.server)
      .get(`/providers/${provider.id}/offers/${offerId}`)
      .set('Cookie', cookie)
      .expect(200);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.viewedAt).toBeNull();
  });

  it('does not count the customer listing the request’s offers as a view', async () => {
    const { serviceRequest, offerId, customerCookie } = await policyFixture();

    await request(ctx.server)
      .get(`/service-requests/${serviceRequest.id}/offers`)
      .set('Cookie', customerCookie)
      .expect(200);

    // Reading the detail without the explicit view call does not stamp either:
    // only the view endpoint writes it.
    await request(ctx.server)
      .get(`/service-requests/${serviceRequest.id}/offers/${offerId}`)
      .set('Cookie', customerCookie)
      .expect(200);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.viewedAt).toBeNull();
  });

  it('refuses an unauthorised user and writes nothing', async () => {
    const { serviceRequest, offerId } = await policyFixture();
    const stranger = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const strangerCookie = await loginAs(ctx.prisma, stranger.id);

    await request(ctx.server)
      .post(viewUrl(serviceRequest.id, offerId))
      .set('Cookie', strangerCookie)
      .expect(403);

    await request(ctx.server).post(viewUrl(serviceRequest.id, offerId)).expect(403);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.viewedAt).toBeNull();
  });
});

describe('the 48-hour refund', () => {
  it('refunds an unviewed offer once the window has closed', async () => {
    const { provider, offerId } = await policyFixture();
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(
      STARTING_CREDITS - CATEGORY_COST,
    );

    await ageBeyondWindow(offerId);
    const result = await worker().execute();

    expect(result.refunded).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);

    const rows = await refundRows(offerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(CATEGORY_COST);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.creditRefundedTransactionId).toBe(rows[0]?.id);
    expect(stored.creditRefundedAt).not.toBeNull();
  });

  it('writes the reason as exactly UNVIEWED_OFFER_48H', async () => {
    const { offerId } = await policyFixture();
    await ageBeyondWindow(offerId);
    await worker().execute();

    const rows = await refundRows(offerId);
    expect(rows[0]?.reason).toBe('UNVIEWED_OFFER_48H');

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.creditRefundReason).toBe('UNVIEWED_OFFER_48H');

    // And the admin ledger shows it: the reason travels to the screen unchanged.
    const admin = await adminCookie();
    const detail = await request(ctx.server)
      .get(`/offers/${offerId}`)
      .set('Cookie', admin)
      .expect(200);
    expect(detail.body.creditRefundReason).toBe('UNVIEWED_OFFER_48H');
  });

  it('does not refund before the window closes', async () => {
    const { provider, offerId } = await policyFixture();

    // Old, but not old enough. A worker that rounds this the wrong way pays for
    // an offer the customer can still open.
    await ageBeyondWindow(offerId, 47);
    const result = await worker().execute();

    expect(result.refunded).toBe(0);
    expect(await refundRows(offerId)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(
      STARTING_CREDITS - CATEGORY_COST,
    );
  });

  it('still refunds when the worker runs long after the window closed', async () => {
    const { provider, offerId } = await policyFixture();

    // A month late. Being late may never turn into never.
    await ageBeyondWindow(offerId, 24 * 30);
    await worker().execute();

    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('leaves a viewed offer alone forever', async () => {
    const { provider, serviceRequest, offerId, customerCookie } = await policyFixture();

    await request(ctx.server)
      .post(viewUrl(serviceRequest.id, offerId))
      .set('Cookie', customerCookie)
      .expect(201);
    await ageBeyondWindow(offerId);

    await worker().execute();

    expect(await refundRows(offerId)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(
      STARTING_CREDITS - CATEGORY_COST,
    );
  });

  it('refuses to refund a viewed offer whatever it was rejected, expired or withdrawn into', async () => {
    for (const status of [
      OfferStatus.REJECTED,
      OfferStatus.EXPIRED,
      OfferStatus.WITHDRAWN,
      OfferStatus.CANCELLED,
    ]) {
      await resetDatabase(ctx.prisma);
      const { provider, serviceRequest, offerId, customerCookie } = await policyFixture();

      await request(ctx.server)
        .post(viewUrl(serviceRequest.id, offerId))
        .set('Cookie', customerCookie)
        .expect(201);
      await ctx.prisma.offer.update({ where: { id: offerId }, data: { status } });
      await ageBeyondWindow(offerId);

      await worker().execute();

      expect(await refundRows(offerId)).toHaveLength(0);
      expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(
        STARTING_CREDITS - CATEGORY_COST,
      );
    }
  });

  it('does not refund an accepted offer, because accepting means the customer saw it', async () => {
    const { provider, serviceRequest, offerId, customerCookie } = await policyFixture();

    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    const accepted = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(accepted.status).toBe(OfferStatus.ACCEPTED);
    expect(accepted.viewedAt).not.toBeNull();

    await ageBeyondWindow(offerId);
    await worker().execute();

    expect(await refundRows(offerId)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(
      STARTING_CREDITS - CATEGORY_COST,
    );
  });

  it('refunds an unviewed offer whatever status it ended in', async () => {
    // The point of the policy: status does not decide. An offer nobody opened
    // is paid back even though it expired, was withdrawn or was closed when a
    // rival was accepted.
    for (const status of [
      OfferStatus.EXPIRED,
      OfferStatus.WITHDRAWN,
      OfferStatus.CANCELLED,
      OfferStatus.REJECTED,
    ]) {
      await resetDatabase(ctx.prisma);
      const { provider, offerId } = await policyFixture();

      await ctx.prisma.offer.update({ where: { id: offerId }, data: { status } });
      await ageBeyondWindow(offerId);

      await worker().execute();

      expect(await refundRows(offerId)).toHaveLength(1);
      expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
    }
  });
});

describe('offers from before the policy', () => {
  it('are never refunded, however unviewed and however old', async () => {
    const { provider, offerId } = await policyFixture();

    // Exactly what a row written before this change looks like: the opt-in
    // column carries the migration's default.
    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: { unviewedRefundPolicy: false },
    });
    await ageBeyondWindow(offerId, 24 * 90);

    const result = await worker().execute();

    expect(result.processed).toBe(0);
    expect(await refundRows(offerId)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(
      STARTING_CREDITS - CATEGORY_COST,
    );
  });

  it('report no policy state at all rather than an invented one', async () => {
    const { provider, cookie, offerId } = await policyFixture();
    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: { unviewedRefundPolicy: false },
    });

    const view = await request(ctx.server)
      .get(`/providers/${provider.id}/offers/${offerId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(view.body.refundEligibility.unviewedRefundPolicy).toBe(false);
    expect(view.body.refundEligibility.policyStatus).toBeNull();
    expect(view.body.refundEligibility.policyStatusLabel).toBeNull();
    expect(view.body.refundEligibility.recommendedAction).toBe('NO_REFUND');
  });

  it('are marked in scope the moment a new offer is created', async () => {
    const { offerId } = await policyFixture();
    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.unviewedRefundPolicy).toBe(true);
  });
});

describe('paying twice is impossible', () => {
  it('produces no second ledger row when the worker runs again', async () => {
    const { provider, offerId } = await policyFixture();
    await ageBeyondWindow(offerId);

    await worker().execute();
    const second = await worker().execute();
    const third = await worker().execute();

    expect(second.refunded).toBe(0);
    expect(third.refunded).toBe(0);
    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('refunds once when several workers run at the same time', async () => {
    const { provider, offerId } = await policyFixture();
    await ageBeyondWindow(offerId);

    const runs = await Promise.all([
      worker().execute(),
      worker().execute(),
      worker().execute(),
      worker().execute(),
    ]);

    // Whatever the interleaving, exactly one run may report a refund and the
    // ledger must agree with it.
    expect(runs.reduce((sum, run) => sum + run.refunded, 0)).toBe(1);
    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);

    // No run may fail: a loser reaches the business rule, never an error.
    for (const run of runs) {
      expect(run.results.filter((entry) => entry.status === 'FAILED')).toHaveLength(0);
    }
  });

  it('is refused by the database even if every application guard is bypassed', async () => {
    const { provider, offerId } = await policyFixture();
    await ageBeyondWindow(offerId);
    await worker().execute();

    // The partial unique index is the guarantee that does not depend on any
    // code above it being right, so it is tested by going around all of it.
    await expect(
      ctx.prisma.providerCreditTransaction.create({
        data: {
          providerId: provider.id,
          type: CreditTransactionType.OFFER_REFUND,
          amount: CATEGORY_COST,
          balanceAfter: STARTING_CREDITS + CATEGORY_COST,
          reason: 'UNVIEWED_OFFER_48H',
          referenceType: 'Offer',
          referenceId: offerId,
        },
      }),
    ).rejects.toThrow();

    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('does not refund an offer a customer opens between the scan and the write', async () => {
    const { provider, serviceRequest, offerId, customerCookie } = await policyFixture();
    await ageBeyondWindow(offerId);

    // The dry run picks it up…
    const preview = await worker().dryRun();
    expect(preview.items.map((item) => item.offerId)).toContain(offerId);

    // …and then the customer opens it. The execution re-reads inside its own
    // transaction, so the view wins and no credit moves.
    await request(ctx.server)
      .post(viewUrl(serviceRequest.id, offerId))
      .set('Cookie', customerCookie)
      .expect(201);

    const result = await worker().execute();
    expect(result.refunded).toBe(0);
    expect(await refundRows(offerId)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(
      STARTING_CREDITS - CATEGORY_COST,
    );
  });
});

describe('what the provider is told', () => {
  it('shows the three policy states and nothing else', async () => {
    const { provider, cookie, serviceRequest, offerId, customerCookie } = await policyFixture();

    const awaiting = await request(ctx.server)
      .get(`/providers/${provider.id}/offers/${offerId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(awaiting.body.refundEligibility.policyStatus).toBe('AWAITING_VIEW');
    expect(awaiting.body.refundEligibility.policyStatusLabel).toBe('Görüntülenme bekleniyor');

    await request(ctx.server)
      .post(viewUrl(serviceRequest.id, offerId))
      .set('Cookie', customerCookie)
      .expect(201);

    const viewed = await request(ctx.server)
      .get(`/providers/${provider.id}/offers/${offerId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(viewed.body.refundEligibility.policyStatus).toBe('VIEWED');
    expect(viewed.body.refundEligibility.policyStatusLabel).toBe(
      'Görüntülendi — iade uygun değil',
    );

    // A second offer, this one refunded, for the third state.
    const other = await policyFixture();
    await ageBeyondWindow(other.offerId);
    await worker().execute();

    const refunded = await request(ctx.server)
      .get(`/providers/${other.provider.id}/offers/${other.offerId}`)
      .set('Cookie', other.cookie)
      .expect(200);
    expect(refunded.body.refundEligibility.policyStatus).toBe('REFUNDED');
    expect(refunded.body.refundEligibility.policyStatusLabel).toBe('Kredi iade edildi');
  });

  it('does not publish the refund verdict to the customer', async () => {
    const { serviceRequest, offerId, customerCookie } = await policyFixture();

    const detail = await request(ctx.server)
      .get(`/service-requests/${serviceRequest.id}/offers/${offerId}`)
      .set('Cookie', customerCookie)
      .expect(200);
    expect(detail.body.refundEligibility).toBeUndefined();

    const list = await request(ctx.server)
      .get(`/service-requests/${serviceRequest.id}/offers`)
      .set('Cookie', customerCookie)
      .expect(200);
    expect(list.body[0]?.refundEligibility).toBeUndefined();
  });
});

describe('the manual refund path is gone', () => {
  it('answers 404 to the endpoint that used to refund by hand', async () => {
    const { offerId } = await policyFixture();
    const admin = await adminCookie();

    await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', admin)
      .send({ reasonCode: 'ADMIN_OVERRIDE', override: true })
      .expect(404);

    expect(await refundRows(offerId)).toHaveLength(0);
  });

  it('refuses to shorten the window from the admin scan endpoint', async () => {
    const { offerId } = await policyFixture();
    await ageBeyondWindow(offerId, 2);
    const admin = await adminCookie();

    await request(ctx.server)
      .post('/offers/refund-scan/execute')
      .set('Cookie', admin)
      .send({ olderThanHours: 1 })
      .expect(400);

    expect(await refundRows(offerId)).toHaveLength(0);
  });
});
