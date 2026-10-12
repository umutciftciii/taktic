import { randomUUID } from 'node:crypto';
import {
  AdminPermission,
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
import { formatRel002Event } from '../src/common/rel-002-events';
import { GRANTABLE_ADMIN_PERMISSIONS } from '../src/modules/auth/admin-permissions';
import { ServiceIssueOutbox } from '../src/modules/notifications/service-issue-outbox.service';
import {
  ACCEPT_OFFER,
  createAdminWithPermissions,
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
 * REL-002 Faz 5 — staff recovery from MATCH_REVIEW, end to end through the
 * API: the permission (SUPER_ADMIN only), the guards, the canonical publish
 * gate on both sides of the switch, idempotency and the races, exclusions and
 * credit left exactly as they were, no hard cap (Round 5 after Round 4), the
 * direct-showcase chain, the timeline and the queue. Every case ends with the
 * operators' consistency script returning nothing.
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
  delete process.env.REQUIRE_PHONE_VERIFICATION;
  await setSettings({ serviceIssueReportingEnabled: true, marketplaceAutoPublishEnabled: false });
});

afterEach(async () => {
  await ctx.app.get(ServiceIssueOutbox).whenIdle();
  expect(await roundInconsistencies(ctx.prisma)).toEqual([]);
});

// ── builders ─────────────────────────────────────────────────────────────────

async function setSettings(data: { serviceIssueReportingEnabled?: boolean; marketplaceAutoPublishEnabled?: boolean }) {
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48, ...data },
    update: data,
  });
}

async function superAdmin() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { id: admin.id, cookie: await loginAs(ctx.prisma, admin.id) };
}

async function sessionWith(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return loginAs(ctx.prisma, admin.id);
}

type Party = { provider: { id: string }; userId: string; cookie: string };

async function addProvider(categoryId: string): Promise<Party> {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: user.id, categoryId });
  await grantCredits(ctx.prisma, provider.id, 20);
  return { provider, userId: user.id, cookie: await loginAs(ctx.prisma, user.id) };
}

async function liveRequest(sa: string) {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
  const created = await request(ctx.server).post('/service-requests').send(serviceRequestPayload(category.slug)).expect(201);
  const requestId = created.body.id as string;
  await approve(requestId, sa);
  const { customerId } = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
  return { category, requestId, customerId: customerId!, customerCookie: await loginAs(ctx.prisma, customerId!) };
}

function approve(requestId: string, sa: string) {
  return request(ctx.server)
    .patch(`/service-requests/${requestId}/status`)
    .set('Cookie', sa)
    .send({ status: ServiceRequestStatus.APPROVED })
    .expect(200);
}

function postOffer(party: Party, requestId: string) {
  return request(ctx.server)
    .post(`/providers/${party.provider.id}/requests/${requestId}/offers`)
    .set('Cookie', party.cookie)
    .send(offerPayload());
}

async function submitOffer(party: Party, requestId: string) {
  return (await postOffer(party, requestId).expect(201)).body.id as string;
}

function accept(requestId: string, offerId: string, cookie: string) {
  return request(ctx.server).post(`/service-requests/${requestId}/offers/${offerId}/action`).set('Cookie', cookie).send(ACCEPT_OFFER);
}

async function promise(offerId: string, startOffset: number, endOffset: number) {
  const today = todayIsoDay();
  await ctx.prisma.offer.update({
    where: { id: offerId },
    data: {
      estimatedStartDate: isoDayToStoredDate(addIsoDays(today, startOffset)),
      estimatedCompletionDate: isoDayToStoredDate(addIsoDays(today, endOffset)),
    },
  });
}

async function currentRoundId(requestId: string) {
  return (await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId }, select: { currentRoundId: true } }))
    .currentRoundId;
}

async function failCurrentMatch(requestId: string, customerCookie: string) {
  return request(ctx.server)
    .post(`/service-requests/${requestId}/service-issue`)
    .set('Cookie', customerCookie)
    .send({ roundId: await currentRoundId(requestId), reason: 'PROVIDER_NO_SHOW', idempotencyKey: randomUUID() })
    .expect(200);
}

/** One round: the party offers, the customer accepts, the start day passes, the customer reports. */
async function failRoundWith(requestId: string, customerCookie: string, party: Party) {
  const offerId = await submitOffer(party, requestId);
  await accept(requestId, offerId, customerCookie).expect(201);
  await promise(offerId, -2, 3);
  await failCurrentMatch(requestId, customerCookie);
  return offerId;
}

/**
 * A request whose three automatic rounds failed with A, B and C: MATCH_REVIEW
 * on Round 3. E offered in Round 1 and lost to A (never excluded).
 */
async function matchReviewRequest() {
  const sa = await superAdmin();
  const live = await liveRequest(sa.cookie);
  const [a, b, c, d, e] = [
    await addProvider(live.category.id),
    await addProvider(live.category.id),
    await addProvider(live.category.id),
    await addProvider(live.category.id),
    await addProvider(live.category.id),
  ];
  const offerE = await submitOffer(e, live.requestId);
  const offerA = await failRoundWith(live.requestId, live.customerCookie, a);
  const offerB = await failRoundWith(live.requestId, live.customerCookie, b);
  const offerC = await failRoundWith(live.requestId, live.customerCookie, c);
  const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({
    where: { id: live.requestId },
    select: { status: true, currentRoundId: true },
  });
  expect(row.status).toBe(ServiceRequestStatus.MATCH_REVIEW);
  return { ...live, sa, a, b, c, d, e, offerA, offerB, offerC, offerE, failedRoundId: row.currentRoundId };
}

function openNextRound(requestId: string, cookie: string, body: Record<string, unknown>) {
  return request(ctx.server).post(`/admin/service-requests/${requestId}/open-next-round`).set('Cookie', cookie).send(body);
}

function openBody(expectedCurrentRoundId: string, overrides: Record<string, unknown> = {}) {
  return {
    expectedCurrentRoundId,
    note: 'Müşteriyle görüşüldü; talep yeniden yayınlanacak.',
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

/** Everything a staff opening must leave exactly as it was. */
async function frozen(requestId: string) {
  const [rounds, exclusions, incidents, adjudications, reviews, offers, ledger, leads] = await Promise.all([
    ctx.prisma.serviceRequestMatchRound.findMany({ where: { requestId }, orderBy: { roundNumber: 'asc' } }),
    ctx.prisma.serviceRequestProviderExclusion.findMany({ where: { requestId }, orderBy: { createdAt: 'asc' } }),
    ctx.prisma.providerServiceIncident.findMany({ orderBy: { reportedAt: 'asc' } }),
    ctx.prisma.providerIncidentAdjudication.findMany({ orderBy: { createdAt: 'asc' } }),
    ctx.prisma.providerReliabilityReview.findMany({ orderBy: { createdAt: 'asc' } }),
    ctx.prisma.offer.findMany({ where: { requestId }, orderBy: { id: 'asc' } }),
    ctx.prisma.providerCreditTransaction.findMany({ orderBy: { id: 'asc' } }),
    ctx.prisma.showcaseLead.findMany({ orderBy: { id: 'asc' } }),
  ]);
  return { rounds, exclusions, incidents, adjudications, reviews, offers, ledger, leads };
}

async function providerCanSee(party: Party, requestId: string) {
  const list = await request(ctx.server).get(`/providers/${party.provider.id}/requests`).set('Cookie', party.cookie).expect(200);
  return list.body.map((item: { id: string }) => item.id).includes(requestId);
}

async function availableNotices(requestId: string) {
  return ctx.prisma.notificationLog.findMany({
    where: { template: 'request-available', requestId },
    select: { providerId: true, dedupeKey: true },
  });
}

// ── permission ───────────────────────────────────────────────────────────────

describe('who may open Round 4+', () => {
  it('only a SUPER_ADMIN: an ADMIN with every grantable permission, a smuggled role row, a customer and a provider are refused', async () => {
    const s = await matchReviewRequest();

    const admin = await sessionWith([...GRANTABLE_ADMIN_PERMISSIONS]);
    await openNextRound(s.requestId, admin, openBody(s.failedRoundId)).expect(403);
    const smuggled = await sessionWith([AdminPermission.MATCH_REVIEW_OPEN_ROUND, AdminPermission.REQUESTS_READ]);
    await openNextRound(s.requestId, smuggled, openBody(s.failedRoundId)).expect(403);
    await openNextRound(s.requestId, s.customerCookie, openBody(s.failedRoundId)).expect(403);
    await openNextRound(s.requestId, s.a.cookie, openBody(s.failedRoundId)).expect(403);
    expect(await ctx.prisma.serviceRequestMatchRound.count({ where: { requestId: s.requestId } })).toBe(3);

    // The role editor refuses the value; the catalogue lists it as reserved.
    const created = await request(ctx.server)
      .post('/admin/roles')
      .set('Cookie', s.sa.cookie)
      .send({ key: `reopeners-${randomUUID().slice(0, 6)}`, name: 'Yeniden açanlar', permissions: [AdminPermission.MATCH_REVIEW_OPEN_ROUND] })
      .expect(400);
    expect(created.body.code).toBe('PERMISSION_RESERVED_FOR_SUPER_ADMIN');
    const catalogue = await request(ctx.server).get('/admin/permissions').set('Cookie', s.sa.cookie).expect(200);
    expect(catalogue.body.permissions).not.toContain('MATCH_REVIEW_OPEN_ROUND');
    expect(catalogue.body.reservedForSuperAdmin).toContain('MATCH_REVIEW_OPEN_ROUND');

    // An ADMIN with REQUESTS_READ sees the queue and the timeline.
    const reader = await sessionWith([AdminPermission.REQUESTS_READ]);
    const queue = await request(ctx.server).get('/admin/service-requests/match-review').set('Cookie', reader).expect(200);
    expect(queue.body.items.map((item: { id: string }) => item.id)).toEqual([s.requestId]);
    await request(ctx.server).get(`/service-requests/${s.requestId}/rounds`).set('Cookie', reader).expect(200);
  });
});

// ── guards ───────────────────────────────────────────────────────────────────

describe('guards', () => {
  it('refuses a request not in MATCH_REVIEW, a stale round, a short or missing note, and an unknown request', async () => {
    const s = await matchReviewRequest();
    const sa = s.sa.cookie;

    const short = await openNextRound(s.requestId, sa, openBody(s.failedRoundId, { note: '  kısa  ' })).expect(400);
    expect(short.body).toMatchObject({ code: 'MATCH_REVIEW_NOTE_REQUIRED', minLength: 10 });
    const long = await openNextRound(s.requestId, sa, openBody(s.failedRoundId, { note: 'x'.repeat(2001) })).expect(400);
    expect(long.body.code).toBe('MATCH_REVIEW_NOTE_TOO_LONG');
    await openNextRound(s.requestId, sa, { expectedCurrentRoundId: s.failedRoundId, idempotencyKey: randomUUID() }).expect(400);
    await openNextRound(s.requestId, sa, openBody(s.failedRoundId, { idempotencyKey: 'not-a-uuid' })).expect(400);

    const stale = await openNextRound(s.requestId, sa, openBody(`mr2_${s.requestId}`)).expect(409);
    expect(stale.body.code).toBe('ROUND_CHANGED');
    await openNextRound('does-not-exist', sa, openBody(s.failedRoundId)).expect(404);

    // A live request: not in MATCH_REVIEW.
    const other = await liveRequest(sa);
    const refused = await openNextRound(other.requestId, sa, openBody((await currentRoundId(other.requestId))!)).expect(409);
    expect(refused.body.code).toBe('REQUEST_NOT_IN_MATCH_REVIEW');

    expect(await ctx.prisma.serviceRequestRoundOpening.count()).toBe(0);
    expect(await ctx.prisma.serviceRequestMatchRound.count({ where: { requestId: s.requestId } })).toBe(3);
  });

  it('MATCH_REVIEW leaves only through a staff opening or a cancel: moderation, rejection, completion and stale accepts are refused', async () => {
    const s = await matchReviewRequest();
    for (const status of [ServiceRequestStatus.APPROVED, ServiceRequestStatus.IN_REVIEW]) {
      await request(ctx.server)
        .patch(`/service-requests/${s.requestId}/status`)
        .set('Cookie', s.sa.cookie)
        .send({ status })
        .expect(409);
    }
    await request(ctx.server)
      .patch(`/service-requests/${s.requestId}/status`)
      .set('Cookie', s.sa.cookie)
      .send({ status: ServiceRequestStatus.REJECTED, rejectionReason: 'Uygunsuz içerik bulunmadı.' })
      .expect((res) => expect([400, 409]).toContain(res.status));
    await request(ctx.server).post(`/service-requests/${s.requestId}/complete`).set('Cookie', s.customerCookie).send({}).expect(409);
    await accept(s.requestId, s.offerC, s.customerCookie).expect(409);
    await accept(s.requestId, s.offerE, s.customerCookie).expect(409);
    await postOffer(s.d, s.requestId).expect(404);
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: s.requestId }, select: { status: true, currentRoundId: true } });
    expect(row).toEqual({ status: ServiceRequestStatus.MATCH_REVIEW, currentRoundId: s.failedRoundId });
  });

  it('the customer cannot open a round themselves, and may still cancel from MATCH_REVIEW', async () => {
    const s = await matchReviewRequest();
    await openNextRound(s.requestId, s.customerCookie, openBody(s.failedRoundId)).expect(403);
    const before = await ctx.prisma.providerCreditTransaction.count();
    await request(ctx.server).post(`/service-requests/${s.requestId}/cancel`).set('Cookie', s.customerCookie).send({}).expect(201);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(before);
    const refused = await openNextRound(s.requestId, s.sa.cookie, openBody(s.failedRoundId)).expect(409);
    expect(refused.body.code).toBe('REQUEST_NOT_IN_MATCH_REVIEW');
  });
});

// ── the opening ──────────────────────────────────────────────────────────────

describe('opening Round 4', () => {
  it('auto-publish off: Round 4 waits in moderation; history, exclusions, incidents and credit untouched; approval publishes to D and E only', async () => {
    const s = await matchReviewRequest();
    const before = await frozen(s.requestId);
    const earlierNotices = await ctx.prisma.notificationLog.count({ where: { requestId: s.requestId } });
    ctx.notifications.clear();

    const opened = await openNextRound(s.requestId, s.sa.cookie, openBody(s.failedRoundId)).expect(200);
    expect(opened.body).toMatchObject({
      requestId: s.requestId,
      requestStatus: ServiceRequestStatus.SUBMITTED,
      fromRound: { id: s.failedRoundId, roundNumber: 3 },
      round: { id: `mr4_${s.requestId}`, roundNumber: 4, status: MatchRoundStatus.OPEN, publishedAt: null, expiresAt: null },
      published: false,
      replayed: false,
    });

    const after = await frozen(s.requestId);
    // R1–R3 byte for byte; one new round, nothing else anywhere.
    expect(after.rounds.slice(0, 3)).toEqual(before.rounds);
    expect(after.rounds[3]).toMatchObject({
      roundNumber: 4,
      status: MatchRoundStatus.OPEN,
      source: MatchRoundSource.MARKETPLACE,
      openedBy: MatchRoundOpenedBy.ADMIN,
      publishedAt: null,
      matchedOfferId: null,
    });
    expect(after.exclusions).toEqual(before.exclusions);
    expect(after.incidents).toEqual(before.incidents);
    expect(after.adjudications).toEqual(before.adjudications);
    expect(after.reviews).toEqual(before.reviews);
    expect(after.offers).toEqual(before.offers);
    expect(after.ledger).toEqual(before.ledger);

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: s.requestId },
      select: { status: true, currentRoundId: true, matchedOfferId: true, matchedAt: true, directShowcaseProviderId: true },
    });
    expect(row).toMatchObject({
      status: ServiceRequestStatus.SUBMITTED,
      currentRoundId: `mr4_${s.requestId}`,
      matchedOfferId: null,
      matchedAt: null,
      directShowcaseProviderId: null,
    });

    // The audit row: who, why, from where, into what.
    const opening = await ctx.prisma.serviceRequestRoundOpening.findFirstOrThrow({ where: { requestId: s.requestId } });
    expect(opening).toMatchObject({
      fromRoundId: s.failedRoundId,
      openedRoundId: `mr4_${s.requestId}`,
      openedByAdminId: s.sa.id,
      note: 'Müşteriyle görüşüldü; talep yeniden yayınlanacak.',
    });

    // The customer is told; no provider is, until it is published.
    const notices = await ctx.prisma.notificationLog.findMany({
      where: { requestId: s.requestId },
      orderBy: { createdAt: 'asc' },
      select: { template: true, dedupeKey: true },
    });
    expect(notices.slice(earlierNotices)).toEqual([
      { template: 'request-manually-reopened', dedupeKey: `request-manually-reopened:mr4_${s.requestId}` },
    ]);
    await ctx.app.get(ServiceIssueOutbox).deliverPending();
    const mail = ctx.notifications.sent.find((sent) => sent.template === 'request-manually-reopened');
    expect(mail).toBeDefined();
    expect(JSON.stringify(mail)).not.toContain('Müşteriyle görüşüldü');

    // Not on the market while in moderation.
    expect(await providerCanSee(s.d, s.requestId)).toBe(false);

    // An operator approves: Round 4's clock starts; the fan-out skips A, B, C.
    await approve(s.requestId, s.sa.cookie);
    const published = await ctx.prisma.serviceRequestMatchRound.findUniqueOrThrow({ where: { id: `mr4_${s.requestId}` } });
    expect(published.publishedAt).not.toBeNull();
    const audience = await availableNotices(s.requestId);
    const r4 = audience.filter((notice) => notice.dedupeKey?.endsWith(':r4'));
    const r4Providers = new Set(r4.map((notice) => notice.providerId));
    expect(r4Providers.has(s.d.provider.id)).toBe(true);
    expect(r4Providers.has(s.e.provider.id)).toBe(true);
    for (const excluded of [s.a, s.b, s.c]) {
      expect(r4Providers.has(excluded.provider.id)).toBe(false);
    }

    // Excluded providers cannot see or bid; D and E (E only lost Round 1) can,
    // at the normal price.
    for (const excluded of [s.a, s.b, s.c]) {
      expect(await providerCanSee(excluded, s.requestId)).toBe(false);
      await postOffer(excluded, s.requestId).expect(404);
    }
    expect(await providerCanSee(s.d, s.requestId)).toBe(true);
    const offerD = await postOffer(s.d, s.requestId).expect(201);
    expect(offerD.body.creditCost).toBe(2);
    const offerE2 = await postOffer(s.e, s.requestId).expect(201);
    expect(offerE2.body.id).not.toBe(s.offerE);

    // Round 4 completes like any marketplace round.
    await accept(s.requestId, offerD.body.id, s.customerCookie).expect(201);
    await request(ctx.server).post(`/service-requests/${s.requestId}/complete`).set('Cookie', s.customerCookie).send({}).expect(201);
    const done = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: s.requestId }, include: { currentRound: true } });
    expect(done.status).toBe(ServiceRequestStatus.COMPLETED);
    expect(done.currentRound).toMatchObject({ roundNumber: 4, status: MatchRoundStatus.COMPLETED, matchedOfferId: offerD.body.id });
    // The failed winners were never refunded, then or now.
    for (const offerId of [s.offerA, s.offerB, s.offerC]) {
      expect((await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).status).toBe(OfferStatus.ACCEPTED);
      expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: 'OFFER_REFUND', referenceId: offerId } })).toBe(0);
    }

    // The customer's history: four rounds, no staff note anywhere.
    const view = (await request(ctx.server).get(`/service-requests/my/${s.requestId}`).set('Cookie', s.customerCookie).expect(200)).body;
    expect(view.rounds.map((round: { roundNumber: number }) => round.roundNumber)).toEqual([1, 2, 3, 4]);
    expect(view.currentRound).toMatchObject({ roundNumber: 4, status: MatchRoundStatus.COMPLETED });
    expect(JSON.stringify(view)).not.toContain('Müşteriyle görüşüldü');
  });

  it('auto-publish on: Round 4 is published at once through the canonical gate, fan-out round-aware', async () => {
    const s = await matchReviewRequest();
    await setSettings({ marketplaceAutoPublishEnabled: true });
    const opened = await openNextRound(s.requestId, s.sa.cookie, openBody(s.failedRoundId)).expect(200);
    expect(opened.body).toMatchObject({ requestStatus: ServiceRequestStatus.APPROVED, published: true, round: { roundNumber: 4 } });
    expect(opened.body.round.publishedAt).not.toBeNull();
    expect(opened.body.round.expiresAt).not.toBeNull();

    const r4 = (await availableNotices(s.requestId)).filter((notice) => notice.dedupeKey?.endsWith(':r4'));
    expect(r4.map((notice) => notice.providerId).sort()).toEqual([s.d.provider.id, s.e.provider.id].sort());
    expect(await providerCanSee(s.d, s.requestId)).toBe(true);
    await postOffer(s.a, s.requestId).expect(404);
  });

  it('the telephone gate: auto-publish on but an unproven number waits in moderation', async () => {
    const s = await matchReviewRequest();
    await setSettings({ marketplaceAutoPublishEnabled: true });
    process.env.REQUIRE_PHONE_VERIFICATION = 'true';
    await ctx.prisma.serviceRequest.update({ where: { id: s.requestId }, data: { phoneVerifiedAt: null } });
    const opened = await openNextRound(s.requestId, s.sa.cookie, openBody(s.failedRoundId)).expect(200);
    expect(opened.body).toMatchObject({ requestStatus: ServiceRequestStatus.SUBMITTED, published: false });
  });

  it('no hard cap: Round 4 fails → MATCH_REVIEW again → Round 5; every failed provider stays excluded', async () => {
    const s = await matchReviewRequest();
    await setSettings({ marketplaceAutoPublishEnabled: true });
    await openNextRound(s.requestId, s.sa.cookie, openBody(s.failedRoundId)).expect(200);
    await failRoundWith(s.requestId, s.customerCookie, s.d);

    const review = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: s.requestId },
      select: { status: true, currentRoundId: true },
    });
    expect(review).toMatchObject({ status: ServiceRequestStatus.MATCH_REVIEW, currentRoundId: `mr4_${s.requestId}` });
    expect(await ctx.prisma.notificationLog.count({ where: { template: 'request-match-review', requestId: s.requestId } })).toBe(2);

    // Opening from the round that is no longer current is refused.
    const stale = await openNextRound(s.requestId, s.sa.cookie, openBody(s.failedRoundId)).expect(409);
    expect(stale.body.code).toBe('MATCH_REVIEW_ALREADY_REOPENED');

    const fifth = await openNextRound(s.requestId, s.sa.cookie, openBody(`mr4_${s.requestId}`)).expect(200);
    expect(fifth.body.round).toMatchObject({ id: `mr5_${s.requestId}`, roundNumber: 5 });
    for (const excluded of [s.a, s.b, s.c, s.d]) {
      await postOffer(excluded, s.requestId).expect(404);
    }
    await postOffer(s.e, s.requestId).expect(201);
    expect(await ctx.prisma.serviceRequestRoundOpening.count({ where: { requestId: s.requestId } })).toBe(2);
    expect(await ctx.prisma.serviceRequestProviderExclusion.count({ where: { requestId: s.requestId } })).toBe(4);
  });

  it('the switch off does not strand MATCH_REVIEW: staff still open Round 4; the customer still cannot report', async () => {
    const s = await matchReviewRequest();
    await setSettings({ serviceIssueReportingEnabled: false, marketplaceAutoPublishEnabled: true });
    await openNextRound(s.requestId, s.sa.cookie, openBody(s.failedRoundId)).expect(200);
    const offerD = await submitOffer(s.d, s.requestId);
    await accept(s.requestId, offerD, s.customerCookie).expect(201);
    await promise(offerD, -2, 3);
    await request(ctx.server)
      .post(`/service-requests/${s.requestId}/service-issue`)
      .set('Cookie', s.customerCookie)
      .send({ roundId: `mr4_${s.requestId}`, reason: 'PROVIDER_NO_SHOW', idempotencyKey: randomUUID() })
      .expect(404);
    // History stays readable for the admin.
    const rounds = await request(ctx.server).get(`/service-requests/${s.requestId}/rounds`).set('Cookie', s.sa.cookie).expect(200);
    expect(rounds.body.rounds).toHaveLength(4);
  });

  it('cancelling Round 4 refunds only Round 4’s live offers; the failed winners get nothing', async () => {
    const s = await matchReviewRequest();
    await setSettings({ marketplaceAutoPublishEnabled: true });
    await openNextRound(s.requestId, s.sa.cookie, openBody(s.failedRoundId)).expect(200);
    const offerD = await submitOffer(s.d, s.requestId);
    await request(ctx.server).post(`/service-requests/${s.requestId}/cancel`).set('Cookie', s.customerCookie).send({}).expect(201);
    const cancellation = await ctx.prisma.serviceRequestCancellation.findUniqueOrThrow({ where: { requestId: s.requestId } });
    expect(cancellation.closedOfferIds).toEqual([offerD]);
    expect(cancellation.refundedOfferIds).toEqual([offerD]);
    for (const offerId of [s.offerA, s.offerB, s.offerC]) {
      expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: 'OFFER_REFUND', referenceId: offerId } })).toBe(0);
    }
  });
});

// ── idempotency and races ────────────────────────────────────────────────────

describe('idempotency and concurrency', () => {
  it('same key + same payload replays; same key + another note is 409; another key afterwards is 409 ALREADY_REOPENED', async () => {
    const s = await matchReviewRequest();
    const body = openBody(s.failedRoundId);
    const first = await openNextRound(s.requestId, s.sa.cookie, body).expect(200);
    const again = await openNextRound(s.requestId, s.sa.cookie, body).expect(200);
    expect(again.body).toMatchObject({ openingId: first.body.openingId, replayed: true, round: { id: first.body.round.id } });

    const reused = await openNextRound(s.requestId, s.sa.cookie, { ...body, note: 'Başka bir not, farklı içerik.' }).expect(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const otherAdmin = await superAdmin();
    const otherActor = await openNextRound(s.requestId, otherAdmin.cookie, body).expect(409);
    expect(otherActor.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const second = await openNextRound(s.requestId, s.sa.cookie, openBody(s.failedRoundId)).expect(409);
    expect(second.body).toMatchObject({ code: 'MATCH_REVIEW_ALREADY_REOPENED', roundNumber: 4 });

    expect(await ctx.prisma.serviceRequestMatchRound.count({ where: { requestId: s.requestId } })).toBe(4);
    expect(await ctx.prisma.serviceRequestRoundOpening.count()).toBe(1);
    expect(await ctx.prisma.notificationLog.count({ where: { template: 'request-manually-reopened' } })).toBe(1);
  });

  it('two admins, two keys, at once: exactly one Round 4; the loser gets 409 MATCH_REVIEW_ALREADY_REOPENED', async () => {
    const s = await matchReviewRequest();
    const other = await superAdmin();
    const [one, two] = await Promise.all([
      openNextRound(s.requestId, s.sa.cookie, openBody(s.failedRoundId)),
      openNextRound(s.requestId, other.cookie, openBody(s.failedRoundId)),
    ]);
    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = one.status === 409 ? one : two;
    expect(loser.body.code).toBe('MATCH_REVIEW_ALREADY_REOPENED');
    expect(await ctx.prisma.serviceRequestMatchRound.count({ where: { requestId: s.requestId, roundNumber: 4 } })).toBe(1);
    expect(await ctx.prisma.serviceRequestRoundOpening.count()).toBe(1);
  });

  it('the same key twice at once: one opening, the other answer is its replay', async () => {
    const s = await matchReviewRequest();
    const body = openBody(s.failedRoundId);
    const [one, two] = await Promise.all([
      openNextRound(s.requestId, s.sa.cookie, body),
      openNextRound(s.requestId, s.sa.cookie, body),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect([one.body.replayed, two.body.replayed].sort()).toEqual([false, true]);
    expect(one.body.openingId).toBe(two.body.openingId);
    expect(await ctx.prisma.serviceRequestRoundOpening.count()).toBe(1);
  });
});

// ── database backstops ───────────────────────────────────────────────────────

describe('database', () => {
  it('an opening is append-only, and its shape is checked at insert', async () => {
    const s = await matchReviewRequest();
    await openNextRound(s.requestId, s.sa.cookie, openBody(s.failedRoundId)).expect(200);
    const opening = await ctx.prisma.serviceRequestRoundOpening.findFirstOrThrow({});

    await expect(
      ctx.prisma.serviceRequestRoundOpening.update({ where: { id: opening.id }, data: { note: 'Düzeltilmiş not metni.' } }),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.serviceRequestRoundOpening.delete({ where: { id: opening.id } })).rejects.toThrow(/append-only/);

    // From a round that did not fail (Round 4 is OPEN) into nothing ADMIN-shaped.
    await expect(
      ctx.prisma.serviceRequestRoundOpening.create({
        data: {
          requestId: s.requestId,
          fromRoundId: `mr4_${s.requestId}`,
          openedRoundId: `mr1_${s.requestId}`,
          openedByAdminId: s.sa.id,
          note: 'Geçersiz bir açılış denemesi.',
          idempotencyKey: randomUUID(),
        },
      }),
    ).rejects.toThrow(/ROUND_OPENING_SHAPE/);
    // A note that is not trimmed.
    await expect(
      ctx.prisma.$executeRawUnsafe(
        `INSERT INTO "ServiceRequestRoundOpening" ("id","requestId","fromRoundId","openedRoundId","openedByAdminId","note","idempotencyKey")
         VALUES ('x', $1, $2, $3, $4, ' boşluklu not metni ', 'k')`,
        s.requestId,
        `mr2_${s.requestId}`,
        `mr3_${s.requestId}`,
        s.sa.id,
      ),
    ).rejects.toThrow(/RoundOpening_note_rules|ROUND_OPENING_SHAPE/);
  });
});

// ── vitrin direct lead chain ─────────────────────────────────────────────────

describe('direct showcase chain', () => {
  it('DIRECT R1 → fail → R2 → fail → R3 → fail → MATCH_REVIEW → staff R4: the lead stays ANSWERED, the owner stays out, R4 is a marketplace round', async () => {
    await setSettings({ marketplaceAutoPublishEnabled: true });
    const sa = await superAdmin();
    const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF, offerCreditCost: 2 });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const owner = await createDiscoverableProvider(ctx.prisma, { userId: ownerUser.id, categoryId: category.id, areas: [{ city: 'İstanbul', district: null }] });
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, { providerId: owner.id, categoryId: category.id });
    const pkg = await createShowcasePackage(ctx.prisma);
    await createLiveShowcasePlacement(ctx, { providerId: owner.id, cardId: card.id, versionId: version.id, packageId: pkg.id });
    const customerUser = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customerUser.id);
    const payload = showcaseLeadPayload(category.slug);
    await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
    await request(ctx.server).post(`/showcase/cards/${card.id}/leads`).set('Cookie', customerCookie).send({ ...payload, useAlternateContact: true }).expect(201);
    const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({});
    const ownerParty: Party = { provider: owner, userId: ownerUser.id, cookie: await loginAs(ctx.prisma, ownerUser.id) };

    await failRoundWith(lead.requestId, customerCookie, ownerParty);
    const p2 = await addProvider(category.id);
    const p3 = await addProvider(category.id);
    const p4 = await addProvider(category.id);
    await failRoundWith(lead.requestId, customerCookie, p2);
    await failRoundWith(lead.requestId, customerCookie, p3);
    const review = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: lead.requestId },
      select: { status: true, currentRoundId: true },
    });
    expect(review.status).toBe(ServiceRequestStatus.MATCH_REVIEW);
    const leadBefore = await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } });

    await openNextRound(lead.requestId, sa.cookie, openBody(review.currentRoundId)).expect(200);

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: lead.requestId }, include: { matchRounds: { orderBy: { roundNumber: 'asc' } } } });
    expect(row.directShowcaseProviderId).toBeNull();
    expect(row.status).toBe(ServiceRequestStatus.APPROVED);
    expect(row.matchRounds.map((round) => round.source)).toEqual([
      MatchRoundSource.DIRECT_SHOWCASE,
      MatchRoundSource.MARKETPLACE,
      MatchRoundSource.MARKETPLACE,
      MatchRoundSource.MARKETPLACE,
    ]);
    expect(await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } })).toEqual(leadBefore);
    await postOffer(ownerParty, lead.requestId).expect(404);
    const fresh = await postOffer(p4, lead.requestId).expect(201);
    expect(fresh.body.creditCost).toBe(2);
    const inbox = await request(ctx.server).get(`/providers/${owner.id}/showcase/leads/${lead.id}`).set('Cookie', ownerParty.cookie).expect(200);
    expect(inbox.body.request).toMatchObject({ status: 'MATCH_ENDED', matchEnded: true });
  });
});

// ── timeline, queue, dashboard ───────────────────────────────────────────────

describe('admin timeline and queue', () => {
  it('the timeline names every round, its incident decision, its thread mode and the staff opening; blocks follow the reader’s permissions', async () => {
    const s = await matchReviewRequest();
    await openNextRound(s.requestId, s.sa.cookie, openBody(s.failedRoundId)).expect(200);

    const full = (await request(ctx.server).get(`/service-requests/${s.requestId}/rounds`).set('Cookie', s.sa.cookie).expect(200)).body;
    expect(full.requestStatus).toBe(ServiceRequestStatus.SUBMITTED);
    expect(full.rounds.map((round: { roundNumber: number; status: string }) => [round.roundNumber, round.status])).toEqual([
      [1, 'FAILED'],
      [2, 'FAILED'],
      [3, 'FAILED'],
      [4, 'OPEN'],
    ]);
    expect(full.rounds[0]).toMatchObject({
      openedBy: 'REQUEST_CREATED',
      opening: null,
      winnerScheduleMissing: false,
      matchedProvider: { id: s.a.provider.id },
      matchedOffer: { id: s.offerA },
      failureIncident: { status: 'REPORTED', effectiveDecision: null, corrected: false },
      // Accepting revealed contact for Round 1's match.
      contactRevealed: true,
    });
    expect(full.rounds[3]).toMatchObject({
      openedBy: 'ADMIN',
      isCurrent: true,
      matchedProvider: null,
      failureIncident: null,
      thread: null,
      opening: { fromRoundId: s.failedRoundId, note: 'Müşteriyle görüşüldü; talep yeniden yayınlanacak.', openedBy: { id: s.sa.id } },
    });
    expect(full.rounds[3].opening.openedBy).toHaveProperty('email');
    expect(full.exclusions).toHaveLength(3);

    // REQUESTS_READ alone: no offer, reveal or staff-email blocks — keys absent.
    const reader = await sessionWith([AdminPermission.REQUESTS_READ]);
    const narrow = (await request(ctx.server).get(`/service-requests/${s.requestId}/rounds`).set('Cookie', reader).expect(200)).body;
    expect(narrow.rounds[0]).not.toHaveProperty('matchedProvider');
    expect(narrow.rounds[0]).not.toHaveProperty('matchedOffer');
    expect(narrow.rounds[0]).not.toHaveProperty('contactRevealed');
    expect(narrow.rounds[3].opening.openedBy).not.toHaveProperty('email');
    expect(narrow.rounds[3].opening.openedBy.id).toBe(s.sa.id);
  });

  it('a thread is ACTIVE while its round is live and READ_ONLY once it failed; only its participants read it', async () => {
    const sa = await superAdmin();
    const live = await liveRequest(sa.cookie);
    const a = await addProvider(live.category.id);
    const offerA = await submitOffer(a, live.requestId);
    await accept(live.requestId, offerA, live.customerCookie).expect(201);
    const thread = await request(ctx.server)
      .post('/messages/threads/resolve')
      .set('Cookie', live.customerCookie)
      .send({ requestId: live.requestId })
      .expect(201);
    const before = (await request(ctx.server).get(`/service-requests/${live.requestId}/rounds`).set('Cookie', sa.cookie).expect(200)).body;
    expect(before.rounds[0].thread).toEqual({ id: thread.body.id, mode: 'ACTIVE' });

    await promise(offerA, -2, 3);
    await failCurrentMatch(live.requestId, live.customerCookie);
    const after = (await request(ctx.server).get(`/service-requests/${live.requestId}/rounds`).set('Cookie', sa.cookie).expect(200)).body;
    expect(after.rounds[0].thread).toEqual({ id: thread.body.id, mode: 'READ_ONLY' });
    expect(after.rounds[1].thread).toBeNull();
    const b = await addProvider(live.category.id);
    await request(ctx.server).get(`/messages/threads/${thread.body.id}`).set('Cookie', b.cookie).expect(404);
    await request(ctx.server).get(`/messages/threads/${thread.body.id}`).set('Cookie', a.cookie).expect(200);
  });

  it('a legacy match with no promised days is flagged, never dated', async () => {
    const sa = await superAdmin();
    const live = await liveRequest(sa.cookie);
    const party = await addProvider(live.category.id);
    const offerId = await submitOffer(party, live.requestId);
    await accept(live.requestId, offerId, live.customerCookie).expect(201);
    await ctx.prisma.offer.update({ where: { id: offerId }, data: { estimatedStartDate: null, estimatedCompletionDate: null } });
    const rounds = (await request(ctx.server).get(`/service-requests/${live.requestId}/rounds`).set('Cookie', sa.cookie).expect(200)).body;
    expect(rounds.rounds[0]).toMatchObject({ status: 'MATCHED', winnerScheduleMissing: true });
  });

  it('the queue is oldest-first and the dashboard counts it for a reader of requests only', async () => {
    const first = await matchReviewRequest();
    const second = await matchReviewRequest();
    // Make the second one older.
    await ctx.prisma.$executeRawUnsafe(
      `UPDATE "ServiceRequestMatchRound" SET "failedAt" = "failedAt" - interval '1 day' WHERE "id" = $1`,
      second.failedRoundId,
    );
    const queue = (await request(ctx.server).get('/admin/service-requests/match-review').set('Cookie', first.sa.cookie).expect(200)).body;
    expect(queue.total).toBe(2);
    expect(queue.items.map((item: { id: string }) => item.id)).toEqual([second.requestId, first.requestId]);
    expect(queue.items[0]).toMatchObject({
      currentRound: { roundNumber: 3, failureIncident: { incidentNumber: expect.any(String) } },
      exclusionCount: 3,
      manualOpeningCount: 0,
    });
    expect(JSON.stringify(queue.items)).not.toMatch(/customerPhone|customerEmail|customerName/);

    const summary = (await request(ctx.server).get('/dashboard/admin-summary').set('Cookie', first.sa.cookie).expect(200)).body;
    expect(summary.matchReviewRequests).toBe(2);
    const dashboardOnly = await sessionWith([AdminPermission.DASHBOARD_READ]);
    const narrow = (await request(ctx.server).get('/dashboard/admin-summary').set('Cookie', dashboardOnly).expect(200)).body;
    expect(narrow).not.toHaveProperty('matchReviewRequests');
  });
});

// ── observability ────────────────────────────────────────────────────────────

describe('observability', () => {
  it('event lines carry ids and enums only', () => {
    expect(formatRel002Event('manual_round_opened', { requestId: 'r1', round: 4, published: false, actorId: 'u1', note: null })).toBe(
      'rel002_event event=manual_round_opened requestId=r1 round=4 published=false actorId=u1 note=-',
    );
  });
});
