import { MatchRoundStatus, OfferStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addIsoDays, todayIsoDay } from '../src/common/date-only';
import { OFFER_SCHEDULE_MAX_DAYS } from '../src/common/offer-schedule';
import { roundDedupeSuffix, roundNumberFromDedupeSegment } from '../src/modules/match-rounds/match-round-dedupe';
import { claimRoundReminder } from '../src/modules/match-rounds/match-round-transitions';
import { TransactionalMailService } from '../src/modules/notifications/transactional-mail.service';
import { RequestExpiryService } from '../src/modules/request-lifecycle/request-expiry.service';
import { RequestReminderService } from '../src/modules/request-lifecycle/request-reminder.service';
import { requestReminderCutoff } from '../src/modules/request-lifecycle/request-lifecycle.constants';
import {
  ACCEPT_OFFER,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  daysAgo,
  grantCredits,
  loginAs,
  offerPayload,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';
import { roundInconsistencies } from './match-round-consistency';
import { roundOneId } from './match-round-fixtures';

/**
 * REL-002 Faz 2 — the round is the matching core's authority, and the core is
 * already safe for a second round.
 *
 * Faz 2 opens no second round itself (the customer's service-issue reopen is
 * Faz 3). These cases stage one in raw SQL — the shape Faz 3's transition will
 * produce: Round 1 ended (its winner still ACCEPTED, its reveal and thread
 * still on file), Round 2 OPEN and current, the request APPROVED again with an
 * empty projection — and prove that every reader and writer treats Round 2 as
 * the only live round: per-round uniques, stale-round refusals, discovery,
 * contact, messaging, work scope, cancel scope, the round clock and the
 * round-aware notification keys. The concurrency cases need no second round:
 * each race has exactly one winner and the loser gets a 409 or nothing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetAuthThrottle(ctx.app);
  ctx.notifications.clear();
  delete process.env.CONTACT_SHARING_ENABLED;
  delete process.env.CONTACT_DISCLOSURE_URL;
  delete process.env.CONTACT_DISCLOSURE_VERSION;
  delete process.env.REQUIRE_PHONE_VERIFICATION;
});

afterEach(async () => {
  expect(await roundInconsistencies(ctx.prisma)).toEqual([]);
});

// ── scenario builders ────────────────────────────────────────────────────────

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

async function liveRequest() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
  const created = await request(ctx.server)
    .post('/service-requests')
    .send(serviceRequestPayload(category.slug))
    .expect(201);
  const requestId = created.body.id as string;
  await request(ctx.server)
    .patch(`/service-requests/${requestId}/status`)
    .set('Cookie', await adminCookie())
    .send({ status: ServiceRequestStatus.APPROVED })
    .expect(200);
  const { customerId } = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
  return { category, requestId, customerCookie: await loginAs(ctx.prisma, customerId!) };
}

type Party = { provider: { id: string }; userId: string; cookie: string };

async function addProvider(categoryId: string): Promise<Party> {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: user.id, categoryId });
  await grantCredits(ctx.prisma, provider.id, 20);
  return { provider, userId: user.id, cookie: await loginAs(ctx.prisma, user.id) };
}

function postOffer(party: Party, requestId: string, body: Record<string, unknown> = offerPayload()) {
  return request(ctx.server)
    .post(`/providers/${party.provider.id}/requests/${requestId}/offers`)
    .set('Cookie', party.cookie)
    .send(body);
}

async function submitOffer(party: Party, requestId: string) {
  const response = await postOffer(party, requestId).expect(201);
  return response.body.id as string;
}

function act(requestId: string, offerId: string, cookie: string, body: Record<string, unknown>) {
  return request(ctx.server)
    .post(`/service-requests/${requestId}/offers/${offerId}/action`)
    .set('Cookie', cookie)
    .send(body);
}

async function currentRound(requestId: string) {
  const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { currentRoundId: true, currentRound: true },
  });
  return row.currentRound;
}

/**
 * Stages Round 2 the way Faz 3's reopen will leave it: Round 1 ends (a matched
 * round CANCELLED with its winner kept — the nearest terminal state Faz 2's
 * enum has to Faz 3's FAILED; an open one EXPIRED), Round 2 opens published
 * at `publishedAt`, and the request is APPROVED again with no match.
 */
async function openSecondRound(requestId: string, publishedAt: Date = new Date()) {
  const r1 = await currentRound(requestId);
  const roundTwoId = `mr2_${requestId}`;
  const now = new Date();
  await ctx.prisma.$transaction(async (tx) => {
    if (r1.status === MatchRoundStatus.MATCHED) {
      await tx.serviceRequestMatchRound.update({
        where: { id: r1.id },
        data: { status: MatchRoundStatus.CANCELLED, cancelledAt: now },
      });
    } else {
      await tx.serviceRequestMatchRound.update({
        where: { id: r1.id },
        data: { status: MatchRoundStatus.EXPIRED, expiredAt: now },
      });
    }
    await tx.serviceRequestMatchRound.create({
      data: {
        id: roundTwoId,
        requestId,
        roundNumber: 2,
        status: MatchRoundStatus.OPEN,
        source: 'MARKETPLACE',
        openedBy: 'REQUEST_CREATED',
        openedAt: now,
        publishedAt,
        expiresAt: new Date(publishedAt.getTime() + 14 * DAY_MS),
      },
    });
    await tx.$executeRaw`
      UPDATE "ServiceRequest"
      SET "currentRoundId" = ${roundTwoId}, "status" = 'APPROVED', "matchedOfferId" = NULL, "matchedAt" = NULL
      WHERE "id" = ${requestId}`;
  });
  return roundTwoId;
}

/** Round 1 matched to A (B rejected as a competitor), then Round 2 opened. */
async function secondRoundAfterMatch() {
  const live = await liveRequest();
  const a = await addProvider(live.category.id);
  const b = await addProvider(live.category.id);
  const offerA1 = await submitOffer(a, live.requestId);
  const offerB1 = await submitOffer(b, live.requestId);
  await act(live.requestId, offerA1, live.customerCookie, ACCEPT_OFFER).expect(201);
  // A's conversation in Round 1, opened before the round ended.
  const thread1 = await request(ctx.server)
    .post('/messages/threads/resolve')
    .set('Cookie', live.customerCookie)
    .send({ requestId: live.requestId })
    .expect(201);
  const roundTwoId = await openSecondRound(live.requestId);
  return { ...live, a, b, offerA1, offerB1, thread1Id: thread1.body.id as string, roundTwoId };
}

// ── offer schedule ──────────────────────────────────────────────────────────

describe('offer schedule (REL-002 §6.1)', () => {
  const today = () => todayIsoDay();

  it.each([
    ['start missing', { estimatedStartDate: undefined }, 'OFFER_SCHEDULE_REQUIRED', 'estimatedStartDate'],
    ['end empty', { estimatedCompletionDate: '' }, 'OFFER_SCHEDULE_REQUIRED', 'estimatedCompletionDate'],
    ['a timestamp', { estimatedStartDate: `${addIsoDays(todayIsoDay(), 2)}T09:00:00.000Z` }, 'OFFER_SCHEDULE_INVALID', 'estimatedStartDate'],
    ['not a calendar day', { estimatedCompletionDate: '2027-02-30' }, 'OFFER_SCHEDULE_INVALID', 'estimatedCompletionDate'],
    ['start yesterday', { estimatedStartDate: addIsoDays(todayIsoDay(), -1) }, 'OFFER_START_IN_PAST', 'estimatedStartDate'],
    [
      'end before start',
      { estimatedStartDate: addIsoDays(todayIsoDay(), 5), estimatedCompletionDate: addIsoDays(todayIsoDay(), 4) },
      'OFFER_END_BEFORE_START',
      'estimatedCompletionDate',
    ],
    [
      'beyond the horizon',
      { estimatedCompletionDate: addIsoDays(todayIsoDay(), OFFER_SCHEDULE_MAX_DAYS + 1) },
      'OFFER_SCHEDULE_TOO_FAR',
      'estimatedCompletionDate',
    ],
  ])('refuses %s with 400 %s, and charges nothing', async (_label, overrides, code, field) => {
    const { category, requestId } = await liveRequest();
    const party = await addProvider(category.id);

    const response = await postOffer(party, requestId, offerPayload(overrides)).expect(400);
    expect(response.body).toMatchObject({ code, field });
    expect(await ctx.prisma.offer.count({ where: { requestId } })).toBe(0);
  });

  it('accepts a schedule that starts today, a one-day job and the last day of the horizon; stores UTC midnight', async () => {
    const { category, requestId } = await liveRequest();
    const sameDay = await postOffer(
      await addProvider(category.id),
      requestId,
      offerPayload({ estimatedStartDate: today(), estimatedCompletionDate: today() }),
    ).expect(201);
    await postOffer(
      await addProvider(category.id),
      requestId,
      offerPayload({ estimatedCompletionDate: addIsoDays(today(), OFFER_SCHEDULE_MAX_DAYS) }),
    ).expect(201);

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: sameDay.body.id } });
    expect(stored.estimatedStartDate?.toISOString()).toBe(`${today()}T00:00:00.000Z`);
    expect(stored.estimatedCompletionDate?.toISOString()).toBe(`${today()}T00:00:00.000Z`);
  });

  it('legacy offers without dates still read everywhere (no backfill)', async () => {
    const { category, requestId, customerCookie } = await liveRequest();
    const party = await addProvider(category.id);
    const offerId = await submitOffer(party, requestId);
    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: { estimatedStartDate: null, estimatedCompletionDate: null },
    });

    const list = await request(ctx.server)
      .get(`/service-requests/${requestId}/offers`)
      .set('Cookie', customerCookie)
      .expect(200);
    expect(list.body[0]).toMatchObject({ id: offerId, estimatedStartDate: null, estimatedCompletionDate: null });
    await act(requestId, offerId, customerCookie, ACCEPT_OFFER).expect(201);
  });
});

// ── a second round ──────────────────────────────────────────────────────────

describe('second-round safety', () => {
  it('a Round 1 bidder sees the request again and offers anew; one offer per provider per round', async () => {
    const s = await secondRoundAfterMatch();

    // Discovery: B (Round 1 competitor) sees Round 2; so does A (exclusion is Faz 3).
    const list = await request(ctx.server)
      .get(`/providers/${s.b.provider.id}/requests`)
      .set('Cookie', s.b.cookie)
      .expect(200);
    expect(list.body.map((row: { id: string }) => row.id)).toContain(s.requestId);

    // The detail shows no "your offer": B's Round 1 offer is history.
    const detail = await request(ctx.server)
      .get(`/providers/${s.b.provider.id}/requests/${s.requestId}`)
      .set('Cookie', s.b.cookie)
      .expect(200);
    expect(JSON.stringify(detail.body)).not.toContain(s.offerB1);

    const offerB2 = await submitOffer(s.b, s.requestId);
    expect(await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerB2 }, select: { matchRoundId: true } })).toEqual(
      { matchRoundId: s.roundTwoId },
    );

    // Second offer in the same round: refused, list hides the request again.
    await postOffer(s.b, s.requestId).expect(409);
    const after = await request(ctx.server)
      .get(`/providers/${s.b.provider.id}/requests`)
      .set('Cookie', s.b.cookie)
      .expect(200);
    expect(after.body.map((row: { id: string }) => row.id)).not.toContain(s.requestId);

    // The customer's list is the current round's offers only.
    const offers = await request(ctx.server)
      .get(`/service-requests/${s.requestId}/offers`)
      .set('Cookie', s.customerCookie)
      .expect(200);
    expect(offers.body.map((row: { id: string }) => row.id)).toEqual([offerB2]);
  });

  it('stale-round offers: accept, shortlist, reject and withdraw answer 409 OFFER_ROUND_CLOSED', async () => {
    const s = await secondRoundAfterMatch();
    // A Round 1 offer still in play when the round ended (staged: a SUBMITTED
    // offer of a third provider in Round 1).
    const c = await addProvider(s.category.id);
    const staleOffer = await ctx.prisma.offer.create({
      data: {
        requestId: s.requestId,
        providerId: c.provider.id,
        matchRoundId: roundOneId(s.requestId),
        offerNumber: 'OF-STALE-1',
        priceAmount: 120_000,
        message: 'Tur 1',
        status: OfferStatus.SUBMITTED,
      },
    });

    for (const body of [ACCEPT_OFFER, { action: 'SHORTLIST' }, { action: 'REJECT' }]) {
      const response = await act(s.requestId, staleOffer.id, s.customerCookie, body).expect(409);
      expect(response.body.code).toBe('OFFER_ROUND_CLOSED');
    }
    const withdraw = await request(ctx.server)
      .post(`/providers/${c.provider.id}/offers/${staleOffer.id}/withdraw`)
      .set('Cookie', c.cookie)
      .expect(409);
    expect(withdraw.body.code).toBe('OFFER_ROUND_CLOSED');

    expect((await ctx.prisma.offer.findUniqueOrThrow({ where: { id: staleOffer.id } })).status).toBe(
      OfferStatus.SUBMITTED,
    );
    expect((await currentRound(s.requestId)).status).toBe(MatchRoundStatus.OPEN);
  });

  it('Round 2 accepts its own winner while Round 1’s stays ACCEPTED; reveal, contact, thread and work scope move to Round 2', async () => {
    const s = await secondRoundAfterMatch();
    const offerB2 = await submitOffer(s.b, s.requestId);

    await act(s.requestId, offerB2, s.customerCookie, ACCEPT_OFFER).expect(201);

    expect(await currentRound(s.requestId)).toMatchObject({
      id: s.roundTwoId,
      status: MatchRoundStatus.MATCHED,
      matchedOfferId: offerB2,
      matchedProviderId: s.b.provider.id,
    });
    // Two ACCEPTED offers on one request, one per round.
    expect(
      await ctx.prisma.offer.findMany({
        where: { requestId: s.requestId, status: OfferStatus.ACCEPTED },
        select: { id: true, matchRoundId: true },
        orderBy: { submittedAt: 'asc' },
      }),
    ).toEqual([
      { id: s.offerA1, matchRoundId: roundOneId(s.requestId) },
      { id: offerB2, matchRoundId: s.roundTwoId },
    ]);
    // Both reveals on file; the current one is Round 2's.
    expect(
      await ctx.prisma.contactRevealEvent.findMany({
        where: { requestId: s.requestId },
        select: { roundId: true, offerId: true },
        orderBy: { revealedAt: 'asc' },
      }),
    ).toEqual([
      { roundId: roundOneId(s.requestId), offerId: s.offerA1 },
      { roundId: s.roundTwoId, offerId: offerB2 },
    ]);

    // Contact: the customer sees B; A's view of its Round 1 offer is closed.
    const contact = await request(ctx.server)
      .get(`/service-requests/${s.requestId}/matched-contact`)
      .set('Cookie', s.customerCookie)
      .expect(200);
    expect(contact.body.provider.id).toBe(s.b.provider.id);
    await request(ctx.server)
      .get(`/providers/${s.a.provider.id}/offers/${s.offerA1}/matched-contact`)
      .set('Cookie', s.a.cookie)
      .expect(404);
    await request(ctx.server)
      .get(`/providers/${s.b.provider.id}/offers/${offerB2}/matched-contact`)
      .set('Cookie', s.b.cookie)
      .expect(200);

    // Messaging: Round 1's thread is closed to writes; a new thread for Round 2.
    await request(ctx.server)
      .post(`/messages/threads/${s.thread1Id}/messages`)
      .set('Cookie', s.a.cookie)
      .send({ body: 'Hâlâ buradayım.' })
      .expect(403);
    const thread2 = await request(ctx.server)
      .post('/messages/threads/resolve')
      .set('Cookie', s.customerCookie)
      .send({ requestId: s.requestId })
      .expect(201);
    expect(thread2.body.id).not.toBe(s.thread1Id);
    expect(thread2.body.offerId).toBe(offerB2);
    await request(ctx.server)
      .post(`/messages/threads/${thread2.body.id}/messages`)
      .set('Cookie', s.b.cookie)
      .send({ body: 'Yarın geliyoruz.' })
      .expect(201);
    // A, the Round 1 provider, cannot reach Round 2's thread at all.
    await request(ctx.server).get(`/messages/threads/${thread2.body.id}`).set('Cookie', s.a.cookie).expect(404);

    // Inbox: the customer has both threads; only Round 2's is active and counts.
    const inbox = await request(ctx.server).get('/messages/threads').set('Cookie', s.customerCookie).expect(200);
    const byId = new Map(inbox.body.map((t: { id: string; active: boolean; unreadCount: number }) => [t.id, t]));
    expect(byId.get(s.thread1Id)).toMatchObject({ active: false, unreadCount: 0 });
    expect(byId.get(thread2.body.id)).toMatchObject({ active: true, unreadCount: 1 });
    const badge = await request(ctx.server).get('/messages/unread-count').set('Cookie', s.customerCookie).expect(200);
    expect(badge.body).toEqual({ total: 1, threads: 1 });

    // Work scope: B sees the brief; A's ACCEPTED Round 1 offer no longer does.
    const bScope = await request(ctx.server)
      .get(`/providers/${s.b.provider.id}/offers/${offerB2}`)
      .set('Cookie', s.b.cookie)
      .expect(200);
    expect(bScope.body.acceptedWorkScope).not.toBeNull();
    const aScope = await request(ctx.server)
      .get(`/providers/${s.a.provider.id}/offers/${s.offerA1}`)
      .set('Cookie', s.a.cookie)
      .expect(200);
    expect(aScope.body.acceptedWorkScope).toBeNull();
  });

  it('review: only the current round’s completed match is reviewable', async () => {
    await ctx.prisma.operationsSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', unviewedOfferRefundWindowHours: 48, providerReviewsEnabled: true },
      update: { providerReviewsEnabled: true },
    });
    const s = await secondRoundAfterMatch();
    const offerB2 = await submitOffer(s.b, s.requestId);
    await act(s.requestId, offerB2, s.customerCookie, ACCEPT_OFFER).expect(201);
    await request(ctx.server).post(`/service-requests/${s.requestId}/complete`).set('Cookie', s.customerCookie).expect(201);

    const created = await request(ctx.server)
      .post(`/service-requests/${s.requestId}/review`)
      .set('Cookie', s.customerCookie)
      .send({ rating: 5 })
      .expect(201);
    expect(created.body.provider.id).toBe(s.b.provider.id);
    expect(
      await ctx.prisma.providerReview.findMany({ where: { requestId: s.requestId }, select: { offerId: true } }),
    ).toEqual([{ offerId: offerB2 }]);
  });

  it('cancel in Round 2 closes and refunds Round 2’s offers only; Round 1’s settled offers are untouched', async () => {
    const s = await secondRoundAfterMatch();
    const offerB2 = await submitOffer(s.b, s.requestId);
    const beforeB1 = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: s.offerB1 } });
    expect(beforeB1.status).toBe(OfferStatus.REJECTED);

    await request(ctx.server)
      .post(`/service-requests/${s.requestId}/cancel`)
      .set('Cookie', s.customerCookie)
      .send({})
      .expect(201);

    expect(await currentRound(s.requestId)).toMatchObject({ id: s.roundTwoId, status: MatchRoundStatus.CANCELLED });
    const b2 = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerB2 } });
    expect(b2.status).toBe(OfferStatus.CANCELLED);
    expect(b2.creditRefundedTransactionId).not.toBeNull();
    // Round 1: the competitor stays as its round left it, and the winner too.
    expect(await ctx.prisma.offer.findUniqueOrThrow({ where: { id: s.offerB1 } })).toEqual(beforeB1);
    expect((await ctx.prisma.offer.findUniqueOrThrow({ where: { id: s.offerA1 } })).status).toBe(OfferStatus.ACCEPTED);
  });

  it('the round clock: Round 2 expires and reminds on its own publishedAt, with :r2 notification keys', async () => {
    const live = await liveRequest();
    const bidder = await addProvider(live.category.id);
    // Round 1: approved long ago and expired.
    await ctx.prisma.serviceRequest.update({ where: { id: live.requestId }, data: { approvedAt: daysAgo(30) } });
    await ctx.prisma.serviceRequestMatchRound.update({
      where: { id: roundOneId(live.requestId) },
      data: { publishedAt: daysAgo(30), expiresAt: daysAgo(16) },
    });
    const r1Offer = await submitOffer(bidder, live.requestId);
    await ctx.app.get(RequestExpiryService).execute();
    expect((await currentRound(live.requestId)).status).toBe(MatchRoundStatus.EXPIRED);

    // Round 2, published 8 days ago: the request's own (old) approvedAt does
    // not expire it; its round's clock reminds it once.
    const roundTwoId = await openSecondRound(live.requestId, daysAgo(8));
    expect((await ctx.app.get(RequestExpiryService).expireDueRequests()).expired).toBe(0);
    const reminded = await ctx.app.get(RequestReminderService).execute();
    expect(reminded.reminded).toBe(1);
    const r2 = await currentRound(live.requestId);
    expect(r2.reminderSentAt).not.toBeNull();
    expect((await ctx.app.get(RequestReminderService).execute()).reminded).toBe(0);
    // (Round 1's offer did not count against Round 2's "no offer yet".)
    expect(r1Offer).toBeTruthy();

    // A Round 2 bid, then Round 2's own clock runs out: it expires, with
    // Round 2 keys naming Round 2's bidder only.
    const bidder2 = await addProvider(live.category.id);
    await submitOffer(bidder2, live.requestId);
    await ctx.prisma.serviceRequestMatchRound.update({
      where: { id: roundTwoId },
      data: { publishedAt: daysAgo(15), expiresAt: daysAgo(1) },
    });
    await ctx.app.get(RequestExpiryService).execute();
    expect(await currentRound(live.requestId)).toMatchObject({ id: roundTwoId, status: MatchRoundStatus.EXPIRED });

    const keys = (
      await ctx.prisma.notificationLog.findMany({
        where: { requestId: live.requestId, template: { startsWith: 'request-expired' } },
        select: { dedupeKey: true },
      })
    ).map((row) => row.dedupeKey);
    // Round 1 keys exactly as before rounds existed; Round 2's carry :r2 and
    // name only Round 2's bidder.
    expect(keys).toEqual(
      expect.arrayContaining([
        `request-expired-customer:${live.requestId}`,
        `request-expired-provider:${live.requestId}:${bidder.provider.id}`,
        `request-expired-customer:${live.requestId}:r2`,
        `request-expired-provider:${live.requestId}:${bidder2.provider.id}:r2`,
      ]),
    );
    expect(keys).not.toContain(`request-expired-provider:${live.requestId}:${bidder.provider.id}:r2`);
  });

  it('publish fan-out keys: Round 1 is the legacy key, Round 2 appends :r2 — no collision', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const provider = await addProvider(category.id);
    const created = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(201);
    const requestId = created.body.id as string;
    const admin = await adminCookie();
    await request(ctx.server)
      .patch(`/service-requests/${requestId}/status`)
      .set('Cookie', admin)
      .send({ status: ServiceRequestStatus.APPROVED })
      .expect(200);

    // Round 2, staged in moderation, then published by the same approval path.
    await openSecondRound(requestId);
    await ctx.prisma.$executeRaw`UPDATE "ServiceRequestMatchRound" SET "publishedAt" = NULL, "expiresAt" = NULL WHERE id = ${`mr2_${requestId}`}`;
    await ctx.prisma.$executeRaw`UPDATE "ServiceRequest" SET status = 'SUBMITTED' WHERE id = ${requestId}`;
    await request(ctx.server)
      .patch(`/service-requests/${requestId}/status`)
      .set('Cookie', admin)
      .send({ status: ServiceRequestStatus.APPROVED })
      .expect(200);

    const keys = (
      await ctx.prisma.notificationLog.findMany({
        where: { requestId, template: 'request-available' },
        select: { dedupeKey: true },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => row.dedupeKey);
    expect(keys).toEqual([
      `request-available:${requestId}:${provider.provider.id}`,
      `request-available:${requestId}:${provider.provider.id}:r2`,
    ]);
    expect((await currentRound(requestId)).publishedAt).not.toBeNull();
  });
});

// ── round-aware dedupe and the retry parser ─────────────────────────────────

describe('round-aware notification keys', () => {
  it('Round 1 is the legacy key; Round N ≥ 2 appends :r<N>', () => {
    expect(roundDedupeSuffix(1)).toBe('');
    expect(roundDedupeSuffix(2)).toBe(':r2');
    expect(roundDedupeSuffix(12)).toBe(':r12');
    expect(() => roundDedupeSuffix(0)).toThrow();
    expect(roundNumberFromDedupeSegment(undefined)).toBe(1);
    expect(roundNumberFromDedupeSegment('r2')).toBe(2);
    expect(roundNumberFromDedupeSegment('r10')).toBe(10);
    for (const bad of ['r1', 'r0', 'r01', 'x2', '2']) {
      expect(roundNumberFromDedupeSegment(bad)).toBeNull();
    }
  });

  it('a retry rebuilds the round its key names, and only while that round is current', async () => {
    const live = await liveRequest();
    const provider = await addProvider(live.category.id);
    const mail = ctx.app.get(TransactionalMailService);
    const r1Key = `request-available:${live.requestId}:${provider.provider.id}`;

    expect(await mail.composeRetryMessage('request-available', r1Key)).not.toBeNull();
    // A Round 2 key while Round 1 is current: not this round's invitation.
    expect(await mail.composeRetryMessage('request-available', `${r1Key}:r2`)).toBeNull();
    // Malformed round segments are refused, not guessed.
    expect(await mail.composeRetryMessage('request-available', `${r1Key}:r1`)).toBeNull();
    expect(await mail.composeRetryMessage('request-available', `${r1Key}:r2:x`)).toBeNull();

    await openSecondRound(live.requestId);
    expect(await mail.composeRetryMessage('request-available', r1Key)).toBeNull();
    expect(await mail.composeRetryMessage('request-available', `${r1Key}:r2`)).not.toBeNull();
  });
});

// ── concurrency ─────────────────────────────────────────────────────────────

describe('concurrency: one winner, the rest 409 or nothing', () => {
  it('the same provider offering twice at once: one offer, one charge', async () => {
    const { category, requestId } = await liveRequest();
    const party = await addProvider(category.id);

    const results = await Promise.all([postOffer(party, requestId), postOffer(party, requestId)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await ctx.prisma.offer.count({ where: { requestId } })).toBe(1);
    expect(
      await ctx.prisma.providerCreditTransaction.count({
        where: { providerId: party.provider.id, type: 'OFFER_SPEND' },
      }),
    ).toBe(1);
  });

  it('offer create vs accept: a new offer never lands in a matched round', async () => {
    const { category, requestId, customerCookie } = await liveRequest();
    const first = await addProvider(category.id);
    const late = await addProvider(category.id);
    const firstOffer = await submitOffer(first, requestId);

    const [accepted, offered] = await Promise.all([
      act(requestId, firstOffer, customerCookie, ACCEPT_OFFER),
      postOffer(late, requestId),
    ]);
    expect(accepted.status).toBe(201);
    // Either the late offer committed first (and the accept closed it as a
    // competitor) or it found the request matched (404, as for any request it
    // may no longer see).
    expect([201, 404]).toContain(offered.status);
    const lateOffers = await ctx.prisma.offer.findMany({
      where: { requestId, providerId: late.provider.id },
      select: { status: true },
    });
    if (offered.status === 201) {
      expect(lateOffers).toEqual([{ status: OfferStatus.REJECTED }]);
    } else {
      expect(lateOffers).toEqual([]);
      expect(
        await ctx.prisma.providerCreditTransaction.count({
          where: { providerId: late.provider.id, type: 'OFFER_SPEND' },
        }),
      ).toBe(0);
    }
    expect(
      await ctx.prisma.offer.count({
        where: { requestId, status: { in: [OfferStatus.SUBMITTED, OfferStatus.VIEWED, OfferStatus.SHORTLISTED] } },
      }),
    ).toBe(0);
  });

  it('accept vs cancel: exactly one lands', async () => {
    const { category, requestId, customerCookie } = await liveRequest();
    const offerId = await submitOffer(await addProvider(category.id), requestId);

    const [accepted, cancelled] = await Promise.all([
      act(requestId, offerId, customerCookie, ACCEPT_OFFER),
      request(ctx.server).post(`/service-requests/${requestId}/cancel`).set('Cookie', customerCookie).send({}),
    ]);
    expect([accepted.status, cancelled.status].sort()).toEqual([201, 409]);
    const round = await currentRound(requestId);
    if (accepted.status === 201) {
      expect(round.status).toBe(MatchRoundStatus.MATCHED);
    } else {
      expect(round).toMatchObject({ status: MatchRoundStatus.CANCELLED, matchedOfferId: null });
    }
  });

  it('accept vs reject of the same offer: exactly one decision', async () => {
    const { category, requestId, customerCookie } = await liveRequest();
    const offerId = await submitOffer(await addProvider(category.id), requestId);

    const [accepted, rejected] = await Promise.all([
      act(requestId, offerId, customerCookie, ACCEPT_OFFER),
      act(requestId, offerId, customerCookie, { action: 'REJECT' }),
    ]);
    const statuses = [accepted.status, rejected.status];
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    const round = await currentRound(requestId);
    if (accepted.status === 201) {
      expect(offer.status).toBe(OfferStatus.ACCEPTED);
      expect(round.status).toBe(MatchRoundStatus.MATCHED);
    } else {
      expect(offer.status).toBe(OfferStatus.REJECTED);
      expect(round.status).toBe(MatchRoundStatus.OPEN);
    }
  });

  it('expiry vs accept: the round ends exactly one way', async () => {
    const { category, requestId, customerCookie } = await liveRequest();
    const offerId = await submitOffer(await addProvider(category.id), requestId);
    // Round 1's clock is the request's approvedAt: both move together.
    const approvedAt = daysAgo(15);
    await ctx.prisma.serviceRequest.update({ where: { id: requestId }, data: { approvedAt } });
    await ctx.prisma.serviceRequestMatchRound.update({
      where: { id: roundOneId(requestId) },
      data: { publishedAt: approvedAt, expiresAt: new Date(approvedAt.getTime() + 14 * DAY_MS) },
    });

    const [accepted, expiry] = await Promise.all([
      act(requestId, offerId, customerCookie, ACCEPT_OFFER),
      ctx.app.get(RequestExpiryService).expireDueRequests(),
    ]);
    const round = await currentRound(requestId);
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (accepted.status === 201) {
      expect(expiry.expired).toBe(0);
      expect(round.status).toBe(MatchRoundStatus.MATCHED);
      expect(row.status).toBe(ServiceRequestStatus.MATCHED);
    } else {
      expect(accepted.status).toBe(409);
      expect(expiry.expired).toBe(1);
      expect(round.status).toBe(MatchRoundStatus.EXPIRED);
      expect(row.status).toBe(ServiceRequestStatus.EXPIRED);
    }
  });

  it('two schedulers claiming one reminder: one claim', async () => {
    const { requestId } = await liveRequest();
    const approvedAt = daysAgo(8);
    await ctx.prisma.serviceRequest.update({ where: { id: requestId }, data: { approvedAt } });
    await ctx.prisma.serviceRequestMatchRound.update({
      where: { id: roundOneId(requestId) },
      data: { publishedAt: approvedAt, expiresAt: new Date(approvedAt.getTime() + 14 * DAY_MS) },
    });
    const cutoff = requestReminderCutoff();
    const claims = await Promise.all(
      [0, 1].map(() =>
        ctx.prisma.$transaction((tx) => claimRoundReminder(tx, { roundId: roundOneId(requestId), cutoff, now: new Date() })),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    // The service writes the request's compatibility mirror beside the claim;
    // this case called the claim alone, so mirror it for the consistency check.
    const { reminderSentAt } = await currentRound(requestId);
    await ctx.prisma.serviceRequest.update({ where: { id: requestId }, data: { reminderSentAt } });
  });

  it('two first-opens of the thread: one thread', async () => {
    const { category, requestId, customerCookie } = await liveRequest();
    const party = await addProvider(category.id);
    const offerId = await submitOffer(party, requestId);
    await act(requestId, offerId, customerCookie, ACCEPT_OFFER).expect(201);

    const opens = await Promise.all([
      request(ctx.server).post('/messages/threads/resolve').set('Cookie', customerCookie).send({ requestId }),
      request(ctx.server).post('/messages/threads/resolve').set('Cookie', party.cookie).send({ requestId }),
    ]);
    expect(opens.map((r) => r.status)).toEqual([201, 201]);
    expect(opens[0]!.body.id).toBe(opens[1]!.body.id);
    expect(await ctx.prisma.messageThread.count({ where: { requestId } })).toBe(1);
  });

  it('a second reveal for one round is refused by the database', async () => {
    const { category, requestId, customerCookie } = await liveRequest();
    const party = await addProvider(category.id);
    const offerId = await submitOffer(party, requestId);
    await act(requestId, offerId, customerCookie, ACCEPT_OFFER).expect(201);
    const other = await addProvider(category.id);

    await expect(
      ctx.prisma.contactRevealEvent.create({
        data: {
          requestId,
          offerId: (await ctx.prisma.offer.create({
            data: {
              requestId,
              providerId: other.provider.id,
              offerNumber: 'OF-RACE-2',
              priceAmount: 100_000,
              message: 'x',
              status: OfferStatus.REJECTED,
            },
          })).id,
          providerId: other.provider.id,
          disclosureVersion: 'v1',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

// ── database invariants ─────────────────────────────────────────────────────

describe('M2 database invariants', () => {
  async function seededRequest() {
    const { category, requestId, customerCookie } = await liveRequest();
    const party = await addProvider(category.id);
    const offerId = await submitOffer(party, requestId);
    return { category, requestId, customerCookie, party, offerId };
  }

  it('a raw request insert is born with an OPEN Round 1; raw offers attach to the current round', async () => {
    const { requestId, offerId } = await seededRequest();
    expect(await currentRound(requestId)).toMatchObject({ id: roundOneId(requestId), roundNumber: 1, status: 'OPEN' });
    expect((await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId }, select: { matchRoundId: true } })).matchRoundId).toBe(
      roundOneId(requestId),
    );
  });

  it('one ACCEPTED offer per round', async () => {
    const { requestId, customerCookie, offerId, category } = await seededRequest();
    const other = await submitOffer(await addProvider(category.id), requestId);
    await act(requestId, offerId, customerCookie, ACCEPT_OFFER).expect(201);
    await expect(
      ctx.prisma.offer.update({ where: { id: other }, data: { status: OfferStatus.ACCEPTED } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('an offer cannot sit in another request’s round; a winner cannot be another round’s offer', async () => {
    const a = await seededRequest();
    const b = await seededRequest();
    await expect(
      ctx.prisma.$executeRaw`UPDATE "Offer" SET "matchRoundId" = ${roundOneId(b.requestId)} WHERE id = ${a.offerId}`,
    ).rejects.toThrow(/foreign key/i);
    await expect(
      ctx.prisma.$executeRaw`
        UPDATE "ServiceRequestMatchRound"
        SET status = 'MATCHED', "matchedOfferId" = ${a.offerId}, "matchedProviderId" = ${a.party.provider.id}, "matchedAt" = now()
        WHERE id = ${roundOneId(b.requestId)}`,
    ).rejects.toThrow(/foreign key/i);
  });

  it('round shape CHECKs: an OPEN round carries no outcome, a MATCHED one carries its winner', async () => {
    const { requestId } = await seededRequest();
    await expect(
      ctx.prisma.$executeRaw`UPDATE "ServiceRequestMatchRound" SET "completedAt" = now() WHERE id = ${roundOneId(requestId)}`,
    ).rejects.toThrow(/MatchRound_open_has_no_outcome/);
    await expect(
      ctx.prisma.$executeRaw`UPDATE "ServiceRequestMatchRound" SET status = 'MATCHED' WHERE id = ${roundOneId(requestId)}`,
    ).rejects.toThrow(/MatchRound_matched_shape/);
    await expect(
      ctx.prisma.$executeRaw`UPDATE "ServiceRequestMatchRound" SET "publishedAt" = NULL WHERE id = ${roundOneId(requestId)}`,
    ).rejects.toThrow(/MatchRound_publication_pair/);
  });

  it('NOT NULL: no request without a round, no offer outside one', async () => {
    const { requestId, offerId } = await seededRequest();
    await expect(
      ctx.prisma.$executeRaw`UPDATE "ServiceRequest" SET "currentRoundId" = NULL WHERE id = ${requestId}`,
    ).rejects.toThrow(/23502|null value/i);
    await expect(
      ctx.prisma.$executeRaw`UPDATE "Offer" SET "matchRoundId" = NULL WHERE id = ${offerId}`,
    ).rejects.toThrow(/23502|null value/i);
  });
});
