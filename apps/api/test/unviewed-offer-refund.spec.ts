import {
  CreditTransactionType,
  OfferRefundBlockReason,
  OfferStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCEPT_OFFER,
  backdateOfferSubmission,
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
import { readContactSharingConfig } from '../src/modules/contact-sharing/contact-sharing.config';
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';

/**
 * The whole refund policy, end to end.
 *
 * One rule is under test and it has two halves that must both hold: a credit
 * comes back when the authorised customer never opened the offer inside the
 * window that offer was created with, and it comes back at no other time and
 * never twice. The cases below
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

/** Backdates an offer past its own refund moment. See the harness helper. */
function ageBeyondWindow(offerId: string, hours = 72) {
  return backdateOfferSubmission(ctx.prisma, offerId, hours);
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

describe('an administrator deciding on the customer’s behalf', () => {
  /**
   * The admin status control routes onto the same method the customer screen
   * uses, so this is the production path an operator actually takes.
   */
  function adminActionUrl(offerId: string) {
    return `/offers/${offerId}/status`;
  }

  /**
   * Contact sharing is on by default, and accepting an offer is what opens the
   * two parties' details — so the API refuses an accept unless the customer's
   * acknowledgement of the current disclosure is already on file. An admin
   * accepting on their behalf is no exception, which is the point: these cases
   * are about the refund, so the consent they would otherwise trip over is
   * recorded up front.
   */
  function recordDisclosureAcceptance(requestId: string) {
    const contactSharing = readContactSharingConfig();

    return ctx.prisma.serviceRequest.update({
      where: { id: requestId },
      data: {
        // Null when sharing is off, which is exactly right: with the flag down
        // the accept consults none of this, so there is no version to record.
        contactDisclosureVersion: contactSharing.enabled ? contactSharing.disclosureVersion : null,
        contactDisclosureAcceptedAt: new Date(),
      },
    });
  }

  for (const [action, status] of [
    ['accept', OfferStatus.ACCEPTED],
    ['reject', OfferStatus.REJECTED],
  ] as const) {
    it(`records an admin ${action} as a refund block, without faking a view`, async () => {
      await resetDatabase(ctx.prisma);
      const { provider, serviceRequest, offerId } = await policyFixture();
      await recordDisclosureAcceptance(serviceRequest.id);
      const admin = await adminCookie();

      await request(ctx.server)
        .patch(adminActionUrl(offerId))
        .set('Cookie', admin)
        .send({ status })
        .expect(200);

      const decided = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
      // The whole point of the separate column: the customer never opened this
      // offer and the database must not claim otherwise.
      expect(decided.viewedAt).toBeNull();
      expect(decided.refundBlockedAt).not.toBeNull();
      expect(decided.refundBlockedReason).toBe(OfferRefundBlockReason.ADMIN_CUSTOMER_DECISION);

      await ageBeyondWindow(offerId);
      const result = await worker().execute();

      expect(result.refunded).toBe(0);
      expect(await refundRows(offerId)).toHaveLength(0);
      expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(
        STARTING_CREDITS - CATEGORY_COST,
      );
    });
  }

  it('tells the provider a decision was recorded, not that it was viewed', async () => {
    const { provider, cookie, offerId } = await policyFixture();
    const admin = await adminCookie();

    await request(ctx.server)
      .patch(adminActionUrl(offerId))
      .set('Cookie', admin)
      .send({ status: OfferStatus.REJECTED })
      .expect(200);

    const view = await request(ctx.server)
      .get(`/providers/${provider.id}/offers/${offerId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(view.body.refundEligibility.policyStatus).toBe('ADMIN_DECISION');
    expect(view.body.refundEligibility.policyStatusLabel).toBe(
      'Müşteri kararı kaydedildi — iade uygun değil',
    );
    expect(view.body.refundEligibility.recommendedAction).toBe('NO_REFUND');
  });

  it('changes nothing when an admin only reads the offer', async () => {
    const { provider, serviceRequest, offerId } = await policyFixture();
    const admin = await adminCookie();

    await request(ctx.server)
      .post(viewUrl(serviceRequest.id, offerId))
      .set('Cookie', admin)
      .expect(201);
    await request(ctx.server).get(`/offers/${offerId}`).set('Cookie', admin).expect(200);
    await request(ctx.server).get('/offers').set('Cookie', admin).expect(200);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.viewedAt).toBeNull();
    expect(stored.refundBlockedAt).toBeNull();

    // And the refund still happens, because nothing was decided.
    await ageBeyondWindow(offerId);
    await worker().execute();

    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('does not block on an admin shortlist, which decides nothing', async () => {
    const { provider, offerId } = await policyFixture();
    const admin = await adminCookie();

    await request(ctx.server)
      .patch(adminActionUrl(offerId))
      .set('Cookie', admin)
      .send({ status: OfferStatus.SHORTLISTED })
      .expect(200);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(stored.refundBlockedAt).toBeNull();

    await ageBeyondWindow(offerId);
    await worker().execute();

    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('keeps reading as viewed when the customer had already opened it', async () => {
    const { provider, cookie, serviceRequest, offerId, customerCookie } = await policyFixture();

    await request(ctx.server)
      .post(viewUrl(serviceRequest.id, offerId))
      .set('Cookie', customerCookie)
      .expect(201);

    const admin = await adminCookie();
    await request(ctx.server)
      .patch(adminActionUrl(offerId))
      .set('Cookie', admin)
      .send({ status: OfferStatus.REJECTED })
      .expect(200);

    const view = await request(ctx.server)
      .get(`/providers/${provider.id}/offers/${offerId}`)
      .set('Cookie', cookie)
      .expect(200);
    // The customer really did look. A later admin decision changes the outcome
    // for nobody, so it must not change what the provider is told either.
    expect(view.body.refundEligibility.policyStatus).toBe('VIEWED');

    await ageBeyondWindow(offerId);
    await worker().execute();
    expect(await refundRows(offerId)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(
      STARTING_CREDITS - CATEGORY_COST,
    );
  });

  it('does not block the losing offers a cascade closed', async () => {
    // Only the offer that was decided on is settled. The rivals the accept
    // closed were never opened and were never decided on individually.
    const { category, serviceRequest, offerId } = await policyFixture();
    const loser = await addOffer(category.id, serviceRequest.id);
    await recordDisclosureAcceptance(serviceRequest.id);
    const admin = await adminCookie();

    await request(ctx.server)
      .patch(adminActionUrl(offerId))
      .set('Cookie', admin)
      .send({ status: OfferStatus.ACCEPTED })
      .expect(200);

    const closed = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: loser.offerId } });
    expect(closed.status).toBe(OfferStatus.REJECTED);
    expect(closed.refundBlockedAt).toBeNull();

    await ageBeyondWindow(loser.offerId);
    await worker().execute();

    expect(await refundRows(loser.offerId)).toHaveLength(1);
    expect(await refundRows(offerId)).toHaveLength(0);
  });
});

describe('the manual refund is an operations tool', () => {
  it('refunds by hand, records an audit row, and files its own ledger reason', async () => {
    const { provider, offerId } = await policyFixture();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminSession = await loginAs(ctx.prisma, admin.id);

    // Freshly submitted and never viewed: the automatic rule would not touch
    // this offer for another two days. The operations tool does not ask it.
    const response = await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', adminSession)
      .send({ reasonCode: 'INVALID_REQUEST', note: 'Dahili not: talep sahte çıktı' })
      .expect(201);

    expect(response.body.balance).toBe(STARTING_CREDITS);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);

    const rows = await refundRows(offerId);
    expect(rows).toHaveLength(1);
    // Its own reason, never the worker's.
    expect(rows[0]?.reason).toBe('MANUAL_ADMIN_REFUND:INVALID_REQUEST');
    expect(rows[0]?.reason).not.toContain('UNVIEWED_OFFER_48H');
    expect(rows[0]?.createdById).toBe(admin.id);

    const audit = await ctx.prisma.manualOfferRefundAudit.findUniqueOrThrow({
      where: { offerId },
    });
    expect(audit.performedById).toBe(admin.id);
    expect(audit.providerId).toBe(provider.id);
    expect(audit.creditAmount).toBe(CATEGORY_COST);
    expect(audit.reasonCode).toBe('INVALID_REQUEST');
    expect(audit.note).toBe('Dahili not: talep sahte çıktı');
    expect(audit.creditTransactionId).toBe(rows[0]?.id);
    expect(audit.createdAt).toBeInstanceOf(Date);
  });

  it('refunds an offer from before the policy, which the worker never would', async () => {
    const { provider, offerId } = await policyFixture();
    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: { unviewedRefundPolicy: false },
    });
    const adminSession = await adminCookie();

    await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', adminSession)
      .send({ reasonCode: 'PLATFORM_ERROR' })
      .expect(201);

    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('is refused to everyone but a SUPER_ADMIN', async () => {
    const { provider, cookie, offerId, customerCookie } = await policyFixture();

    for (const [label, session] of [
      ['provider', cookie],
      ['customer', customerCookie],
    ] as const) {
      await request(ctx.server)
        .post(`/offers/${offerId}/refund-credit`)
        .set('Cookie', session)
        .send({ reasonCode: 'OTHER' })
        .expect(403);
      expect(label).toBeTruthy();
    }

    await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .send({ reasonCode: 'OTHER' })
      .expect(401);

    expect(await refundRows(offerId)).toHaveLength(0);
    expect(await ctx.prisma.manualOfferRefundAudit.count()).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(
      STARTING_CREDITS - CATEGORY_COST,
    );
  });

  it('refuses a reason code outside the operations list', async () => {
    const { offerId } = await policyFixture();
    const adminSession = await adminCookie();

    // Including the worker's own code: that reason belongs to the policy.
    for (const reasonCode of ['UNVIEWED_OFFER_48H', 'ADMIN_OVERRIDE', '']) {
      await request(ctx.server)
        .post(`/offers/${offerId}/refund-credit`)
        .set('Cookie', adminSession)
        .send({ reasonCode })
        .expect(400);
    }

    expect(await refundRows(offerId)).toHaveLength(0);
  });

  it('never leaks the operations reason to the provider or the customer', async () => {
    const { provider, cookie, serviceRequest, offerId, customerCookie } = await policyFixture();
    const adminSession = await adminCookie();

    await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', adminSession)
      .send({ reasonCode: 'CUSTOMER_UNREACHABLE', note: 'Dahili not' })
      .expect(201);

    const providerView = await request(ctx.server)
      .get(`/providers/${provider.id}/offers/${offerId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(JSON.stringify(providerView.body)).not.toContain('CUSTOMER_UNREACHABLE');
    expect(JSON.stringify(providerView.body)).not.toContain('Dahili not');
    // What the provider does get is the fact and its date.
    expect(providerView.body.refundEligibility.policyStatus).toBe('REFUNDED');
    expect(providerView.body.refundEligibility.policyStatusLabel).toBe('Kredi iade edildi');
    expect(providerView.body.creditRefundedAt).not.toBeNull();

    const customerView = await request(ctx.server)
      .get(`/service-requests/${serviceRequest.id}/offers/${offerId}`)
      .set('Cookie', customerCookie)
      .expect(200);
    expect(JSON.stringify(customerView.body)).not.toContain('CUSTOMER_UNREACHABLE');
    expect(JSON.stringify(customerView.body)).not.toContain('Dahili not');
  });

  it('leaves the worker nothing to refund afterwards', async () => {
    const { provider, offerId } = await policyFixture();
    const adminSession = await adminCookie();

    await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', adminSession)
      .send({ reasonCode: 'DUPLICATE_REQUEST' })
      .expect(201);

    await ageBeyondWindow(offerId);
    const result = await worker().execute();

    expect(result.refunded).toBe(0);
    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('cannot add a second credit after the worker has already refunded', async () => {
    const { provider, offerId } = await policyFixture();
    await ageBeyondWindow(offerId);
    await worker().execute();
    expect(await refundRows(offerId)).toHaveLength(1);

    const adminSession = await adminCookie();
    await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', adminSession)
      .send({ reasonCode: 'GOODWILL' })
      .expect(409);

    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await ctx.prisma.manualOfferRefundAudit.count()).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('pays once when two administrators press the button together', async () => {
    const { provider, offerId } = await policyFixture();
    const adminSession = await adminCookie();

    const results = await Promise.all([
      request(ctx.server)
        .post(`/offers/${offerId}/refund-credit`)
        .set('Cookie', adminSession)
        .send({ reasonCode: 'OTHER' }),
      request(ctx.server)
        .post(`/offers/${offerId}/refund-credit`)
        .set('Cookie', adminSession)
        .send({ reasonCode: 'OTHER' }),
    ]);

    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    // The loser must reach the business rule, never a leaked serialization
    // abort or a 500.
    expect(results.find((result) => result.status !== 201)?.status).toBe(409);

    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await ctx.prisma.manualOfferRefundAudit.count()).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('pays once when a manual refund races the worker', async () => {
    const { provider, offerId } = await policyFixture();
    await ageBeyondWindow(offerId);
    const adminSession = await adminCookie();

    const [manual] = await Promise.all([
      request(ctx.server)
        .post(`/offers/${offerId}/refund-credit`)
        .set('Cookie', adminSession)
        .send({ reasonCode: 'OTHER' }),
      worker().execute(),
      worker().execute(),
    ]);

    expect([201, 409]).toContain(manual.status);
    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });
});

describe('the automatic window cannot be shortened', () => {
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

describe('the provider is told, exactly once, that their credit came back', () => {
  function refundMessages() {
    return ctx.notifications.ofTemplate('credit-refunded');
  }

  function notificationRows() {
    return ctx.prisma.notificationLog.findMany({ where: { template: 'credit-refunded' } });
  }

  it('sends one notification after an automatic refund, and none on a re-run', async () => {
    const { provider, offerId, serviceRequest } = await policyFixture();
    ctx.notifications.clear();
    await ageBeyondWindow(offerId);

    await worker().execute();

    const messages = refundMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.subject).toContain('Krediniz iade edildi');
    expect(messages[0]!.data?.refundedCredits).toBe(String(CATEGORY_COST));
    // Something that identifies the work the credit was spent on, and a link
    // that opens the provider's own credits screen.
    expect(messages[0]!.data?.requestNumber).toBeTruthy();
    expect(messages[0]!.data?.creditsUrl).toContain(`/providers/${provider.id}/credits`);
    void serviceRequest;

    // The scan is safe to run again: there is nothing left to refund, so there
    // is nothing left to say.
    await worker().execute();
    await worker().execute();

    expect(refundMessages()).toHaveLength(1);
    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await notificationRows()).toHaveLength(1);
  });

  it('sends one notification after a manual refund, and none on a second attempt', async () => {
    const { provider, offerId } = await policyFixture();
    ctx.notifications.clear();
    const adminSession = await adminCookie();

    await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', adminSession)
      .send({ reasonCode: 'CUSTOMER_UNREACHABLE', note: 'Müşteriye üç kez ulaşılamadı' })
      .expect(201);

    expect(refundMessages()).toHaveLength(1);

    await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', adminSession)
      .send({ reasonCode: 'CUSTOMER_UNREACHABLE' })
      .expect(409);

    expect(refundMessages()).toHaveLength(1);
    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await notificationRows()).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('never puts the operations reason or the admin note in front of the provider', async () => {
    const { offerId } = await policyFixture();
    ctx.notifications.clear();
    const adminSession = await adminCookie();

    await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', adminSession)
      .send({ reasonCode: 'PLATFORM_ERROR', note: 'Ödeme sağlayıcısı iki kez ücretlendirdi' })
      .expect(201);

    const message = refundMessages()[0]!;
    const rendered = JSON.stringify(message);

    expect(message.data?.refundReason).toBe('Yönetici kredi iadesi');
    expect(rendered).not.toContain('PLATFORM_ERROR');
    expect(rendered).not.toContain('MANUAL_ADMIN_REFUND');
    expect(rendered).not.toContain('Ödeme sağlayıcısı iki kez ücretlendirdi');
  });

  it('sends nothing to the customer', async () => {
    const { offerId, customer } = await policyFixture();
    ctx.notifications.clear();
    await ageBeyondWindow(offerId);

    await worker().execute();

    // The credit belongs to the provider; the customer has no part in it.
    expect(ctx.notifications.sent.map((message) => message.to)).not.toContain(customer.email);
    expect(refundMessages()).toHaveLength(1);
  });

  it('does not notify when the refund transaction rolled back', async () => {
    const { offerId } = await policyFixture();
    // Viewed, so the worker's re-read inside the transaction refuses it and
    // nothing commits.
    await ageBeyondWindow(offerId);
    await ctx.prisma.offer.update({ where: { id: offerId }, data: { viewedAt: new Date() } });
    ctx.notifications.clear();

    const result = await worker().execute();

    expect(result.refunded).toBe(0);
    expect(refundMessages()).toHaveLength(0);
    expect(await notificationRows()).toHaveLength(0);
  });
});
