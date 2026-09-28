import {
  AdminPermission,
  CreditTransactionType,
  OfferStatus,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OFFER_ACTION_NOT_ALLOWED_CODE } from '../src/modules/offers/offer-transitions';
import { REQUEST_STATUS_TRANSITION_NOT_ALLOWED_CODE } from '../src/modules/service-requests/service-requests.service';
import {
  ACCEPT_OFFER,
  createAdminWithPermissions,
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
 * API-GUARD-OFFER-001 and API-GUARD-REQUEST-001.
 *
 * Two status writes that used to check the state they were leaving by a read
 * taken before the write, or not at all:
 *
 * - an ACCEPTED offer could be rejected or shortlisted (admin PATCH
 *   /offers/:id/status and the customer's own action route alike), leaving a
 *   MATCHED request pointing at an offer that was no longer accepted;
 * - PATCH /service-requests/:id/status wrote IN_REVIEW or APPROVED over any
 *   state — a MATCHED request published again, a REJECTED one back on the
 *   market, an EXPIRED one given a new window.
 *
 * Each refusal is asserted together with the absence of every side effect the
 * transition would have had: offer rows, the match, the credit ledger, the
 * contact reveal and the notification log. The race cases do not rely on
 * timing: a test-held row lock parks the competing writers in a known order
 * (confirmed through `pg_stat_activity`) before it is let go.
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
  // Explicit, because the flag defaults to on; the accept then needs no
  // disclosure round-trip and its first statement is the request transition.
  process.env.CONTACT_SHARING_ENABLED = 'false';
});

afterEach(() => {
  process.env.CONTACT_SHARING_ENABLED = 'false';
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function superAdminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

async function marketplace() {
  const category = await createCategory(ctx.prisma, `Klima ${uniqueSuffix()}`, {
    offerCreditCost: 2,
  });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
    approvedAt: new Date(),
  });
  const customerCookie = await loginAs(ctx.prisma, customer.id);

  return { category, customer, customerCookie, serviceRequest };
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

function sentToProvider(template: string, to: string) {
  return ctx.notifications.sent.filter(
    (message) => message.template === template && message.to.toLowerCase() === to.toLowerCase(),
  );
}

function adminOfferUrl(offerId: string) {
  return `/offers/${offerId}/status`;
}

function customerActionUrl(requestId: string, offerId: string) {
  return `/service-requests/${requestId}/offers/${offerId}/action`;
}

function requestStatusUrl(requestId: string) {
  return `/service-requests/${requestId}/status`;
}

/**
 * Everything a status transition on this request could touch, in one value,
 * so "nothing changed" is a single equality rather than a list of spot checks.
 */
async function sideEffectSnapshot(requestId: string) {
  const [serviceRequest, offers, ledger, reveals, notifications] = await Promise.all([
    ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: {
        status: true,
        matchedOfferId: true,
        matchedAt: true,
        approvedAt: true,
        moderatedAt: true,
        moderationNote: true,
        cancelledAt: true,
      },
    }),
    ctx.prisma.offer.findMany({
      where: { requestId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        status: true,
        acceptedAt: true,
        rejectedAt: true,
        rejectionReason: true,
        viewedAt: true,
        refundBlockedAt: true,
        creditRefundedTransactionId: true,
      },
    }),
    ctx.prisma.providerCreditTransaction.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, type: true, amount: true },
    }),
    ctx.prisma.contactRevealEvent.count({ where: { requestId } }),
    ctx.prisma.notificationLog.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, template: true, status: true },
    }),
  ]);

  return {
    serviceRequest,
    offers,
    ledger,
    reveals,
    notifications,
    sent: ctx.notifications.sent.length,
  };
}

// ---------------------------------------------------------------------------
// controlled concurrency
// ---------------------------------------------------------------------------

/**
 * Takes `SELECT … FOR NO KEY UPDATE` on one row in a transaction the test
 * owns, and keeps it until `release()` — the lock an ordinary UPDATE needs, so
 * any writer that reaches the row parks there.
 *
 * The cases below use it as a pause point *inside* a writer's transaction, not
 * as a queue for several writers on one row. A queue would not be
 * deterministic here: the acceptance takes a KEY SHARE on its offer row (the
 * foreign-key check for `ServiceRequest.matchedOfferId`) before it updates it,
 * which makes it a member of the row's multixact, and PostgreSQL lets a member
 * skip the tuple-lock queue — so two writers parked on the same offer row can
 * wake in either order.
 */
async function holdRowLock(table: 'Offer' | 'ServiceRequest', id: string) {
  let letGo!: () => void;
  const released = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let signalLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });

  const holder = ctx.prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR NO KEY UPDATE`, id);
      signalLocked();
      await released;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );

  await locked;

  return {
    async release() {
      letGo();
      await holder;
    },
  };
}

/**
 * Resolves once a backend of this test database is parked on a lock while
 * running the statement `matches` recognises. This is what makes the arrival
 * order a fact rather than a hope: the next writer is only started after the
 * previous one is known to be queued on the row — recognised by its own SQL,
 * so no unrelated waiter (a delivery left over from an earlier case) can stand
 * in for it.
 */
async function waitUntilParked(matches: (sql: string) => boolean) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const rows = await ctx.prisma.$queryRaw<{ query: string }[]>`
      SELECT query
      FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    if (rows.some((row) => matches(row.query))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error('Timed out waiting for the writer to park on the held row');
}

const isOfferUpdate = (sql: string) => sql.startsWith('UPDATE "public"."Offer"');
const isRequestUpdate = (sql: string) => sql.startsWith('UPDATE "public"."ServiceRequest"');

/** The acceptance's cascade closing the competing offers (it names a reason). */
const cascadeOfferWrite = (sql: string) => isOfferUpdate(sql) && sql.includes('"rejectionReason"');
/** A customer or admin rejection's offer write (no reason: nothing closed it). */
const rejectOfferWrite = (sql: string) =>
  isOfferUpdate(sql) && sql.includes('"rejectedAt"') && !sql.includes('"rejectionReason"');
/** The acceptance's request transition to MATCHED, the first write of its transaction. */
const matchRequestWrite = (sql: string) => isRequestUpdate(sql) && sql.includes('"matchedAt"');
/** The moderation save's guarded status write. */
const moderationRequestWrite = (sql: string) => isRequestUpdate(sql) && !sql.includes('"matchedAt"');

/** Starts a supertest call now (it is lazy otherwise) and keeps its response. */
function start(test: request.Test) {
  return test.then((response) => response);
}

// ---------------------------------------------------------------------------
// API-GUARD-OFFER-001
// ---------------------------------------------------------------------------

describe('offer actions on an accepted offer', () => {
  async function acceptedFixture() {
    const market = await marketplace();
    const winner = await addOffer(market.category.id, market.serviceRequest.id);
    const loser = await addOffer(market.category.id, market.serviceRequest.id);

    await request(ctx.server)
      .post(customerActionUrl(market.serviceRequest.id, winner.offerId))
      .set('Cookie', market.customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    ctx.notifications.clear();
    const before = await sideEffectSnapshot(market.serviceRequest.id);
    expect(before.serviceRequest.status).toBe(ServiceRequestStatus.MATCHED);
    expect(before.serviceRequest.matchedOfferId).toBe(winner.offerId);

    return { ...market, winner, loser, before };
  }

  it.each([OfferStatus.REJECTED, OfferStatus.SHORTLISTED])(
    'admin PATCH %s on an accepted offer is a 409 and changes nothing',
    async (status) => {
      const { serviceRequest, winner, before } = await acceptedFixture();

      const response = await request(ctx.server)
        .patch(adminOfferUrl(winner.offerId))
        .set('Cookie', await superAdminCookie())
        .send({ status })
        .expect(409);

      expect(response.body.code).toBe(OFFER_ACTION_NOT_ALLOWED_CODE);
      expect(await sideEffectSnapshot(serviceRequest.id)).toEqual(before);
    },
  );

  it.each(['REJECT', 'SHORTLIST'] as const)(
    'the customer’s %s on their accepted offer is a 409 and changes nothing',
    async (action) => {
      const { serviceRequest, customerCookie, winner, before } = await acceptedFixture();

      const response = await request(ctx.server)
        .post(customerActionUrl(serviceRequest.id, winner.offerId))
        .set('Cookie', customerCookie)
        .send({ action })
        .expect(409);

      expect(response.body.code).toBe(OFFER_ACTION_NOT_ALLOWED_CODE);
      expect(await sideEffectSnapshot(serviceRequest.id)).toEqual(before);
    },
  );

  it('the same refusal holds through an ADMIN account holding only OFFERS_STATUS', async () => {
    const { serviceRequest, winner, before } = await acceptedFixture();
    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.OFFERS_STATUS]);

    // The ADMIN account type reaches the service as a non-owner; whatever the
    // service answers, the accepted offer must come out untouched.
    const response = await request(ctx.server)
      .patch(adminOfferUrl(winner.offerId))
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .send({ status: OfferStatus.REJECTED });

    expect([403, 409]).toContain(response.status);
    expect(await sideEffectSnapshot(serviceRequest.id)).toEqual(before);
  });

  it('a repeated acceptance of the accepted offer is a 409 with no second match or message', async () => {
    const { serviceRequest, customerCookie, winner, before } = await acceptedFixture();

    await request(ctx.server)
      .post(customerActionUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(409);

    await request(ctx.server)
      .patch(adminOfferUrl(winner.offerId))
      .set('Cookie', await superAdminCookie())
      .send({ status: OfferStatus.ACCEPTED })
      .expect(409);

    expect(await sideEffectSnapshot(serviceRequest.id)).toEqual(before);
  });

  it('an offer the acceptance closed cannot be shortlisted or accepted back', async () => {
    const { serviceRequest, customerCookie, loser, before } = await acceptedFixture();
    expect(before.offers.find((offer) => offer.id === loser.offerId)?.status).toBe(
      OfferStatus.REJECTED,
    );

    for (const action of ['SHORTLIST', 'ACCEPT'] as const) {
      const response = await request(ctx.server)
        .post(customerActionUrl(serviceRequest.id, loser.offerId))
        .set('Cookie', customerCookie)
        .send(action === 'ACCEPT' ? ACCEPT_OFFER : { action })
        .expect(409);
      expect(response.body.code).toBe(OFFER_ACTION_NOT_ALLOWED_CODE);
    }

    const adminResponse = await request(ctx.server)
      .patch(adminOfferUrl(loser.offerId))
      .set('Cookie', await superAdminCookie())
      .send({ status: OfferStatus.SHORTLISTED })
      .expect(409);
    expect(adminResponse.body.code).toBe(OFFER_ACTION_NOT_ALLOWED_CODE);

    expect(await sideEffectSnapshot(serviceRequest.id)).toEqual(before);
  });
});

describe('offer actions on a rejected offer', () => {
  it('a repeated rejection is a 200 that writes and sends nothing', async () => {
    const { serviceRequest, customerCookie, category } = await marketplace();
    const target = await addOffer(category.id, serviceRequest.id);

    await request(ctx.server)
      .post(customerActionUrl(serviceRequest.id, target.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'REJECT' })
      .expect(201);
    const before = await sideEffectSnapshot(serviceRequest.id);
    expect(ctx.notifications.ofTemplate('offer-not-selected')).toHaveLength(1);

    await request(ctx.server)
      .post(customerActionUrl(serviceRequest.id, target.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'REJECT' })
      .expect(201);
    await request(ctx.server)
      .patch(adminOfferUrl(target.offerId))
      .set('Cookie', await superAdminCookie())
      .send({ status: OfferStatus.REJECTED })
      .expect(200);

    // rejectedAt included: the repeat does not move the first decision's clock,
    // and the admin repeat does not add a refund block the first one lacked.
    expect(await sideEffectSnapshot(serviceRequest.id)).toEqual(before);
    expect(ctx.notifications.ofTemplate('offer-not-selected')).toHaveLength(1);
  });

  it('a rejected offer cannot be accepted, and the request stays open', async () => {
    const { serviceRequest, customerCookie, category } = await marketplace();
    const target = await addOffer(category.id, serviceRequest.id);

    await request(ctx.server)
      .patch(adminOfferUrl(target.offerId))
      .set('Cookie', await superAdminCookie())
      .send({ status: OfferStatus.REJECTED })
      .expect(200);
    const before = await sideEffectSnapshot(serviceRequest.id);

    const response = await request(ctx.server)
      .post(customerActionUrl(serviceRequest.id, target.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(409);

    expect(response.body.code).toBe(OFFER_ACTION_NOT_ALLOWED_CODE);
    expect(await sideEffectSnapshot(serviceRequest.id)).toEqual(before);
    expect(before.serviceRequest.status).toBe(ServiceRequestStatus.APPROVED);
    expect(before.serviceRequest.matchedOfferId).toBeNull();
  });
});

describe('offer actions — legitimate flows still work', () => {
  it('shortlist, then accept: the request matches and the competitor is closed', async () => {
    const { serviceRequest, customerCookie, category } = await marketplace();
    const chosen = await addOffer(category.id, serviceRequest.id);
    const other = await addOffer(category.id, serviceRequest.id);

    await request(ctx.server)
      .post(customerActionUrl(serviceRequest.id, chosen.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'SHORTLIST' })
      .expect(201);
    // Re-shortlisting a live offer stays allowed: it decides nothing.
    await request(ctx.server)
      .post(customerActionUrl(serviceRequest.id, chosen.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'SHORTLIST' })
      .expect(201);

    await request(ctx.server)
      .post(customerActionUrl(serviceRequest.id, chosen.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    const after = await sideEffectSnapshot(serviceRequest.id);
    expect(after.serviceRequest.status).toBe(ServiceRequestStatus.MATCHED);
    expect(after.serviceRequest.matchedOfferId).toBe(chosen.offerId);
    expect(after.offers.find((offer) => offer.id === chosen.offerId)?.status).toBe(
      OfferStatus.ACCEPTED,
    );
    expect(after.offers.find((offer) => offer.id === other.offerId)?.status).toBe(
      OfferStatus.REJECTED,
    );
  });
});

describe('offer actions — acceptance and rejection racing on one offer', () => {
  /**
   * The invariant either ordering must leave: the request is matched to the
   * offer exactly when the offer is ACCEPTED, and a rejected offer has no
   * match, no reveal and no match messages behind it.
   */
  async function expectConsistent(requestId: string, offerId: string) {
    const snapshot = await sideEffectSnapshot(requestId);
    const offer = snapshot.offers.find((entry) => entry.id === offerId)!;

    if (offer.status === OfferStatus.ACCEPTED) {
      expect(snapshot.serviceRequest.status).toBe(ServiceRequestStatus.MATCHED);
      expect(snapshot.serviceRequest.matchedOfferId).toBe(offerId);
      expect(offer.rejectedAt).toBeNull();
    } else {
      expect(offer.status).toBe(OfferStatus.REJECTED);
      expect(offer.acceptedAt).toBeNull();
      expect(snapshot.serviceRequest.status).toBe(ServiceRequestStatus.APPROVED);
      expect(snapshot.serviceRequest.matchedOfferId).toBeNull();
      expect(snapshot.serviceRequest.matchedAt).toBeNull();
      expect(snapshot.reveals).toBe(0);
      expect(ctx.notifications.ofTemplate('match-customer')).toHaveLength(0);
      expect(ctx.notifications.ofTemplate('offer-accepted')).toHaveLength(0);
    }

    // Nobody's credit moved either way: accepting and rejecting spend nothing
    // and refund nothing.
    expect(
      snapshot.ledger.filter((row) => row.type === CreditTransactionType.OFFER_REFUND),
    ).toHaveLength(0);

    return offer.status;
  }

  it('acceptance first: a rejection that read a live offer finds it accepted and gets a 409', async () => {
    const { serviceRequest, customerCookie, category } = await marketplace();
    const target = await addOffer(category.id, serviceRequest.id);
    const competitor = await addOffer(category.id, serviceRequest.id);
    const adminCookie = await superAdminCookie();
    ctx.notifications.clear();

    // Pause the acceptance after it has written ACCEPTED on the target and
    // MATCHED on the request, but before it commits: its cascade parks on the
    // competitor's row.
    const lock = await holdRowLock('Offer', competitor.offerId);
    const accept = start(
      request(ctx.server)
        .post(customerActionUrl(serviceRequest.id, target.offerId))
        .set('Cookie', customerCookie)
        .send(ACCEPT_OFFER),
    );
    await waitUntilParked(cascadeOfferWrite);

    // The admin rejection's pre-flight read still sees a live offer — the
    // acceptance has not committed — so only its conditional write can refuse
    // it. That write parks behind the uncommitted acceptance.
    const reject = start(
      request(ctx.server)
        .patch(adminOfferUrl(target.offerId))
        .set('Cookie', adminCookie)
        .send({ status: OfferStatus.REJECTED }),
    );
    await waitUntilParked(rejectOfferWrite);

    await lock.release();
    const [accepted, rejected] = await Promise.all([accept, reject]);

    expect(accepted.status).toBe(201);
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe(OFFER_ACTION_NOT_ALLOWED_CODE);
    expect(await expectConsistent(serviceRequest.id, target.offerId)).toBe(OfferStatus.ACCEPTED);
    // The competitor was closed by the cascade and told so; the target's
    // provider, whose offer won, was not told it lost.
    expect(sentToProvider('offer-not-selected', target.ownerUser.email!)).toHaveLength(0);
    expect(sentToProvider('offer-not-selected', competitor.ownerUser.email!)).toHaveLength(1);
    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: target.offerId } });
    expect(stored.refundBlockedAt).toBeNull();
  });

  it('rejection first: an acceptance that began before it is rolled back whole, request transition included', async () => {
    const { serviceRequest, customerCookie, category } = await marketplace();
    const target = await addOffer(category.id, serviceRequest.id);
    const adminCookie = await superAdminCookie();
    ctx.notifications.clear();

    // Pause the admin acceptance on its first write: its Serializable snapshot
    // is taken, and it still sees a live offer.
    const lock = await holdRowLock('ServiceRequest', serviceRequest.id);
    const accept = start(
      request(ctx.server)
        .patch(adminOfferUrl(target.offerId))
        .set('Cookie', adminCookie)
        .send({ status: OfferStatus.ACCEPTED }),
    );
    await waitUntilParked(matchRequestWrite);

    // Meanwhile the customer rejects the offer, start to finish.
    const rejected = await request(ctx.server)
      .post(customerActionUrl(serviceRequest.id, target.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'REJECT' });
    expect(rejected.status).toBe(201);

    // Released, the acceptance writes MATCHED and then meets an offer changed
    // since its snapshot: the whole transaction is replayed, and the replay's
    // conditional offer write matches nothing, so MATCHED is rolled back too.
    await lock.release();
    const accepted = await accept;

    expect(accepted.status).toBe(409);
    expect(accepted.body.code).toBe(OFFER_ACTION_NOT_ALLOWED_CODE);
    expect(await expectConsistent(serviceRequest.id, target.offerId)).toBe(OfferStatus.REJECTED);
    expect(ctx.notifications.ofTemplate('offer-not-selected')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// API-GUARD-REQUEST-001
// ---------------------------------------------------------------------------

describe('moderation status — IN_REVIEW and APPROVED only from open states', () => {
  async function requestIn(status: ServiceRequestStatus) {
    const category = await createCategory(ctx.prisma, `Tesisat ${uniqueSuffix()}`);
    // A provider the fan-out would reach, so a wrongly booked publish would
    // show up as notification rows.
    await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    const created = await createApprovedRequest(ctx.prisma, { categoryId: category.id });

    return ctx.prisma.serviceRequest.update({
      where: { id: created.id },
      data: {
        status,
        approvedAt: status === ServiceRequestStatus.APPROVED ? new Date() : null,
      },
    });
  }

  const refusedSources = [
    ServiceRequestStatus.DRAFT,
    ServiceRequestStatus.MATCHED,
    ServiceRequestStatus.COMPLETED,
    ServiceRequestStatus.REJECTED,
    ServiceRequestStatus.CANCELLED,
    ServiceRequestStatus.EXPIRED,
  ];
  const targets = [ServiceRequestStatus.IN_REVIEW, ServiceRequestStatus.APPROVED];

  for (const target of targets) {
    it.each(refusedSources)(`${target} from %s is a 409 with no side effect`, async (source) => {
      const serviceRequest = await requestIn(source);
      const cookie = await superAdminCookie();
      const before = await sideEffectSnapshot(serviceRequest.id);

      const response = await request(ctx.server)
        .patch(requestStatusUrl(serviceRequest.id))
        .set('Cookie', cookie)
        .send({ status: target, moderationNote: 'deneme' })
        .expect(409);

      expect(response.body.code).toBe(REQUEST_STATUS_TRANSITION_NOT_ALLOWED_CODE);
      // No status, note, moderation stamp or approval clock moved, and no
      // publish fan-out was booked.
      expect(await sideEffectSnapshot(serviceRequest.id)).toEqual(before);
    });
  }

  it.each([
    [ServiceRequestStatus.SUBMITTED, ServiceRequestStatus.IN_REVIEW, false],
    [ServiceRequestStatus.SUBMITTED, ServiceRequestStatus.APPROVED, true],
    [ServiceRequestStatus.IN_REVIEW, ServiceRequestStatus.IN_REVIEW, false],
    [ServiceRequestStatus.IN_REVIEW, ServiceRequestStatus.APPROVED, true],
    [ServiceRequestStatus.APPROVED, ServiceRequestStatus.APPROVED, false],
    [ServiceRequestStatus.APPROVED, ServiceRequestStatus.IN_REVIEW, false],
  ] as const)('%s → %s is allowed (publishes: %s)', async (source, target, publishes) => {
    const serviceRequest = await requestIn(source);

    const response = await request(ctx.server)
      .patch(requestStatusUrl(serviceRequest.id))
      .set('Cookie', await superAdminCookie())
      .send({ status: target })
      .expect(200);

    expect(response.body.status).toBe(target);
    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(target);
    expect(stored.moderatedAt).not.toBeNull();

    const published = await ctx.prisma.notificationLog.count({
      where: { requestId: serviceRequest.id, template: 'request-published' },
    });
    expect(published).toBe(publishes ? 1 : 0);
  });

  it('approving the same request twice publishes it once', async () => {
    const serviceRequest = await requestIn(ServiceRequestStatus.SUBMITTED);
    const cookie = await superAdminCookie();

    for (let i = 0; i < 3; i += 1) {
      await request(ctx.server)
        .patch(requestStatusUrl(serviceRequest.id))
        .set('Cookie', cookie)
        .send({ status: ServiceRequestStatus.APPROVED })
        .expect(200);
    }

    expect(
      await ctx.prisma.notificationLog.count({
        where: { requestId: serviceRequest.id, template: 'request-published' },
      }),
    ).toBe(1);
  });

  it('a matched request keeps its match: offers, credits and messages untouched', async () => {
    const { serviceRequest, customerCookie, category } = await marketplace();
    const winner = await addOffer(category.id, serviceRequest.id);
    await addOffer(category.id, serviceRequest.id);

    await request(ctx.server)
      .post(customerActionUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);
    ctx.notifications.clear();
    const before = await sideEffectSnapshot(serviceRequest.id);
    const cookie = await superAdminCookie();

    for (const status of targets) {
      const response = await request(ctx.server)
        .patch(requestStatusUrl(serviceRequest.id))
        .set('Cookie', cookie)
        .send({ status })
        .expect(409);
      expect(response.body.code).toBe(REQUEST_STATUS_TRANSITION_NOT_ALLOWED_CODE);
    }

    expect(await sideEffectSnapshot(serviceRequest.id)).toEqual(before);
  });

  it('holds for an ADMIN account with REQUESTS_STATUS, and stays closed to everyone else', async () => {
    const serviceRequest = await requestIn(ServiceRequestStatus.MATCHED);
    const before = await sideEffectSnapshot(serviceRequest.id);
    const { admin } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.REQUESTS_STATUS,
    ]);
    const { admin: reader } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.REQUESTS_READ,
    ]);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });

    const permitted = await request(ctx.server)
      .patch(requestStatusUrl(serviceRequest.id))
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .send({ status: ServiceRequestStatus.APPROVED })
      .expect(409);
    expect(permitted.body.code).toBe(REQUEST_STATUS_TRANSITION_NOT_ALLOWED_CODE);

    await request(ctx.server)
      .patch(requestStatusUrl(serviceRequest.id))
      .set('Cookie', await loginAs(ctx.prisma, reader.id))
      .send({ status: ServiceRequestStatus.APPROVED })
      .expect(403);
    await request(ctx.server)
      .patch(requestStatusUrl(serviceRequest.id))
      .set('Cookie', await loginAs(ctx.prisma, customer.id))
      .send({ status: ServiceRequestStatus.APPROVED })
      .expect(403);
    await request(ctx.server)
      .patch(requestStatusUrl(serviceRequest.id))
      .send({ status: ServiceRequestStatus.APPROVED })
      .expect(401);

    expect(await sideEffectSnapshot(serviceRequest.id)).toEqual(before);
  });

  it('an approval queued behind an acceptance is refused, not written over the match', async () => {
    const { serviceRequest, customerCookie, category } = await marketplace();
    const target = await addOffer(category.id, serviceRequest.id);
    const adminCookie = await superAdminCookie();
    ctx.notifications.clear();

    const lock = await holdRowLock('ServiceRequest', serviceRequest.id);

    // First in line: the acceptance, whose opening statement is the request
    // transition to MATCHED.
    const accept = start(
      request(ctx.server)
        .post(customerActionUrl(serviceRequest.id, target.offerId))
        .set('Cookie', customerCookie)
        .send(ACCEPT_OFFER),
    );
    await waitUntilParked(matchRequestWrite);

    // Second: a moderator re-saving "Onayla" from a screen that still shows
    // APPROVED. Its transaction read APPROVED before it queued.
    const approve = start(
      request(ctx.server)
        .patch(requestStatusUrl(serviceRequest.id))
        .set('Cookie', adminCookie)
        .send({ status: ServiceRequestStatus.APPROVED }),
    );
    await waitUntilParked(moderationRequestWrite);

    await lock.release();
    const [accepted, approved] = await Promise.all([accept, approve]);

    expect(accepted.status).toBe(201);
    expect(approved.status).toBe(409);
    expect(approved.body.code).toBe(REQUEST_STATUS_TRANSITION_NOT_ALLOWED_CODE);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(ServiceRequestStatus.MATCHED);
    expect(stored.matchedOfferId).toBe(target.offerId);
    expect(
      await ctx.prisma.notificationLog.count({
        where: { requestId: serviceRequest.id, template: 'request-published' },
      }),
    ).toBe(0);
  });
});
