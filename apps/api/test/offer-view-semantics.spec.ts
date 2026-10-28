import { CreditTransactionType, OfferStatus, UserRole } from '@prisma/client';
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
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';

/**
 * OFFER-VIEW-001: when a customer's look at an offer becomes `viewedAt`.
 *
 * Three writers share one rule — the detail open, the list/compare impression
 * report and the customer's own shortlist/reject/accept — and the rule is
 * about money: a stamp keeps the provider's credit spent, no stamp pays it
 * back once the offer's own refund moment has passed. So every case below
 * ends at the ledger, the way R01/R02/B-08 were judged in UAT.
 *
 * - R01: an offer the customer was never shown is refunded.
 * - R02: an offer the customer was shown (detail, list or compare) is not.
 * - B-08 / T-1: the rival a customer's acceptance closed, never shown, is.
 * - A-1: opening that rival afterwards does not take the refund back.
 * - A-2: neither does a look after the refund moment, before the worker ran.
 * - T-2: rejecting without opening counts as having seen it.
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

async function fixture(offerCount = 1) {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });
  const customerCookie = await loginAs(ctx.prisma, customer.id);
  const offers: SeededOffer[] = [];
  for (let index = 0; index < offerCount; index += 1) {
    offers.push(await addOffer(category.id, serviceRequest.id));
  }

  // Each case reads only the offers it asked for.
  return { category, customer, customerCookie, serviceRequest, offers: offers as [SeededOffer, SeededOffer] };
}

type SeededOffer = Awaited<ReturnType<typeof addOffer>>;

async function addOffer(categoryId: string, requestId: string) {
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: ownerUser.id, categoryId });
  const cookie = await loginAs(ctx.prisma, ownerUser.id);
  await grantCredits(ctx.prisma, provider.id, STARTING_CREDITS);

  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${requestId}/offers`)
    .set('Cookie', cookie)
    .send(offerPayload())
    .expect(201);

  return { provider, cookie, offerId: created.body.id as string };
}

function impressionsUrl(requestId: string) {
  return `/service-requests/${requestId}/offers/impressions`;
}

function reportImpressions(requestId: string, cookie: string | null, offerIds: string[], surface = 'LIST') {
  const call = request(ctx.server).post(impressionsUrl(requestId));
  if (cookie) {
    call.set('Cookie', cookie);
  }
  return call.send({ offerIds, surface });
}

function viewUrl(requestId: string, offerId: string) {
  return `/service-requests/${requestId}/offers/${offerId}/view`;
}

function actionUrl(requestId: string, offerId: string) {
  return `/service-requests/${requestId}/offers/${offerId}/action`;
}

function readOffer(offerId: string) {
  return ctx.prisma.offer.findUniqueOrThrow({
    where: { id: offerId },
    select: { status: true, viewedAt: true, refundBlockedAt: true },
  });
}

function refundRows(offerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: { type: CreditTransactionType.OFFER_REFUND, referenceType: 'Offer', referenceId: offerId },
  });
}

function ageBeyondWindow(offerId: string, hours = 72) {
  return backdateOfferSubmission(ctx.prisma, offerId, hours);
}

function worker() {
  return ctx.app.get(UnviewedOfferRefundService);
}

describe('the list/compare impression report', () => {
  it('stamps only the reported offer and keeps its credit spent (R02-L); the unreported one is refunded (R01-L)', async () => {
    const { serviceRequest, customerCookie, offers } = await fixture(2);
    const [shown, offscreen] = offers;

    const response = await reportImpressions(serviceRequest.id, customerCookie, [shown.offerId]).expect(200);
    expect(response.body).toEqual({ recorded: 1 });

    const stamped = await readOffer(shown.offerId);
    expect(stamped.viewedAt).not.toBeNull();
    expect(stamped.status).toBe(OfferStatus.VIEWED);
    const untouched = await readOffer(offscreen.offerId);
    expect(untouched.viewedAt).toBeNull();
    expect(untouched.status).toBe(OfferStatus.SUBMITTED);

    await ageBeyondWindow(shown.offerId);
    await ageBeyondWindow(offscreen.offerId);
    const result = await worker().execute();

    expect(result.refunded).toBe(1);
    expect(await refundRows(shown.offerId)).toHaveLength(0);
    expect(await refundRows(offscreen.offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, shown.provider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
    expect(await currentCreditBalance(ctx.prisma, offscreen.provider.id)).toBe(STARTING_CREDITS);
  });

  it('counts the comparison table the same as the list (R02-C)', async () => {
    const { serviceRequest, customerCookie, offers } = await fixture(1);

    await reportImpressions(serviceRequest.id, customerCookie, [offers[0].offerId], 'COMPARE').expect(200);
    await ageBeyondWindow(offers[0].offerId);
    await worker().execute();

    expect((await readOffer(offers[0].offerId)).viewedAt).not.toBeNull();
    expect(await refundRows(offers[0].offerId)).toHaveLength(0);
  });

  it('keeps the first timestamp across repeats and simultaneous reports', async () => {
    const { serviceRequest, customerCookie, offers } = await fixture(1);
    const { offerId } = offers[0];

    const answers = await Promise.all(
      Array.from({ length: 5 }, () => reportImpressions(serviceRequest.id, customerCookie, [offerId])),
    );
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200]);
    expect(answers.reduce((sum, answer) => sum + (answer.body.recorded as number), 0)).toBe(1);

    const first = (await readOffer(offerId)).viewedAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await reportImpressions(serviceRequest.id, customerCookie, [offerId, offerId]).expect(200, { recorded: 0 });
    await request(ctx.server).post(viewUrl(serviceRequest.id, offerId)).set('Cookie', customerCookie).expect(201);

    expect((await readOffer(offerId)).viewedAt).toEqual(first);
  });

  it('skips offers of another request and unknown ids without saying which', async () => {
    const { serviceRequest, customerCookie, category } = await fixture(0);
    const other = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: (await createUser(ctx.prisma, { role: UserRole.CUSTOMER })).id,
    });
    const foreign = await addOffer(category.id, other.id);

    await reportImpressions(serviceRequest.id, customerCookie, [foreign.offerId, 'cl-not-an-offer']).expect(200, {
      recorded: 0,
    });
    expect((await readOffer(foreign.offerId)).viewedAt).toBeNull();
  });

  it('never stamps an offer that is no longer a live choice', async () => {
    for (const status of [
      OfferStatus.REJECTED,
      OfferStatus.ACCEPTED,
      OfferStatus.WITHDRAWN,
      OfferStatus.CANCELLED,
      OfferStatus.EXPIRED,
    ]) {
      await resetDatabase(ctx.prisma);
      const { serviceRequest, customerCookie, offers } = await fixture(1);
      await ctx.prisma.offer.update({ where: { id: offers[0].offerId }, data: { status } });

      await reportImpressions(serviceRequest.id, customerCookie, [offers[0].offerId]).expect(200, { recorded: 0 });
      expect((await readOffer(offers[0].offerId)).viewedAt, status).toBeNull();
    }
  });

  it('records nothing for an admin, and refuses everyone who is not the request’s customer', async () => {
    const { serviceRequest, offers } = await fixture(1);
    const { offerId, cookie: providerCookie } = offers[0];
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const stranger = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });

    await reportImpressions(serviceRequest.id, await loginAs(ctx.prisma, admin.id), [offerId]).expect(200, {
      recorded: 0,
    });
    await reportImpressions(serviceRequest.id, providerCookie, [offerId]).expect(403);
    await reportImpressions(serviceRequest.id, await loginAs(ctx.prisma, stranger.id), [offerId]).expect(403);
    await reportImpressions(serviceRequest.id, null, [offerId]).expect(401);

    expect((await readOffer(offerId)).viewedAt).toBeNull();
  });

  it('refuses an empty, oversized or unnamed report', async () => {
    const { serviceRequest, customerCookie, offers } = await fixture(1);

    await reportImpressions(serviceRequest.id, customerCookie, []).expect(400);
    await reportImpressions(
      serviceRequest.id,
      customerCookie,
      Array.from({ length: 51 }, (_, index) => `offer-${index}`),
    ).expect(400);
    await reportImpressions(serviceRequest.id, customerCookie, [offers[0].offerId], 'DETAIL').expect(400);

    expect((await readOffer(offers[0].offerId)).viewedAt).toBeNull();
  });
});

describe('a look after the offer’s refund moment (A-2)', () => {
  it('does not stamp from the list, the detail or a shortlist, and the worker pays the refund', async () => {
    const { serviceRequest, customerCookie, offers } = await fixture(1);
    const { offerId, provider } = offers[0];
    await ageBeyondWindow(offerId);

    await reportImpressions(serviceRequest.id, customerCookie, [offerId]).expect(200, { recorded: 0 });
    await request(ctx.server).post(viewUrl(serviceRequest.id, offerId)).set('Cookie', customerCookie).expect(201);
    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'SHORTLIST' })
      .expect(201);

    const after = await readOffer(offerId);
    expect(after.viewedAt).toBeNull();
    expect(after.status).toBe(OfferStatus.SHORTLISTED);

    expect((await worker().execute()).refunded).toBe(1);
    expect(await refundRows(offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS);
  });

  it('does not stamp a rejection made after the refund moment', async () => {
    const { serviceRequest, customerCookie, offers } = await fixture(1);
    const { offerId } = offers[0];
    await ageBeyondWindow(offerId);

    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'REJECT' })
      .expect(201);

    const rejected = await readOffer(offerId);
    expect(rejected.status).toBe(OfferStatus.REJECTED);
    expect(rejected.viewedAt).toBeNull();
    expect((await worker().execute()).refunded).toBe(1);
  });

  it('still stamps an acceptance, so the worker never refunds the match it produced', async () => {
    const { serviceRequest, customerCookie, offers } = await fixture(1);
    const { offerId, provider } = offers[0];
    await ageBeyondWindow(offerId);

    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    const accepted = await readOffer(offerId);
    expect(accepted.status).toBe(OfferStatus.ACCEPTED);
    expect(accepted.viewedAt).not.toBeNull();
    expect((await worker().execute()).refunded).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
  });
});

describe('the customer’s own decisions', () => {
  it('a rejection without opening the offer counts as having seen it (T-2)', async () => {
    const { serviceRequest, customerCookie, offers } = await fixture(1);
    const { offerId, provider } = offers[0];

    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'REJECT' })
      .expect(201);

    const rejected = await readOffer(offerId);
    expect(rejected.status).toBe(OfferStatus.REJECTED);
    expect(rejected.viewedAt).not.toBeNull();
    expect(rejected.refundBlockedAt).toBeNull();

    await ageBeyondWindow(offerId);
    expect((await worker().execute()).refunded).toBe(0);
    expect(await refundRows(offerId)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
  });

  it('an acceptance keeps the first view on file rather than moving it', async () => {
    const { serviceRequest, customerCookie, offers } = await fixture(1);
    const { offerId } = offers[0];

    await request(ctx.server).post(viewUrl(serviceRequest.id, offerId)).set('Cookie', customerCookie).expect(201);
    const firstView = (await readOffer(offerId)).viewedAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    expect((await readOffer(offerId)).viewedAt).toEqual(firstView);
  });
});

describe('the rival a customer’s acceptance closed (B-08)', () => {
  it('is refunded when it was never shown (T-1), and opening it afterwards changes nothing (A-1)', async () => {
    const { serviceRequest, customerCookie, offers } = await fixture(2);
    const [winner, rival] = offers;

    // The customer opens and accepts the winner only — the customer path, not
    // an administrator's, so no refund block is written on anybody.
    await request(ctx.server).post(viewUrl(serviceRequest.id, winner.offerId)).set('Cookie', customerCookie).expect(201);
    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    const closed = await readOffer(rival.offerId);
    expect(closed.status).toBe(OfferStatus.REJECTED);
    expect(closed.viewedAt).toBeNull();
    expect(closed.refundBlockedAt).toBeNull();

    // A-1: the customer comes back and opens the closed rival, from its
    // detail and from the list. History, not a view.
    await request(ctx.server).post(viewUrl(serviceRequest.id, rival.offerId)).set('Cookie', customerCookie).expect(201);
    await reportImpressions(serviceRequest.id, customerCookie, [rival.offerId]).expect(200, { recorded: 0 });
    expect((await readOffer(rival.offerId)).viewedAt).toBeNull();

    await ageBeyondWindow(winner.offerId);
    await ageBeyondWindow(rival.offerId);
    const result = await worker().execute();

    expect(result.refunded).toBe(1);
    expect(await refundRows(rival.offerId)).toHaveLength(1);
    expect(await refundRows(winner.offerId)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, rival.provider.id)).toBe(STARTING_CREDITS);
    expect(await currentCreditBalance(ctx.prisma, winner.provider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);

    // A second run pays nothing more.
    expect((await worker().execute()).refunded).toBe(0);
    expect(await refundRows(rival.offerId)).toHaveLength(1);
  });

  it('is not refunded when the list had already shown it before the acceptance (B-08-L)', async () => {
    const { serviceRequest, customerCookie, offers } = await fixture(2);
    const [winner, rival] = offers;

    await reportImpressions(serviceRequest.id, customerCookie, [winner.offerId, rival.offerId]).expect(200, {
      recorded: 2,
    });
    await request(ctx.server)
      .post(actionUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    await ageBeyondWindow(rival.offerId);
    expect((await worker().execute()).refunded).toBe(0);
    expect(await refundRows(rival.offerId)).toHaveLength(0);
  });
});
