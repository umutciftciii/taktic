import { OfferRejectionReason, OfferStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OFFER_STATUS_NOT_SETTABLE_CODE } from '../src/modules/offers/offer-transitions';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * The admin offer screen's status control, and the bypass it used to be.
 *
 * It wrote `Offer.status` directly, for all eight states, with no guard: an
 * ACCEPTED written that way left the request unmatched and the competing offers
 * open, a REJECTED skipped the "your offer was not selected" message, and a
 * WITHDRAWN filed a provider decision the provider never took. These cases pin
 * the replacement — one canonical path, the same one the customer screen uses —
 * and pin the refusals for the five states that path does not perform.
 */

let ctx: TestContext;

const CATEGORY_COST = 2;
const DISCLOSURE_VERSION = 'v1';

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  disableContactSharing();
});

afterEach(() => {
  disableContactSharing();
});

function enableContactSharing() {
  process.env.CONTACT_SHARING_ENABLED = 'true';
  process.env.CONTACT_DISCLOSURE_URL = 'https://taktic.example/aydinlatma';
  process.env.CONTACT_DISCLOSURE_VERSION = DISCLOSURE_VERSION;
}

function disableContactSharing() {
  // Explicit rather than deleted: the flag now defaults to on, so removing it
  // would turn "disabled" into "enabled" and quietly invert what these cases
  // assert.
  process.env.CONTACT_SHARING_ENABLED = 'false';
  delete process.env.CONTACT_DISCLOSURE_URL;
  delete process.env.CONTACT_DISCLOSURE_VERSION;
}

function statusUrl(offerId: string) {
  return `/offers/${offerId}/status`;
}

// The provider's account address, not the address typed into the application
// form. A profile that belongs to an account is reached at that account's
// e-mail: it is the one the platform verified, the one they sign in with, and
// the one they read the panel these messages link to from. See recipientFor in
// transactional-mail.service.ts for why the order was the other way round and
// what that cost.
function sentTo(template: string, to: string) {
  return ctx.notifications.sent.filter(
    (message) => message.template === template && message.to.toLowerCase() === to.toLowerCase(),
  );
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

async function fixture() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
    customerEmail: `sahip-${uniqueSuffix()}@example.test`,
  });

  return { category, customer, serviceRequest };
}

async function addOffer(categoryId: string, requestId: string) {
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId,
  });
  const cookie = await loginAs(ctx.prisma, ownerUser.id);
  await grantCredits(ctx.prisma, provider.id, 10);

  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${requestId}/offers`)
    .set('Cookie', cookie)
    .send(offerPayload())
    .expect(201);

  return { ownerUser, provider, cookie, offerId: created.body.id as string };
}

describe('admin offer status — rejection', () => {
  it('runs the real transition and produces exactly one message', async () => {
    const { category, serviceRequest } = await fixture();
    const target = await addOffer(category.id, serviceRequest.id);
    const bystander = await addOffer(category.id, serviceRequest.id);
    ctx.notifications.clear();

    const cookie = await adminCookie();
    const response = await request(ctx.server)
      .patch(statusUrl(target.offerId))
      .set('Cookie', cookie)
      .send({ status: OfferStatus.REJECTED })
      .expect(200);

    // The response is still the admin projection this endpoint has always
    // returned, not the narrower customer one the canonical path builds.
    expect(response.body.id).toBe(target.offerId);
    expect(response.body.status).toBe(OfferStatus.REJECTED);
    expect(response.body.provider.businessName).toBe(target.provider.businessName);
    expect(response.body.refundEligibility).toBeTruthy();

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: target.offerId } });
    expect(stored.status).toBe(OfferStatus.REJECTED);
    expect(stored.rejectedAt).not.toBeNull();
    // A hand-rejected offer carries no reason, which is what preserves its
    // refund behaviour. The admin path must not change that either.
    expect(stored.rejectionReason).toBeNull();

    expect(sentTo('offer-not-selected', target.ownerUser.email!)).toHaveLength(1);
    expect(sentTo('offer-not-selected', bystander.ownerUser.email!)).toHaveLength(0);

    // Nothing about the request moved: rejecting one offer is not a match.
    const storedRequest = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(storedRequest.status).toBe(ServiceRequestStatus.APPROVED);
    expect(storedRequest.matchedOfferId).toBeNull();
  });

  it('sends nothing a second time when the same request is repeated', async () => {
    const { category, serviceRequest } = await fixture();
    const target = await addOffer(category.id, serviceRequest.id);
    ctx.notifications.clear();

    const cookie = await adminCookie();
    const reject = () =>
      request(ctx.server)
        .patch(statusUrl(target.offerId))
        .set('Cookie', cookie)
        .send({ status: OfferStatus.REJECTED })
        .expect(200);

    await reject();
    await reject();
    await reject();

    expect(sentTo('offer-not-selected', target.ownerUser.email!)).toHaveLength(1);
    expect(
      await ctx.prisma.notificationLog.count({
        where: { template: 'offer-not-selected', providerId: target.provider.id },
      }),
    ).toBe(1);
  });

  it('refuses to reject an offer its provider already withdrew', async () => {
    const { category, serviceRequest } = await fixture();
    const target = await addOffer(category.id, serviceRequest.id);

    await request(ctx.server)
      .post(`/providers/${target.provider.id}/offers/${target.offerId}/withdraw`)
      .set('Cookie', target.cookie)
      .expect(201);

    ctx.notifications.clear();

    const cookie = await adminCookie();
    await request(ctx.server)
      .patch(statusUrl(target.offerId))
      .set('Cookie', cookie)
      .send({ status: OfferStatus.REJECTED })
      .expect(400);

    // A withdrawal is not a rejection, and the provider is not told they were
    // "not selected" for a decision they made themselves.
    expect(ctx.notifications.ofTemplate('offer-not-selected')).toHaveLength(0);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: target.offerId } });
    expect(stored.status).toBe(OfferStatus.WITHDRAWN);
    expect(stored.rejectedAt).toBeNull();
  });
});

describe('admin offer status — acceptance', () => {
  it('runs the whole cascade, exactly as a customer acceptance does', async () => {
    const { category, serviceRequest } = await fixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    const loser = await addOffer(category.id, serviceRequest.id);
    ctx.notifications.clear();

    const cookie = await adminCookie();
    await request(ctx.server)
      .patch(statusUrl(winner.offerId))
      .set('Cookie', cookie)
      .send({ status: OfferStatus.ACCEPTED })
      .expect(200);

    const storedRequest = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(storedRequest.status).toBe(ServiceRequestStatus.MATCHED);
    expect(storedRequest.matchedOfferId).toBe(winner.offerId);
    expect(storedRequest.matchedAt).not.toBeNull();

    const storedLoser = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: loser.offerId } });
    expect(storedLoser.status).toBe(OfferStatus.REJECTED);
    expect(storedLoser.rejectionReason).toBe(OfferRejectionReason.COMPETITOR_ACCEPTED);

    // The full message matrix, and nothing crossed over.
    expect(sentTo('match-customer', serviceRequest.customerEmail!)).toHaveLength(1);
    expect(sentTo('offer-accepted', winner.ownerUser.email!)).toHaveLength(1);
    expect(sentTo('offer-not-selected', loser.ownerUser.email!)).toHaveLength(1);
    expect(sentTo('offer-not-selected', winner.ownerUser.email!)).toHaveLength(0);
    expect(sentTo('offer-accepted', loser.ownerUser.email!)).toHaveLength(0);
  });

  it('writes the contact reveal when contact sharing is on', async () => {
    enableContactSharing();
    const { category, serviceRequest } = await fixture();
    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: {
        contactDisclosureVersion: DISCLOSURE_VERSION,
        contactDisclosureAcceptedAt: new Date(),
      },
    });
    const winner = await addOffer(category.id, serviceRequest.id);
    ctx.notifications.clear();

    const cookie = await adminCookie();
    await request(ctx.server)
      .patch(statusUrl(winner.offerId))
      .set('Cookie', cookie)
      .send({ status: OfferStatus.ACCEPTED })
      .expect(200);

    const reveal = await ctx.prisma.contactRevealEvent.findUnique({
      where: { requestId: serviceRequest.id },
    });
    expect(reveal?.offerId).toBe(winner.offerId);
    expect(reveal?.disclosureVersion).toBe(DISCLOSURE_VERSION);
  });

  it('refuses an acceptance whose disclosure the customer never confirmed', async () => {
    enableContactSharing();
    const { category, serviceRequest } = await fixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    ctx.notifications.clear();

    const cookie = await adminCookie();
    // The same 409 the customer path answers. The admin route cannot be the
    // way a match happens without an acknowledgement on file.
    await request(ctx.server)
      .patch(statusUrl(winner.offerId))
      .set('Cookie', cookie)
      .send({ status: OfferStatus.ACCEPTED })
      .expect(409);

    expect(ctx.notifications.sent).toHaveLength(0);
    expect(await ctx.prisma.contactRevealEvent.count()).toBe(0);

    const storedRequest = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(storedRequest.status).toBe(ServiceRequestStatus.APPROVED);
  });

  it('refuses a second acceptance on a request that already has one', async () => {
    const { category, serviceRequest } = await fixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    const other = await addOffer(category.id, serviceRequest.id);

    const cookie = await adminCookie();
    await request(ctx.server)
      .patch(statusUrl(winner.offerId))
      .set('Cookie', cookie)
      .send({ status: OfferStatus.ACCEPTED })
      .expect(200);

    ctx.notifications.clear();

    // The canonical refusal, unchanged: the request transition is the guard, so
    // the second acceptance loses against it rather than against anything this
    // endpoint added.
    await request(ctx.server)
      .patch(statusUrl(other.offerId))
      .set('Cookie', cookie)
      .send({ status: OfferStatus.ACCEPTED })
      .expect(409);

    expect(ctx.notifications.sent).toHaveLength(0);

    const storedRequest = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(storedRequest.matchedOfferId).toBe(winner.offerId);
  });

  it('does not repeat the match messages when the same acceptance is replayed', async () => {
    const { category, serviceRequest } = await fixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    ctx.notifications.clear();

    const cookie = await adminCookie();
    const accept = () =>
      request(ctx.server)
        .patch(statusUrl(winner.offerId))
        .set('Cookie', cookie)
        .send({ status: OfferStatus.ACCEPTED });

    await accept().expect(200);
    // The request is already matched, so the transition cannot happen twice.
    await accept().expect(409);

    expect(sentTo('match-customer', serviceRequest.customerEmail!)).toHaveLength(1);
    expect(sentTo('offer-accepted', winner.ownerUser.email!)).toHaveLength(1);
  });
});

describe('admin offer status — the states this endpoint does not perform', () => {
  it.each([OfferStatus.SUBMITTED, OfferStatus.EXPIRED, OfferStatus.CANCELLED])(
    'refuses %s, which nothing in the product transitions an offer into',
    async (status) => {
      const { category, serviceRequest } = await fixture();
      const target = await addOffer(category.id, serviceRequest.id);
      ctx.notifications.clear();

      const cookie = await adminCookie();
      const response = await request(ctx.server)
        .patch(statusUrl(target.offerId))
        .set('Cookie', cookie)
        .send({ status })
        .expect(400);

      expect(response.body.code).toBe(OFFER_STATUS_NOT_SETTABLE_CODE);
      expect(ctx.notifications.sent).toHaveLength(0);

      const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: target.offerId } });
      expect(stored.status).toBe(OfferStatus.SUBMITTED);
    },
  );

  it('refuses WITHDRAWN, which is the provider’s own decision', async () => {
    const { category, serviceRequest } = await fixture();
    const target = await addOffer(category.id, serviceRequest.id);
    ctx.notifications.clear();

    const cookie = await adminCookie();
    const response = await request(ctx.server)
      .patch(statusUrl(target.offerId))
      .set('Cookie', cookie)
      .send({ status: OfferStatus.WITHDRAWN })
      .expect(400);

    expect(response.body.code).toBe(OFFER_STATUS_NOT_SETTABLE_CODE);
    // In particular it does not become a rejection wearing another name.
    expect(ctx.notifications.ofTemplate('offer-not-selected')).toHaveLength(0);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: target.offerId } });
    expect(stored.status).toBe(OfferStatus.SUBMITTED);
    expect(stored.withdrawnAt).toBeNull();
  });

  it('refuses VIEWED, which would charge a provider for something nobody did', async () => {
    const { category, serviceRequest } = await fixture();
    const target = await addOffer(category.id, serviceRequest.id);

    const before = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: target.offerId } });
    expect(before.viewedAt).toBeNull();

    const cookie = await adminCookie();
    const response = await request(ctx.server)
      .patch(statusUrl(target.offerId))
      .set('Cookie', cookie)
      .send({ status: OfferStatus.VIEWED })
      .expect(400);

    expect(response.body.code).toBe(OFFER_STATUS_NOT_SETTABLE_CODE);

    // `viewedAt` is what turns an automatically refundable offer into one
    // needing manual review, so writing it here would move real money.
    const after = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: target.offerId } });
    expect(after.viewedAt).toBeNull();
    expect(after.status).toBe(OfferStatus.SUBMITTED);
  });

  it('refuses a status outside the enum before it reaches any rule', async () => {
    const { category, serviceRequest } = await fixture();
    const target = await addOffer(category.id, serviceRequest.id);

    await request(ctx.server)
      .patch(statusUrl(target.offerId))
      .set('Cookie', await adminCookie())
      .send({ status: 'BIR_SEY' })
      .expect(400);
  });

  it('answers 404 for an offer that does not exist', async () => {
    await request(ctx.server)
      .patch(statusUrl('yok-boyle-bir-teklif'))
      .set('Cookie', await adminCookie())
      .send({ status: OfferStatus.REJECTED })
      .expect(404);
  });
});

describe('admin offer status — who may call it', () => {
  it('is closed to anonymous callers, customers and providers alike', async () => {
    const { category, customer, serviceRequest } = await fixture();
    const target = await addOffer(category.id, serviceRequest.id);
    ctx.notifications.clear();

    await request(ctx.server)
      .patch(statusUrl(target.offerId))
      .send({ status: OfferStatus.REJECTED })
      .expect(401);

    // The request's own customer, who may reject this offer through their own
    // panel, still may not use the admin route.
    await request(ctx.server)
      .patch(statusUrl(target.offerId))
      .set('Cookie', await loginAs(ctx.prisma, customer.id))
      .send({ status: OfferStatus.REJECTED })
      .expect(403);

    await request(ctx.server)
      .patch(statusUrl(target.offerId))
      .set('Cookie', target.cookie)
      .send({ status: OfferStatus.REJECTED })
      .expect(403);

    expect(ctx.notifications.sent).toHaveLength(0);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: target.offerId } });
    expect(stored.status).toBe(OfferStatus.SUBMITTED);
  });
});
