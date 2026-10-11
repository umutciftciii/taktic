import { randomUUID } from 'node:crypto';
import {
  CreditTransactionType,
  MatchRoundOpenedBy,
  MatchRoundSource,
  MatchRoundStatus,
  OfferStatus,
  ServiceCategoryKind,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addIsoDays, isoDayToStoredDate, todayIsoDay } from '../src/common/date-only';
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';
import { ServiceIssueOutbox } from '../src/modules/notifications/service-issue-outbox.service';
import {
  ACCEPT_OFFER,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
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
 * REL-002 Faz 3 — the customer service issue, end to end through the API:
 * eligibility, idempotency, the reopen into Round N+1 (or MATCH_REVIEW after
 * Round 3), the provider's permanent exclusion on every surface, the
 * zero-refund rule, read-only history, and the races. Every case ends with
 * the operators' consistency script returning nothing.
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
  resetAuthThrottle(ctx.app);
  ctx.notifications.clear();
  delete process.env.CONTACT_SHARING_ENABLED;
  delete process.env.CONTACT_DISCLOSURE_URL;
  delete process.env.CONTACT_DISCLOSURE_VERSION;
  delete process.env.REQUIRE_PHONE_VERIFICATION;
  await setSettings({ serviceIssueReportingEnabled: true });
});

afterEach(async () => {
  await ctx.app.get(ServiceIssueOutbox).whenIdle();
  expect(await roundInconsistencies(ctx.prisma)).toEqual([]);
});

// ── builders ─────────────────────────────────────────────────────────────────

async function setSettings(data: {
  serviceIssueReportingEnabled?: boolean;
  marketplaceAutoPublishEnabled?: boolean;
  providerReviewsEnabled?: boolean;
}) {
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48, ...data },
    update: data,
  });
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

type Party = { provider: { id: string }; userId: string; cookie: string };

async function addProvider(categoryId: string): Promise<Party> {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: user.id, categoryId });
  await grantCredits(ctx.prisma, provider.id, 20);
  return { provider, userId: user.id, cookie: await loginAs(ctx.prisma, user.id) };
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
  return { category, requestId, customerId: customerId!, customerCookie: await loginAs(ctx.prisma, customerId!) };
}

function postOffer(party: Party, requestId: string, body: Record<string, unknown> = offerPayload()) {
  return request(ctx.server)
    .post(`/providers/${party.provider.id}/requests/${requestId}/offers`)
    .set('Cookie', party.cookie)
    .send(body);
}

async function submitOffer(party: Party, requestId: string) {
  return (await postOffer(party, requestId).expect(201)).body.id as string;
}

function accept(requestId: string, offerId: string, cookie: string) {
  return request(ctx.server)
    .post(`/service-requests/${requestId}/offers/${offerId}/action`)
    .set('Cookie', cookie)
    .send(ACCEPT_OFFER);
}

/** The accepted offer's promised days, moved relative to today (Istanbul). */
async function promise(offerId: string, startOffset: number | null, endOffset: number | null) {
  const today = todayIsoDay();
  await ctx.prisma.offer.update({
    where: { id: offerId },
    data: {
      estimatedStartDate: startOffset === null ? null : isoDayToStoredDate(addIsoDays(today, startOffset)),
      estimatedCompletionDate: endOffset === null ? null : isoDayToStoredDate(addIsoDays(today, endOffset)),
    },
  });
}

async function currentRoundId(requestId: string) {
  return (await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId }, select: { currentRoundId: true } }))
    .currentRoundId;
}

function report(requestId: string, cookie: string, body: Record<string, unknown>) {
  return request(ctx.server).post(`/service-requests/${requestId}/service-issue`).set('Cookie', cookie).send(body);
}

async function reportBody(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    roundId: await currentRoundId(requestId),
    reason: 'PROVIDER_NO_SHOW',
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

/** A matched request whose provider's start day has passed (NO_SHOW is open). */
async function matchedRequest(options: { startOffset?: number | null; endOffset?: number | null } = {}) {
  const live = await liveRequest();
  const a = await addProvider(live.category.id);
  const b = await addProvider(live.category.id);
  const offerA = await submitOffer(a, live.requestId);
  const offerB = await submitOffer(b, live.requestId);
  await accept(live.requestId, offerA, live.customerCookie).expect(201);
  await promise(offerA, options.startOffset === undefined ? -2 : options.startOffset, options.endOffset === undefined ? 5 : options.endOffset);
  return { ...live, a, b, offerA, offerB };
}

async function detail(requestId: string, cookie: string) {
  return (await request(ctx.server).get(`/service-requests/my/${requestId}`).set('Cookie', cookie).expect(200)).body;
}

async function offerRefundRows(offerId: string) {
  return ctx.prisma.providerCreditTransaction.count({
    where: { type: CreditTransactionType.OFFER_REFUND, referenceId: offerId },
  });
}

// ── the switch ───────────────────────────────────────────────────────────────

describe('feature flag', () => {
  it('off: the endpoint is a 404 and the detail offers nothing', async () => {
    const s = await matchedRequest();
    await setSettings({ serviceIssueReportingEnabled: false });

    await report(s.requestId, s.customerCookie, await reportBody(s.requestId)).expect(404);
    const body = await detail(s.requestId, s.customerCookie);
    expect(body.serviceIssue).toMatchObject({ canReport: false, unavailableReason: 'FEATURE_DISABLED' });
    expect(await ctx.prisma.providerServiceIncident.count()).toBe(0);
  });
});

// ── who may report ───────────────────────────────────────────────────────────

describe('ownership', () => {
  it('another customer, a provider and a missing request all get 404 — no entity leak', async () => {
    const s = await matchedRequest();
    const stranger = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const body = await reportBody(s.requestId);

    await report(s.requestId, await loginAs(ctx.prisma, stranger.id), body).expect(404);
    await report('does-not-exist', s.customerCookie, body).expect(404);
    await report(s.requestId, s.a.cookie, body).expect(403);
    expect(await ctx.prisma.providerServiceIncident.count()).toBe(0);
  });
});

// ── eligibility (server clock, Istanbul days) ────────────────────────────────

describe('eligibility matrix', () => {
  it('before the start day only PROVIDER_CANCELLED_BEFORE_START is open, with a note', async () => {
    const s = await matchedRequest({ startOffset: 0, endOffset: 3 });
    const view = (await detail(s.requestId, s.customerCookie)).serviceIssue;
    expect(view).toMatchObject({
      canReport: true,
      availableReasons: ['PROVIDER_CANCELLED_BEFORE_START'],
      nextOpensOn: addIsoDays(todayIsoDay(), 1),
      consequence: 'REOPEN',
      maxAutoRoundsReached: false,
    });

    const early = await report(s.requestId, s.customerCookie, await reportBody(s.requestId)).expect(409);
    expect(early.body).toMatchObject({
      code: 'SERVICE_ISSUE_REASON_NOT_YET_AVAILABLE',
      opensOn: addIsoDays(todayIsoDay(), 1),
    });

    const noNote = await report(
      s.requestId,
      s.customerCookie,
      await reportBody(s.requestId, { reason: 'PROVIDER_CANCELLED_BEFORE_START', note: 'kısa' }),
    ).expect(400);
    expect(noNote.body.code).toBe('SERVICE_ISSUE_NOTE_REQUIRED');

    const ok = await report(
      s.requestId,
      s.customerCookie,
      await reportBody(s.requestId, {
        reason: 'PROVIDER_CANCELLED_BEFORE_START',
        note: '  Usta   aradı ve\n bu işi yapamayacağını söyledi.  ',
      }),
    ).expect(200);
    expect(ok.body).toMatchObject({ outcome: 'REOPENED', failedRoundNumber: 1, replayed: false });
    const incident = await ctx.prisma.providerServiceIncident.findUniqueOrThrow({ where: { id: ok.body.incidentId } });
    expect(incident).toMatchObject({
      customerNote: 'Usta aradı ve bu işi yapamayacağını söyledi.',
      eligibilityBasis: 'PROVIDER_CANCELLATION',
      status: 'REPORTED',
    });
  });

  it('between start and end: no-show, not started and OTHER; not "not completed" or "stopped"', async () => {
    const s = await matchedRequest({ startOffset: -1, endOffset: 2 });
    const view = (await detail(s.requestId, s.customerCookie)).serviceIssue;
    expect([...view.availableReasons].sort()).toEqual(
      ['OTHER', 'PROVIDER_CANCELLED_BEFORE_START', 'PROVIDER_NO_SHOW', 'WORK_NOT_STARTED'].sort(),
    );
    expect(view.nextOpensOn).toBe(addIsoDays(todayIsoDay(), 3));

    for (const reason of ['WORK_NOT_COMPLETED', 'PROVIDER_STOPPED_WORK']) {
      const refused = await report(s.requestId, s.customerCookie, await reportBody(s.requestId, { reason })).expect(409);
      expect(refused.body).toMatchObject({
        code: 'SERVICE_ISSUE_REASON_NOT_YET_AVAILABLE',
        opensOn: addIsoDays(todayIsoDay(), 3),
      });
    }
    const other = await report(s.requestId, s.customerCookie, await reportBody(s.requestId, { reason: 'OTHER' })).expect(400);
    expect(other.body.code).toBe('SERVICE_ISSUE_NOTE_REQUIRED');
    await report(s.requestId, s.customerCookie, await reportBody(s.requestId, { reason: 'WORK_NOT_STARTED' })).expect(200);
  });

  it('the end day itself is not "passed"; the day after it every reason is open', async () => {
    const onEnd = await matchedRequest({ startOffset: -3, endOffset: 0 });
    expect((await detail(onEnd.requestId, onEnd.customerCookie)).serviceIssue.availableReasons).not.toContain(
      'PROVIDER_STOPPED_WORK',
    );

    const after = await matchedRequest({ startOffset: -3, endOffset: -1 });
    const view = (await detail(after.requestId, after.customerCookie)).serviceIssue;
    expect(view.availableReasons).toHaveLength(6);
    expect(view.nextOpensOn).toBeNull();
    await report(
      after.requestId,
      after.customerCookie,
      await reportBody(after.requestId, { reason: 'PROVIDER_STOPPED_WORK' }),
    ).expect(200);
  });

  it('a match without promised days is support-only: no reason, not even a cancellation', async () => {
    const s = await matchedRequest({ startOffset: null, endOffset: null });
    expect((await detail(s.requestId, s.customerCookie)).serviceIssue).toMatchObject({
      canReport: false,
      supportOnly: true,
      unavailableReason: 'SCHEDULE_MISSING',
      availableReasons: [],
    });
    const refused = await report(
      s.requestId,
      s.customerCookie,
      await reportBody(s.requestId, { reason: 'PROVIDER_CANCELLED_BEFORE_START', note: 'x'.repeat(30) }),
    ).expect(409);
    expect(refused.body.code).toBe('SERVICE_ISSUE_REQUIRES_SUPPORT');
  });

  it('refuses a client-supplied date field and a stale round', async () => {
    const s = await matchedRequest();
    await report(s.requestId, s.customerCookie, { ...(await reportBody(s.requestId)), today: '2099-01-01' }).expect(400);
    const stale = await report(s.requestId, s.customerCookie, await reportBody(s.requestId, { roundId: 'mr9_x' })).expect(
      409,
    );
    expect(stale.body.code).toBe('ROUND_CHANGED');
  });

  it('an unmatched request answers REQUEST_NOT_MATCHED', async () => {
    const live = await liveRequest();
    const refused = await report(live.requestId, live.customerCookie, await reportBody(live.requestId)).expect(409);
    expect(refused.body.code).toBe('REQUEST_NOT_MATCHED');
    expect((await detail(live.requestId, live.customerCookie)).serviceIssue.unavailableReason).toBe('NOT_MATCHED');
  });
});

// ── idempotency ──────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('same key + same payload replays; same key + other payload 409; other key on the failed round 409', async () => {
    const s = await matchedRequest();
    const body = await reportBody(s.requestId);

    const first = await report(s.requestId, s.customerCookie, body).expect(200);
    const replay = await report(s.requestId, s.customerCookie, body).expect(200);
    expect(replay.body).toMatchObject({ incidentId: first.body.incidentId, replayed: true, outcome: 'REOPENED' });
    expect(replay.body.currentRound.id).toBe(first.body.currentRound.id);

    const reused = await report(s.requestId, s.customerCookie, { ...body, reason: 'WORK_NOT_STARTED' }).expect(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const again = await report(s.requestId, s.customerCookie, { ...body, idempotencyKey: randomUUID() }).expect(409);
    expect(again.body.code).toBe('ROUND_ALREADY_FAILED');

    expect(await ctx.prisma.providerServiceIncident.count()).toBe(1);
    expect(await ctx.prisma.serviceRequestMatchRound.count({ where: { requestId: s.requestId } })).toBe(2);
    // One set of notices: the replay enqueued nothing.
    expect(
      await ctx.prisma.notificationLog.count({ where: { dedupeKey: { startsWith: 'service-issue-recorded:' } } }),
    ).toBe(1);
  });

  it('a duplicate report race: two keys → one incident, one 409; one key twice → the same incident', async () => {
    const s = await matchedRequest();
    const [x, y] = await Promise.all([
      report(s.requestId, s.customerCookie, await reportBody(s.requestId)),
      report(s.requestId, s.customerCookie, await reportBody(s.requestId)),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    expect(['ROUND_ALREADY_FAILED', 'CONCURRENT_MODIFICATION', 'ROUND_CHANGED']).toContain(loser.body.code);
    expect(await ctx.prisma.providerServiceIncident.count()).toBe(1);

    const t = await matchedRequest();
    const body = await reportBody(t.requestId);
    const both = await Promise.all([report(t.requestId, t.customerCookie, body), report(t.requestId, t.customerCookie, body)]);
    const ok = both.filter((response) => response.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const response of both) {
      expect([200, 409]).toContain(response.status);
      if (response.status === 409) expect(response.body.code).toBe('CONCURRENT_MODIFICATION');
    }
    expect(new Set(ok.map((response) => response.body.incidentId)).size).toBe(1);
    expect(await ctx.prisma.providerServiceIncident.count({ where: { requestId: t.requestId } })).toBe(1);
  });
});

// ── races with the other lifecycle writers ─────────────────────────────────

describe('races', () => {
  it('issue vs complete: exactly one wins, the other 409s, nothing half-written', async () => {
    const s = await matchedRequest();
    const [issue, complete] = await Promise.all([
      report(s.requestId, s.customerCookie, await reportBody(s.requestId)),
      request(ctx.server).post(`/service-requests/${s.requestId}/complete`).set('Cookie', s.customerCookie),
    ]);
    const statuses = [issue.status, complete.status];
    expect(statuses.filter((status) => status === 200 || status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: s.requestId } });
    if (issue.status === 200) {
      expect(row.status).toBe(ServiceRequestStatus.APPROVED);
    } else {
      expect(row.status).toBe(ServiceRequestStatus.COMPLETED);
      expect(await ctx.prisma.providerServiceIncident.count()).toBe(0);
    }
  });

  it('issue vs staff cancel: exactly one wins', async () => {
    const s = await matchedRequest();
    const admin = await adminCookie();
    const [issue, cancel] = await Promise.all([
      report(s.requestId, s.customerCookie, await reportBody(s.requestId)),
      request(ctx.server)
        .post(`/service-requests/${s.requestId}/cancel`)
        .set('Cookie', admin)
        .send({ expectedMatchedOfferId: s.offerA }),
    ]);
    const wins = [issue.status, cancel.status].filter((status) => status === 200 || status === 201);
    expect(wins).toHaveLength(1);
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: s.requestId } });
    expect([ServiceRequestStatus.APPROVED, ServiceRequestStatus.CANCELLED]).toContain(row.status);
    if (row.status === ServiceRequestStatus.APPROVED) {
      // The issue won: the cancel touched nothing, A's credit is untouched.
      expect(await offerRefundRows(s.offerA)).toBe(0);
    }
  });
});

// ── the reopen, end to end ───────────────────────────────────────────────────

describe('Round 1 → Round 2 (critical path)', () => {
  it('A fails → B wins Round 2; A excluded everywhere, history read-only, no refund; B completes and can be reviewed', async () => {
    await setSettings({ providerReviewsEnabled: true });
    const s = await matchedRequest();
    // A and the customer talked in Round 1.
    const thread1 = await request(ctx.server)
      .post('/messages/threads/resolve')
      .set('Cookie', s.customerCookie)
      .send({ requestId: s.requestId })
      .expect(201);
    await request(ctx.server)
      .post(`/messages/threads/${thread1.body.id}/messages`)
      .set('Cookie', s.a.cookie)
      .send({ body: 'Yarın geliyorum.' })
      .expect(201);
    const ledgerBefore = await ctx.prisma.providerCreditTransaction.count();

    const issued = await report(s.requestId, s.customerCookie, await reportBody(s.requestId)).expect(200);
    expect(issued.body).toMatchObject({
      outcome: 'REOPENED',
      failedRoundNumber: 1,
      requestStatus: ServiceRequestStatus.APPROVED,
      currentRound: { roundNumber: 2, status: MatchRoundStatus.OPEN },
    });
    expect(issued.body.incidentNumber).toMatch(/^INC-\d{4}-\d{6}$/);

    // Round shapes and the request projection.
    const rounds = await ctx.prisma.serviceRequestMatchRound.findMany({
      where: { requestId: s.requestId },
      orderBy: { roundNumber: 'asc' },
    });
    expect(rounds[0]).toMatchObject({
      status: MatchRoundStatus.FAILED,
      matchedOfferId: s.offerA,
      matchedProviderId: s.a.provider.id,
      failureIncidentId: issued.body.incidentId,
    });
    expect(rounds[0]!.failedAt).not.toBeNull();
    expect(rounds[1]).toMatchObject({
      id: `mr2_${s.requestId}`,
      roundNumber: 2,
      status: MatchRoundStatus.OPEN,
      source: MatchRoundSource.MARKETPLACE,
      openedBy: MatchRoundOpenedBy.SERVICE_ISSUE,
      reminderSentAt: null,
    });
    expect(rounds[1]!.publishedAt).not.toBeNull();
    expect(rounds[1]!.expiresAt!.getTime() - rounds[1]!.publishedAt!.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: s.requestId } });
    expect(row).toMatchObject({
      status: ServiceRequestStatus.APPROVED,
      matchedOfferId: null,
      matchedAt: null,
      directShowcaseProviderId: null,
    });
    expect((await ctx.prisma.offer.findUniqueOrThrow({ where: { id: s.offerA } })).status).toBe(OfferStatus.ACCEPTED);
    expect(
      await ctx.prisma.serviceRequestProviderExclusion.findUniqueOrThrow({
        where: { requestId_providerId: { requestId: s.requestId, providerId: s.a.provider.id } },
      }),
    ).toMatchObject({ sourceRoundId: rounds[0]!.id, incidentId: issued.body.incidentId, reason: 'PROVIDER_NO_SHOW' });

    // Zero credit movement: the issue transaction wrote no ledger row.
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(ledgerBefore);
    expect(await offerRefundRows(s.offerA)).toBe(0);

    // A is excluded on every surface; B (a Round 1 loser) sees Round 2.
    const aList = await request(ctx.server).get(`/providers/${s.a.provider.id}/requests`).set('Cookie', s.a.cookie).expect(200);
    expect(aList.body.map((item: { id: string }) => item.id)).not.toContain(s.requestId);
    await request(ctx.server).get(`/providers/${s.a.provider.id}/requests/${s.requestId}`).set('Cookie', s.a.cookie).expect(404);
    await postOffer(s.a, s.requestId).expect(404);
    const bList = await request(ctx.server).get(`/providers/${s.b.provider.id}/requests`).set('Cookie', s.b.cookie).expect(200);
    expect(bList.body.map((item: { id: string }) => item.id)).toContain(s.requestId);
    // A's stale contact and the request-available fan-out.
    await request(ctx.server)
      .get(`/providers/${s.a.provider.id}/offers/${s.offerA}/matched-contact`)
      .set('Cookie', s.a.cookie)
      .expect(404);
    const invitations = await ctx.prisma.notificationLog.findMany({
      where: { template: 'request-available', requestId: s.requestId },
      select: { dedupeKey: true, providerId: true },
    });
    expect(invitations.some((row) => row.providerId === s.a.provider.id && row.dedupeKey?.endsWith(':r2'))).toBe(false);
    expect(invitations.some((row) => row.providerId === s.b.provider.id && row.dedupeKey?.endsWith(':r2'))).toBe(true);
    // A's provider-facing offer says what happened.
    const aOffer = await request(ctx.server)
      .get(`/providers/${s.a.provider.id}/offers/${s.offerA}`)
      .set('Cookie', s.a.cookie)
      .expect(200);
    expect(aOffer.body).toMatchObject({ matchOutcome: 'FAILED', acceptedWorkScope: null });
    expect(aOffer.body.matchFailure).toMatchObject({ incidentNumber: issued.body.incidentNumber, reason: 'PROVIDER_NO_SHOW' });

    // Notices: customer recorded + reopened, A, support — and A's mail
    // carries no customer detail.
    await ctx.app.get(ServiceIssueOutbox).deliverPending();
    const templates = (
      await ctx.prisma.notificationLog.findMany({
        where: { requestId: s.requestId, template: { in: ['service-issue-recorded', 'request-reopened', 'provider-incident-opened', 'provider-incident-new'] } },
        select: { template: true },
      })
    ).map((entry) => entry.template);
    expect(templates.sort()).toEqual(
      ['provider-incident-new', 'provider-incident-opened', 'request-reopened', 'service-issue-recorded'].sort(),
    );
    const providerMail = ctx.notifications.lastOfTemplate('provider-incident-opened');
    const customer = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: s.requestId } });
    expect(JSON.stringify(providerMail)).not.toContain(customer.customerPhone);
    expect(JSON.stringify(providerMail)).not.toContain(customer.customerEmail ?? '@@');
    expect(JSON.stringify(providerMail)).not.toContain(customer.customerName);

    // Round 2: B offers and is accepted.
    const offerB2 = await submitOffer(s.b, s.requestId);
    // The operator's "active offers" count is per round: A's ACCEPTED Round 1
    // winner does not hide B's live Round 2 offer.
    const bAdmin = await request(ctx.server)
      .get(`/providers/${s.b.provider.id}/admin-detail`)
      .set('Cookie', await adminCookie())
      .expect(200);
    expect(bAdmin.body.activeOffersCount).toBe(1);
    await accept(s.requestId, offerB2, s.customerCookie).expect(201);
    // A's Round 1 offer can never be accepted again.
    const stale = await accept(s.requestId, s.offerA, s.customerCookie).expect(409);
    expect(stale.body.message).toBeDefined();

    // A's thread: readable, read-only; B cannot see it; B's thread is active.
    const historical = await request(ctx.server)
      .get(`/messages/threads/${thread1.body.id}`)
      .set('Cookie', s.a.cookie)
      .expect(200);
    expect(historical.body).toMatchObject({ mode: 'READ_ONLY', closedReason: 'FAILED', active: false, unreadCount: 0 });
    expect(historical.body.messages.map((message: { body: string }) => message.body)).toEqual(['Yarın geliyorum.']);
    await request(ctx.server).get(`/messages/threads/${thread1.body.id}/messages`).set('Cookie', s.customerCookie).expect(200);
    const write = await request(ctx.server)
      .post(`/messages/threads/${thread1.body.id}/messages`)
      .set('Cookie', s.a.cookie)
      .send({ body: 'Hâlâ buradayım.' })
      .expect(403);
    expect(write.body.code).toBe('THREAD_READ_ONLY');
    const mark = await request(ctx.server)
      .post(`/messages/threads/${thread1.body.id}/read`)
      .set('Cookie', s.customerCookie)
      .expect(403);
    expect(mark.body.code).toBe('THREAD_READ_ONLY');
    await request(ctx.server).get(`/messages/threads/${thread1.body.id}`).set('Cookie', s.b.cookie).expect(404);
    const thread2 = await request(ctx.server)
      .post('/messages/threads/resolve')
      .set('Cookie', s.customerCookie)
      .send({ requestId: s.requestId })
      .expect(201);
    expect(thread2.body.id).not.toBe(thread1.body.id);
    await request(ctx.server)
      .post(`/messages/threads/${thread2.body.id}/messages`)
      .set('Cookie', s.b.cookie)
      .send({ body: 'Yarın geliyoruz.' })
      .expect(201);
    const contact = await request(ctx.server)
      .get(`/service-requests/${s.requestId}/matched-contact`)
      .set('Cookie', s.customerCookie)
      .expect(200);
    expect(contact.body.provider.id).toBe(s.b.provider.id);
    const inbox = await request(ctx.server).get('/messages/threads').set('Cookie', s.customerCookie).expect(200);
    const byId = new Map(inbox.body.map((thread: { id: string }) => [thread.id, thread]));
    expect(byId.get(thread1.body.id)).toMatchObject({ mode: 'READ_ONLY', closedReason: 'FAILED', unreadCount: 0 });
    expect(byId.get(thread2.body.id)).toMatchObject({ mode: 'ACTIVE', closedReason: null });

    // The customer's history.
    const view = await detail(s.requestId, s.customerCookie);
    expect(view.currentRound).toMatchObject({ roundNumber: 2, status: MatchRoundStatus.MATCHED });
    expect(view.rounds).toHaveLength(2);
    expect(view.rounds[0]).toMatchObject({
      roundNumber: 1,
      status: MatchRoundStatus.FAILED,
      provider: { businessName: expect.any(String) },
      issue: { reason: 'PROVIDER_NO_SHOW', status: 'RECORDED', incidentNumber: issued.body.incidentNumber },
      messageThreadId: thread1.body.id,
    });
    expect(JSON.stringify(view.rounds)).not.toMatch(/providerResponse|reviewNote|customerNote/);

    // B completes; B can be reviewed; A cannot.
    await request(ctx.server).post(`/service-requests/${s.requestId}/complete`).set('Cookie', s.customerCookie).expect(201);
    const reviewState = await request(ctx.server)
      .get(`/service-requests/${s.requestId}/review`)
      .set('Cookie', s.customerCookie)
      .expect(200);
    expect(reviewState.body.eligibility).toBe('ok');
    await request(ctx.server)
      .post(`/service-requests/${s.requestId}/review`)
      .set('Cookie', s.customerCookie)
      .send({ rating: 5 })
      .expect(201);
    const review = await ctx.prisma.providerReview.findFirstOrThrow({ where: { requestId: s.requestId } });
    expect(review.providerId).toBe(s.b.provider.id);

    // Still no refund of A's accepted offer, after everything.
    expect(await offerRefundRows(s.offerA)).toBe(0);
  });

  it('the database refuses an excluded provider’s offer and an offer into a closed round', async () => {
    const s = await matchedRequest();
    await report(s.requestId, s.customerCookie, await reportBody(s.requestId)).expect(200);

    await expect(
      ctx.prisma.offer.create({
        data: { requestId: s.requestId, providerId: s.a.provider.id, offerNumber: 'RAW-1', priceAmount: 1000, message: 'x' },
      }),
    ).rejects.toThrow(/PROVIDER_EXCLUDED/);
    // The round-link default fills Round 2 first, then the guard runs: the
    // two triggers compose (name order).
    const c = await addProvider(s.category.id);
    const raw = await ctx.prisma.offer.create({
      data: { requestId: s.requestId, providerId: c.provider.id, offerNumber: 'RAW-2', priceAmount: 1000, message: 'x' },
      select: { matchRoundId: true },
    });
    expect(raw.matchRoundId).toBe(`mr2_${s.requestId}`);
    await expect(
      ctx.prisma.offer.create({
        data: {
          requestId: s.requestId,
          providerId: s.b.provider.id,
          matchRoundId: `mr1_${s.requestId}`,
          offerNumber: 'RAW-3',
          priceAmount: 1000,
          message: 'x',
        },
      }),
    ).rejects.toThrow(/OFFER_ROUND_CLOSED/);
    // Exclusions and incidents are permanent; a FAILED round cannot move.
    await expect(ctx.prisma.serviceRequestProviderExclusion.deleteMany({ where: { requestId: s.requestId } })).rejects.toThrow(
      /permanent/,
    );
    await expect(ctx.prisma.providerServiceIncident.deleteMany({})).rejects.toThrow(/never deleted/);
    await expect(
      ctx.prisma.serviceRequestMatchRound.update({
        where: { id: `mr1_${s.requestId}` },
        data: { status: MatchRoundStatus.MATCHED, failedAt: null, failureIncidentId: null },
      }),
    ).rejects.toThrow(/cannot change/);
    // Clean up the raw offer so the consistency script sees only real data.
    await ctx.prisma.offer.delete({ where: { id: (await ctx.prisma.offer.findFirstOrThrow({ where: { offerNumber: 'RAW-2' } })).id } });
  });
});

describe('Round 3 → MATCH_REVIEW', () => {
  it('three failures: R1→R2→R3→MATCH_REVIEW, no Round 4, invisible to the market; cancel moves no credit', async () => {
    const live = await liveRequest();
    const providers = [await addProvider(live.category.id), await addProvider(live.category.id), await addProvider(live.category.id)];
    const observer = await addProvider(live.category.id);

    for (const [index, party] of providers.entries()) {
      const offerId = await submitOffer(party, live.requestId);
      await accept(live.requestId, offerId, live.customerCookie).expect(201);
      await promise(offerId, -2, 3);
      const view = (await detail(live.requestId, live.customerCookie)).serviceIssue;
      expect(view.maxAutoRoundsReached).toBe(index === 2);
      expect(view.consequence).toBe(index === 2 ? 'ADMIN_REVIEW' : 'REOPEN');
      const issued = await report(live.requestId, live.customerCookie, await reportBody(live.requestId)).expect(200);
      expect(issued.body.failedRoundNumber).toBe(index + 1);
      expect(issued.body.outcome).toBe(index === 2 ? 'ADMIN_REVIEW' : 'REOPENED');
    }

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: live.requestId },
      select: { status: true, matchedOfferId: true, currentRoundId: true },
    });
    expect(row).toMatchObject({
      status: ServiceRequestStatus.MATCH_REVIEW,
      matchedOfferId: null,
      currentRoundId: `mr3_${live.requestId}`,
    });
    expect(await ctx.prisma.serviceRequestMatchRound.count({ where: { requestId: live.requestId } })).toBe(3);
    expect(await ctx.prisma.serviceRequestProviderExclusion.count({ where: { requestId: live.requestId } })).toBe(3);
    expect(
      await ctx.prisma.notificationLog.count({ where: { template: 'request-match-review', requestId: live.requestId } }),
    ).toBe(1);

    // Not on the market, not even for a provider never excluded.
    const list = await request(ctx.server)
      .get(`/providers/${observer.provider.id}/requests`)
      .set('Cookie', observer.cookie)
      .expect(200);
    expect(list.body.map((item: { id: string }) => item.id)).not.toContain(live.requestId);
    await postOffer(observer, live.requestId).expect(404);
    const view = await detail(live.requestId, live.customerCookie);
    expect(view.status).toBe('MATCH_REVIEW');
    expect(view.serviceIssue).toMatchObject({ canReport: false, unavailableReason: 'NOT_MATCHED' });

    // The customer may still cancel; nothing about credit moves and Round 3
    // stays FAILED.
    const ledgerBefore = await ctx.prisma.providerCreditTransaction.count();
    await request(ctx.server)
      .post(`/service-requests/${live.requestId}/cancel`)
      .set('Cookie', live.customerCookie)
      .send({})
      .expect(201);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(ledgerBefore);
    const cancelled = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: live.requestId },
      include: { cancellation: true, currentRound: true },
    });
    expect(cancelled.status).toBe(ServiceRequestStatus.CANCELLED);
    expect(cancelled.currentRound.status).toBe(MatchRoundStatus.FAILED);
    expect(cancelled.cancellation).toMatchObject({ winnerRefundDecision: 'NOT_MATCHED', closedOfferIds: [], refundedOfferIds: [] });
  });
});

// ── credit ───────────────────────────────────────────────────────────────────

describe('no refund for a failed match', () => {
  it('manual offer refund of the failed winner is 409 FAILED_MATCH_NOT_REFUNDABLE; a competitor stays refundable', async () => {
    const s = await matchedRequest();
    await report(s.requestId, s.customerCookie, await reportBody(s.requestId)).expect(200);
    const admin = await adminCookie();

    const refused = await request(ctx.server)
      .post(`/offers/${s.offerA}/refund-credit`)
      .set('Cookie', admin)
      .send({ reasonCode: 'GOODWILL' })
      .expect(409);
    expect(refused.body.code).toBe('FAILED_MATCH_NOT_REFUNDABLE');
    expect(await offerRefundRows(s.offerA)).toBe(0);

    // B's Round 1 offer (rejected by A's acceptance) is a normal offer.
    await request(ctx.server)
      .post(`/offers/${s.offerB}/refund-credit`)
      .set('Cookie', admin)
      .send({ reasonCode: 'GOODWILL' })
      .expect(201);
    expect(await offerRefundRows(s.offerB)).toBe(1);
  });

  it('the unviewed-offer worker never refunds the failed winner; a failed round’s unviewed competitor keeps its 48h refund', async () => {
    const s = await matchedRequest();
    await report(s.requestId, s.customerCookie, await reportBody(s.requestId)).expect(200);
    // Staged: both offers look unviewed and past their refund moment. The
    // winner would be a candidate on every other clause.
    const past = new Date(Date.now() - 60_000);
    await ctx.prisma.offer.updateMany({
      where: { id: { in: [s.offerA, s.offerB] } },
      data: { viewedAt: null, refundBlockedAt: null, refundBlockedReason: null, unviewedRefundEligibleAt: past },
    });

    const worker = ctx.app.get(UnviewedOfferRefundService);
    const scan = await worker.dryRun();
    expect(scan.items.map((item: { offerId: string }) => item.offerId)).toEqual([s.offerB]);
    const run = await worker.execute();
    expect(run.refunded).toBe(1);
    expect(await offerRefundRows(s.offerA)).toBe(0);
    expect(await offerRefundRows(s.offerB)).toBe(1);
  });
});

// ── vitrin direct lead ───────────────────────────────────────────────────────

describe('direct showcase → marketplace', () => {
  async function matchedLead() {
    const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF, offerCreditCost: 2 });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const owner = await createDiscoverableProvider(ctx.prisma, {
      userId: ownerUser.id,
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: null }],
    });
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, { providerId: owner.id, categoryId: category.id });
    const pkg = await createShowcasePackage(ctx.prisma);
    await createLiveShowcasePlacement(ctx, { providerId: owner.id, cardId: card.id, versionId: version.id, packageId: pkg.id });
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
    const ownerParty = { provider: owner, userId: ownerUser.id, cookie: await loginAs(ctx.prisma, ownerUser.id) };
    const offerId = await submitOffer(ownerParty, lead.requestId);
    await accept(lead.requestId, offerId, customerCookie).expect(201);
    await promise(offerId, -2, 3);
    return { category, owner: ownerParty, customerCookie, lead, offerId };
  }

  it('auto-publish off: Round 2 is a MARKETPLACE round waiting in moderation; the lead stays ANSWERED', async () => {
    const s = await matchedLead();
    await report(s.lead.requestId, s.customerCookie, await reportBody(s.lead.requestId)).expect(200);

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: s.lead.requestId }, include: { currentRound: true } });
    expect(row).toMatchObject({ status: ServiceRequestStatus.SUBMITTED, directShowcaseProviderId: null, matchedOfferId: null });
    expect(row.currentRound).toMatchObject({ roundNumber: 2, source: MatchRoundSource.MARKETPLACE, publishedAt: null });
    expect((await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: s.lead.id } })).status).toBe('ANSWERED');

    // An operator approves it: Round 2's clock starts then.
    await request(ctx.server)
      .patch(`/service-requests/${s.lead.requestId}/status`)
      .set('Cookie', await adminCookie())
      .send({ status: ServiceRequestStatus.APPROVED })
      .expect(200);
    const approved = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: s.lead.requestId }, include: { currentRound: true } });
    expect(approved.currentRound.publishedAt).toEqual(approved.approvedAt);

    // A marketplace provider offers at the normal price; the owner cannot.
    const other = await addProvider(s.category.id);
    const offer = await postOffer(other, s.lead.requestId).expect(201);
    expect(offer.body.creditCost).toBe(2);
    await postOffer(s.owner, s.lead.requestId).expect(404);

    // The owner's lead inbox keeps the lead, frozen as history.
    const inbox = await request(ctx.server)
      .get(`/providers/${s.owner.provider.id}/showcase/leads/${s.lead.id}`)
      .set('Cookie', s.owner.cookie)
      .expect(200);
    expect(inbox.body.request).toMatchObject({ status: 'MATCH_ENDED', matchEnded: true });
    expect(JSON.stringify(inbox.body)).not.toMatch(/providerExclusions/);
    const list = await request(ctx.server)
      .get(`/providers/${s.owner.provider.id}/showcase/leads`)
      .set('Cookie', s.owner.cookie)
      .expect(200);
    expect(list.body.leads[0].request.status).toBe('MATCH_ENDED');
  });

  it('auto-publish on: Round 2 is published at once', async () => {
    await setSettings({ marketplaceAutoPublishEnabled: true });
    const s = await matchedLead();
    await report(s.lead.requestId, s.customerCookie, await reportBody(s.lead.requestId)).expect(200);
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: s.lead.requestId }, include: { currentRound: true } });
    expect(row.status).toBe(ServiceRequestStatus.APPROVED);
    expect(row.currentRound.publishedAt).not.toBeNull();
    expect(row.currentRound.source).toBe(MatchRoundSource.MARKETPLACE);
  });
});
