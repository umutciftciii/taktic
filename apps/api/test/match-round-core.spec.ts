import {
  MatchRoundSource,
  MatchRoundStatus,
  OfferStatus,
  ServiceCategoryKind,
  ServiceRequestStatus,
  ShowcaseLeadStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { roundOneId } from './match-round-fixtures';
import { transitionRoundToExpired } from '../src/modules/match-rounds/match-round-transitions';
import { RequestExpiryService } from '../src/modules/request-lifecycle/request-expiry.service';
import { RequestReminderService } from '../src/modules/request-lifecycle/request-reminder.service';
import { ShowcaseLeadSlaService } from '../src/modules/showcase/showcase-lead-sla.service';
import {
  ACCEPT_OFFER,
  createApprovedRequest,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  daysAgo,
  grantCredits,
  loginAs,
  offerPayload,
  proveShowcaseLeadPhone,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  showcaseLeadPayload,
  type TestContext,
} from './harness';
import { roundInconsistencies } from './match-round-consistency';

/**
 * REL-002 — every lifecycle writer moves the request's current round through
 * its explicit transition, in the writer's own transaction, together with the
 * request projection; and with one round per request nothing about the
 * product's behaviour changes (Faz 1 wrote the round as a mirror; since Faz 2
 * the round is the authority and these cases pin that the two still agree).
 *
 * Each case drives a real endpoint (or the real scheduler service), then
 * asserts the round it expects *and* runs the operators' consistency check
 * (scripts/ops/rel-002-round-consistency.sql) over the whole database. The
 * requests here are created through the API wherever the writer allows it, so
 * the round under test is the one the creation path wrote.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  // The settings singleton survives resetDatabase; leave the switch off for
  // whichever spec file runs next.
  await setAutoPublish(false);
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetAuthThrottle(ctx.app);
  ctx.notifications.clear();
  await setAutoPublish(false);
  // The defaults a deployment runs: contact sharing on with the built-in
  // disclosure, no phone-verification gate.
  delete process.env.CONTACT_SHARING_ENABLED;
  delete process.env.CONTACT_DISCLOSURE_URL;
  delete process.env.CONTACT_DISCLOSURE_VERSION;
  delete process.env.REQUIRE_PHONE_VERIFICATION;
});

afterEach(async () => {
  // Whatever the case did, the database it leaves behind is consistent.
  expect(await roundInconsistencies(ctx.prisma)).toEqual([]);
});

async function setAutoPublish(enabled: boolean) {
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48, marketplaceAutoPublishEnabled: enabled },
    update: { marketplaceAutoPublishEnabled: enabled },
  });
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

async function roundOf(requestId: string) {
  const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { currentRoundId: true, currentRound: true },
  });
  expect(row.currentRoundId).toBe(roundOneId(requestId));
  return row.currentRound!;
}

async function requestRow(requestId: string) {
  return ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
}

function plusDays(at: Date, days: number) {
  return new Date(at.getTime() + days * DAY_MS);
}

/** A marketplace category, a guest-submitted request through the public form, and its owner's session. */
async function submitRequest() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
  const created = await request(ctx.server)
    .post('/service-requests')
    .send(serviceRequestPayload(category.slug))
    .expect(201);
  const requestId = created.body.id as string;
  const { customerId } = await requestRow(requestId);
  return { category, requestId, customerCookie: await loginAs(ctx.prisma, customerId!) };
}

async function addProvider(categoryId: string) {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: user.id, categoryId });
  await grantCredits(ctx.prisma, provider.id, 20);
  return { provider, cookie: await loginAs(ctx.prisma, user.id) };
}

async function submitOffer(party: { provider: { id: string }; cookie: string }, requestId: string) {
  const response = await request(ctx.server)
    .post(`/providers/${party.provider.id}/requests/${requestId}/offers`)
    .set('Cookie', party.cookie)
    .send(offerPayload())
    .expect(201);
  return response.body.id as string;
}

async function approve(requestId: string, cookie: string) {
  await request(ctx.server)
    .patch(`/service-requests/${requestId}/status`)
    .set('Cookie', cookie)
    .send({ status: ServiceRequestStatus.APPROVED })
    .expect(200);
}

/** A live, approved request with two offers, the first one accepted. */
async function matchedScenario() {
  const { category, requestId, customerCookie } = await submitRequest();
  const admin = await adminCookie();
  await approve(requestId, admin);
  const winner = await addProvider(category.id);
  const loser = await addProvider(category.id);
  const winnerOfferId = await submitOffer(winner, requestId);
  const loserOfferId = await submitOffer(loser, requestId);

  await request(ctx.server)
    .post(`/service-requests/${requestId}/offers/${winnerOfferId}/action`)
    .set('Cookie', customerCookie)
    .send(ACCEPT_OFFER)
    .expect(201);

  return { category, requestId, customerCookie, admin, winner, loser, winnerOfferId, loserOfferId };
}

describe('creation and publication', () => {
  it('a submitted request is born with an OPEN Round 1 and no offer period yet', async () => {
    const { requestId } = await submitRequest();

    const row = await requestRow(requestId);
    expect(row.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(await roundOf(requestId)).toMatchObject({
      id: roundOneId(requestId),
      requestId,
      roundNumber: 1,
      status: MatchRoundStatus.OPEN,
      source: MatchRoundSource.MARKETPLACE,
      openedBy: 'REQUEST_CREATED',
      openedAt: row.submittedAt,
      publishedAt: null,
      expiresAt: null,
      reminderSentAt: null,
      matchedOfferId: null,
    });
  });

  it('auto-publish: the round is published in the creating transaction with approvedAt', async () => {
    await setAutoPublish(true);
    const { requestId } = await submitRequest();

    const row = await requestRow(requestId);
    expect(row.status).toBe(ServiceRequestStatus.APPROVED);
    expect(await roundOf(requestId)).toMatchObject({
      status: MatchRoundStatus.OPEN,
      publishedAt: row.approvedAt,
      expiresAt: plusDays(row.approvedAt!, 14),
    });
  });

  it('manual approve: publishedAt/expiresAt follow approvedAt; IN_REVIEW clears them again', async () => {
    const { requestId } = await submitRequest();
    const admin = await adminCookie();

    await request(ctx.server)
      .patch(`/service-requests/${requestId}/status`)
      .set('Cookie', admin)
      .send({ status: ServiceRequestStatus.IN_REVIEW })
      .expect(200);
    expect(await roundOf(requestId)).toMatchObject({ status: MatchRoundStatus.OPEN, publishedAt: null });

    await approve(requestId, admin);
    const approved = await requestRow(requestId);
    expect(await roundOf(requestId)).toMatchObject({
      publishedAt: approved.approvedAt,
      expiresAt: plusDays(approved.approvedAt!, 14),
    });
  });

  it('report removal keeps the round OPEN; the reopen refreshes the offer period like approvedAt', async () => {
    const { category, requestId } = await submitRequest();
    const admin = await adminCookie();
    await approve(requestId, admin);
    const firstApproval = (await requestRow(requestId)).approvedAt!;
    const reporter = await addProvider(category.id);

    await request(ctx.server)
      .post(`/providers/${reporter.provider.id}/requests/${requestId}/reports`)
      .set('Cookie', reporter.cookie)
      .send({ reason: 'SPAM' })
      .expect(201);
    await request(ctx.server)
      .post(`/service-requests/${requestId}/reports/resolve`)
      .set('Cookie', admin)
      .send({ resolution: 'REQUEST_REMOVED', removalReason: 'SPAM' })
      .expect(201);

    expect((await requestRow(requestId)).status).toBe(ServiceRequestStatus.REJECTED);
    expect(await roundOf(requestId)).toMatchObject({ status: MatchRoundStatus.OPEN, publishedAt: firstApproval });

    await request(ctx.server).post(`/service-requests/${requestId}/reopen`).set('Cookie', admin).send({}).expect(201);

    const reopened = await requestRow(requestId);
    expect(reopened.status).toBe(ServiceRequestStatus.APPROVED);
    expect(reopened.approvedAt!.getTime()).toBeGreaterThanOrEqual(firstApproval.getTime());
    expect(await roundOf(requestId)).toMatchObject({
      status: MatchRoundStatus.OPEN,
      publishedAt: reopened.approvedAt,
      expiresAt: plusDays(reopened.approvedAt!, 14),
    });
  });
});

describe('offers, acceptance and what hangs off the match', () => {
  it('every offer is written into the current round; shortlist/reject do not move the round', async () => {
    const { category, requestId, customerCookie } = await submitRequest();
    await approve(requestId, await adminCookie());
    const a = await addProvider(category.id);
    const b = await addProvider(category.id);
    const offerA = await submitOffer(a, requestId);
    const offerB = await submitOffer(b, requestId);

    await request(ctx.server)
      .post(`/service-requests/${requestId}/offers/${offerA}/action`)
      .set('Cookie', customerCookie)
      .send({ action: 'SHORTLIST' })
      .expect(201);
    await request(ctx.server)
      .post(`/service-requests/${requestId}/offers/${offerB}/action`)
      .set('Cookie', customerCookie)
      .send({ action: 'REJECT' })
      .expect(201);

    const offers = await ctx.prisma.offer.findMany({
      where: { requestId },
      select: { id: true, status: true, matchRoundId: true },
      orderBy: { submittedAt: 'asc' },
    });
    expect(offers).toEqual([
      { id: offerA, status: OfferStatus.SHORTLISTED, matchRoundId: roundOneId(requestId) },
      { id: offerB, status: OfferStatus.REJECTED, matchRoundId: roundOneId(requestId) },
    ]);
    expect(await roundOf(requestId)).toMatchObject({ status: MatchRoundStatus.OPEN, matchedOfferId: null });
  });

  it('accept: the round matches in the same transaction; the reveal and the thread join its round', async () => {
    const { requestId, customerCookie, winner, winnerOfferId, loserOfferId } = await matchedScenario();

    const row = await requestRow(requestId);
    expect(row.status).toBe(ServiceRequestStatus.MATCHED);
    expect(await roundOf(requestId)).toMatchObject({
      status: MatchRoundStatus.MATCHED,
      matchedOfferId: winnerOfferId,
      matchedProviderId: winner.provider.id,
      matchedAt: row.matchedAt,
    });
    expect(
      (await ctx.prisma.offer.findUniqueOrThrow({ where: { id: loserOfferId } })).status,
    ).toBe(OfferStatus.REJECTED);

    const reveal = await ctx.prisma.contactRevealEvent.findUniqueOrThrow({
      where: { roundId: roundOneId(requestId) },
      select: { offerId: true, roundId: true },
    });
    expect(reveal).toEqual({ offerId: winnerOfferId, roundId: roundOneId(requestId) });

    // The customer opens the conversation (lazily created), then the provider
    // writes into it.
    const thread = await request(ctx.server)
      .post('/messages/threads/resolve')
      .set('Cookie', customerCookie)
      .send({ requestId })
      .expect(201);
    await request(ctx.server)
      .post(`/messages/threads/${thread.body.id}/messages`)
      .set('Cookie', winner.cookie)
      .send({ body: 'Merhaba, yarın geliyoruz.' })
      .expect(201);
    expect(
      await ctx.prisma.messageThread.findFirstOrThrow({ where: { requestId }, select: { roundId: true } }),
    ).toEqual({ roundId: roundOneId(requestId) });
  });

  it('complete: the round completes with the same completedAt', async () => {
    const { requestId, customerCookie } = await matchedScenario();

    await request(ctx.server)
      .post(`/service-requests/${requestId}/complete`)
      .set('Cookie', customerCookie)
      .expect(201);

    const row = await requestRow(requestId);
    expect(row.status).toBe(ServiceRequestStatus.COMPLETED);
    expect(await roundOf(requestId)).toMatchObject({
      status: MatchRoundStatus.COMPLETED,
      completedAt: row.completedAt,
      matchedOfferId: row.matchedOfferId,
    });
  });

  it('a refused acceptance leaves no half-written round', async () => {
    const { category, requestId, customerCookie } = await submitRequest();
    await approve(requestId, await adminCookie());
    const party = await addProvider(category.id);
    const offerId = await submitOffer(party, requestId);

    // A reveal already recorded against this offer (from another request)
    // makes the accept fail at its very last write — after the request and
    // the round have both been moved inside the transaction.
    const other = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const stray = await ctx.prisma.contactRevealEvent.create({
      data: {
        requestId: other.id,
        offerId,
        providerId: party.provider.id,
        disclosureVersion: 'stray',
      },
    });

    await request(ctx.server)
      .post(`/service-requests/${requestId}/offers/${offerId}/action`)
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(409);

    expect((await requestRow(requestId)).status).toBe(ServiceRequestStatus.APPROVED);
    expect(await roundOf(requestId)).toMatchObject({
      status: MatchRoundStatus.OPEN,
      matchedOfferId: null,
      matchedProviderId: null,
      matchedAt: null,
    });

    await ctx.prisma.contactRevealEvent.delete({ where: { id: stray.id } });
  });

  it('two acceptances racing: one wins, and the round names the winner', async () => {
    const { category, requestId, customerCookie } = await submitRequest();
    await approve(requestId, await adminCookie());
    const a = await addProvider(category.id);
    const b = await addProvider(category.id);
    const offerA = await submitOffer(a, requestId);
    const offerB = await submitOffer(b, requestId);

    const results = await Promise.all(
      [offerA, offerB].map((offerId) =>
        request(ctx.server)
          .post(`/service-requests/${requestId}/offers/${offerId}/action`)
          .set('Cookie', customerCookie)
          .send(ACCEPT_OFFER),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);

    const row = await requestRow(requestId);
    const winnerOfferId = results[0]!.status === 201 ? offerA : offerB;
    expect(row.matchedOfferId).toBe(winnerOfferId);
    expect(await roundOf(requestId)).toMatchObject({
      status: MatchRoundStatus.MATCHED,
      matchedOfferId: winnerOfferId,
      matchedAt: row.matchedAt,
    });
  });
});

describe('cancellation', () => {
  it('customer cancel before any match: CANCELLED with no match record', async () => {
    const { category, requestId, customerCookie } = await submitRequest();
    await approve(requestId, await adminCookie());
    await submitOffer(await addProvider(category.id), requestId);

    await request(ctx.server)
      .post(`/service-requests/${requestId}/cancel`)
      .set('Cookie', customerCookie)
      .send({})
      .expect(201);

    const row = await requestRow(requestId);
    expect(row.status).toBe(ServiceRequestStatus.CANCELLED);
    expect(await roundOf(requestId)).toMatchObject({
      status: MatchRoundStatus.CANCELLED,
      cancelledAt: row.cancelledAt,
      matchedOfferId: null,
    });
  });

  it('staff cancel of a match with the winner refunded: the round keeps the match, as the request does', async () => {
    const { requestId, admin, winner, winnerOfferId } = await matchedScenario();

    await request(ctx.server)
      .post(`/service-requests/${requestId}/cancel`)
      .set('Cookie', admin)
      .send({ expectedMatchedOfferId: winnerOfferId })
      .expect(201);

    const row = await requestRow(requestId);
    expect(row.status).toBe(ServiceRequestStatus.CANCELLED);
    expect(row.matchedOfferId).toBe(winnerOfferId);
    expect(await roundOf(requestId)).toMatchObject({
      status: MatchRoundStatus.CANCELLED,
      cancelledAt: row.cancelledAt,
      matchedOfferId: winnerOfferId,
      matchedProviderId: winner.provider.id,
      matchedAt: row.matchedAt,
    });
    // The winner's credit came back exactly as before REL-002.
    expect(
      (await ctx.prisma.offer.findUniqueOrThrow({ where: { id: winnerOfferId } })).creditRefundedTransactionId,
    ).not.toBeNull();
  });

  it('a finished round cannot change status again (database backstop)', async () => {
    const { requestId, customerCookie } = await matchedScenario();
    await request(ctx.server).post(`/service-requests/${requestId}/complete`).set('Cookie', customerCookie).expect(201);

    await expect(
      ctx.prisma.serviceRequestMatchRound.update({
        where: { id: roundOneId(requestId) },
        data: { status: MatchRoundStatus.OPEN },
      }),
    ).rejects.toThrow(/cannot change/);
  });
});

describe('lifecycle schedulers', () => {
  it('expiry: the round expires with the request, with the same expiredAt', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const due = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: daysAgo(15) });

    await ctx.app.get(RequestExpiryService).expireDueRequests();

    const row = await requestRow(due.id);
    expect(row.status).toBe(ServiceRequestStatus.EXPIRED);
    expect(await roundOf(due.id)).toMatchObject({
      status: MatchRoundStatus.EXPIRED,
      expiredAt: row.expiredAt,
      publishedAt: row.approvedAt,
    });
  });

  it('reminder: the round claim is authoritative and the request mirrors the same instant', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const quiet = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: daysAgo(8) });

    const result = await ctx.app.get(RequestReminderService).execute();
    expect(result.reminded).toBe(1);

    const row = await requestRow(quiet.id);
    expect(row.reminderSentAt).not.toBeNull();
    expect(await roundOf(quiet.id)).toMatchObject({
      status: MatchRoundStatus.OPEN,
      reminderSentAt: row.reminderSentAt,
    });

    // A second run claims nothing, on the request or the round.
    expect((await ctx.app.get(RequestReminderService).execute()).reminded).toBe(0);
  });
});

describe('vitrin direct lead', () => {
  async function leadScenario() {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
      offerCreditCost: 2,
    });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const owner = await createDiscoverableProvider(ctx.prisma, {
      userId: ownerUser.id,
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: null }],
    });
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: owner.id,
      categoryId: category.id,
    });
    const pkg = await createShowcasePackage(ctx.prisma);
    await createLiveShowcasePlacement(ctx, {
      providerId: owner.id,
      cardId: card.id,
      versionId: version.id,
      packageId: pkg.id,
    });

    const customerUser = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customerUser.id);
    const payload = showcaseLeadPayload(category.slug);
    await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
    await request(ctx.server)
      .post(`/showcase/cards/${card.id}/leads`)
      .set('Cookie', customerCookie)
      .send({ ...payload, useAlternateContact: true })
      .expect(201);

    const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({});
    return { category, owner, ownerCookie: await loginAs(ctx.prisma, ownerUser.id), customerCookie, lead };
  }

  it('a lead opens a DIRECT_SHOWCASE round; the owner’s answer publishes it; acceptance matches it', async () => {
    const { owner, ownerCookie, customerCookie, lead } = await leadScenario();
    expect(await roundOf(lead.requestId)).toMatchObject({
      status: MatchRoundStatus.OPEN,
      source: MatchRoundSource.DIRECT_SHOWCASE,
      publishedAt: null,
    });

    const offerId = await submitOffer({ provider: owner, cookie: ownerCookie }, lead.requestId);
    const approved = await requestRow(lead.requestId);
    expect(approved.status).toBe(ServiceRequestStatus.APPROVED);
    expect(approved.directShowcaseProviderId).toBe(owner.id);
    expect(await roundOf(lead.requestId)).toMatchObject({
      status: MatchRoundStatus.OPEN,
      source: MatchRoundSource.DIRECT_SHOWCASE,
      publishedAt: approved.approvedAt,
    });

    await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/offers/${offerId}/action`)
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);
    expect(await roundOf(lead.requestId)).toMatchObject({
      status: MatchRoundStatus.MATCHED,
      source: MatchRoundSource.DIRECT_SHOWCASE,
      matchedOfferId: offerId,
      matchedProviderId: owner.id,
    });
  });

  it('RELEASE after a breach turns the round into a MARKETPLACE round (published with auto-publish on)', async () => {
    await setAutoPublish(true);
    const { customerCookie, lead } = await leadScenario();
    await ctx.prisma.showcaseLead.update({
      where: { id: lead.id },
      data: { slaDueAt: new Date(Date.now() - 60_000) },
    });
    await ctx.app.get(ShowcaseLeadSlaService).execute();

    await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/showcase-fallback`)
      .set('Cookie', customerCookie)
      .send({ decision: 'RELEASE' })
      .expect(200);

    const row = await requestRow(lead.requestId);
    expect(row.status).toBe(ServiceRequestStatus.APPROVED);
    expect(row.directShowcaseProviderId).toBeNull();
    expect(await roundOf(lead.requestId)).toMatchObject({
      status: MatchRoundStatus.OPEN,
      source: MatchRoundSource.MARKETPLACE,
      publishedAt: row.approvedAt,
    });
  });

  it('KEEP_CLOSED and the abandoned-lead sweep both cancel the round with the request', async () => {
    const first = await leadScenario();
    await ctx.prisma.showcaseLead.update({
      where: { id: first.lead.id },
      data: { slaDueAt: new Date(Date.now() - 60_000) },
    });
    await ctx.app.get(ShowcaseLeadSlaService).execute();
    await request(ctx.server)
      .post(`/service-requests/${first.lead.requestId}/showcase-fallback`)
      .set('Cookie', first.customerCookie)
      .send({ decision: 'KEEP_CLOSED' })
      .expect(200);

    const kept = await requestRow(first.lead.requestId);
    expect(kept.status).toBe(ServiceRequestStatus.CANCELLED);
    expect(await roundOf(first.lead.requestId)).toMatchObject({
      status: MatchRoundStatus.CANCELLED,
      cancelledAt: kept.cancelledAt,
    });

    // The sweep closes a breached lead nobody decided on.
    await resetDatabase(ctx.prisma);
    const second = await leadScenario();
    await ctx.prisma.showcaseLead.update({
      where: { id: second.lead.id },
      data: { status: ShowcaseLeadStatus.BREACHED, breachedAt: daysAgo(60), slaDueAt: daysAgo(61) },
    });
    await ctx.app.get(ShowcaseLeadSlaService).execute();

    const swept = await requestRow(second.lead.requestId);
    expect(swept.status).toBe(ServiceRequestStatus.CANCELLED);
    expect(await roundOf(second.lead.requestId)).toMatchObject({
      status: MatchRoundStatus.CANCELLED,
      cancelledAt: swept.cancelledAt,
    });
  });
});

describe('round authority', () => {
  it('a round transition rolls back with the transaction that called it', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const live = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });

    await expect(
      ctx.prisma.$transaction(async (tx) => {
        await tx.serviceRequest.update({
          where: { id: live.id },
          data: { status: ServiceRequestStatus.EXPIRED, expiredAt: new Date() },
        });
        await transitionRoundToExpired(tx, { roundId: roundOneId(live.id), expiredAt: new Date() });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await roundOf(live.id)).toMatchObject({ status: MatchRoundStatus.OPEN, expiredAt: null });
  });

  it('a request inserted without a round (a script, an older release) is born with Round 1 and expires on its clock', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const bare = await ctx.prisma.serviceRequest.create({
      data: {
        categoryId: category.id,
        requestNumber: 'TR-TEST-BARE',
        customerName: 'Müşteri',
        customerPhone: '+905554440001',
        city: 'İstanbul',
        district: 'Kadıköy',
        status: ServiceRequestStatus.APPROVED,
        approvedAt: daysAgo(15),
      },
    });

    await ctx.app.get(RequestExpiryService).expireDueRequests();

    const row = await requestRow(bare.id);
    expect(row.status).toBe(ServiceRequestStatus.EXPIRED);
    expect(await roundOf(bare.id)).toMatchObject({
      roundNumber: 1,
      status: MatchRoundStatus.EXPIRED,
      openedAt: row.submittedAt,
      expiredAt: row.expiredAt,
    });
  });

  it('keeps round ids out of every API response', async () => {
    const { requestId, customerCookie, admin, winner, winnerOfferId } = await matchedScenario();
    const leak = /"(currentRoundId|matchRoundId|roundId)"|mr1_/;

    const responses = await Promise.all([
      request(ctx.server).get(`/service-requests/my/${requestId}`).set('Cookie', customerCookie),
      request(ctx.server).get(`/service-requests/${requestId}/offers`).set('Cookie', customerCookie),
      request(ctx.server).get(`/service-requests/${requestId}`).set('Cookie', admin),
      request(ctx.server).get(`/providers/${winner.provider.id}/offers`).set('Cookie', winner.cookie),
      request(ctx.server)
        .get(`/providers/${winner.provider.id}/offers/${winnerOfferId}`)
        .set('Cookie', winner.cookie),
      request(ctx.server).get(`/service-requests/${requestId}/matched-contact`).set('Cookie', customerCookie),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toMatch(leak);
    }
  });
});
