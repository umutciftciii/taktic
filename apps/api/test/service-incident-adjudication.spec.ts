import { randomUUID } from 'node:crypto';
import {
  AdminPermission,
  CreditTransactionType,
  MatchRoundStatus,
  OfferStatus,
  ProviderReliabilityReviewStatus,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addIsoDays, isoDayToStoredDate, todayIsoDay } from '../src/common/date-only';
import { GRANTABLE_ADMIN_PERMISSIONS } from '../src/modules/auth/admin-permissions';
import { ServiceIssueOutbox } from '../src/modules/notifications/service-issue-outbox.service';
import {
  customerReportSummary,
  effectiveIncidentDecision,
  providerReliabilitySummary,
} from '../src/modules/service-incidents/incident-reliability';
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
  resetAuthThrottle,
  resetDatabase,
  type TestContext,
} from './harness';
import { roundInconsistencies } from './match-round-consistency';

/**
 * REL-002 Faz 4 — provider response, staff adjudication (append-only, with
 * SUPER_ADMIN corrections), provider reliability and the customer signal,
 * through the API. Every case ends with the operators' consistency script
 * (now including the M4 head/chain checks) returning nothing.
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
  delete process.env.REQUIRE_PHONE_VERIFICATION;
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48, serviceIssueReportingEnabled: true },
    update: { serviceIssueReportingEnabled: true },
  });
});

afterEach(async () => {
  await ctx.app.get(ServiceIssueOutbox).whenIdle();
  expect(await roundInconsistencies(ctx.prisma)).toEqual([]);
});

// ── builders ─────────────────────────────────────────────────────────────────

type Party = { provider: { id: string }; userId: string; cookie: string };

let categoryId: string | null = null;

async function category() {
  if (!categoryId || !(await ctx.prisma.serviceCategory.findUnique({ where: { id: categoryId } }))) {
    categoryId = (await createCategory(ctx.prisma, `Klima ${randomUUID().slice(0, 6)}`, { offerCreditCost: 2 })).id;
  }
  return categoryId;
}

async function addProvider(): Promise<Party> {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: user.id, categoryId: await category() });
  await grantCredits(ctx.prisma, provider.id, 50);
  return { provider, userId: user.id, cookie: await loginAs(ctx.prisma, user.id) };
}

async function customer() {
  const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  return { id: user.id, cookie: await loginAs(ctx.prisma, user.id) };
}

async function superAdminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

async function adminCookie(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return { id: admin.id, cookie: await loginAs(ctx.prisma, admin.id) };
}

/**
 * A FAILED round with its incident against `party` (a fresh provider by
 * default), reported by `owner` (a fresh customer by default) through the real
 * Faz 3 endpoint: offer, accept, promised start two days ago, NO_SHOW.
 */
async function incidentAgainst(party?: Party, owner?: { id: string; cookie: string }, note?: string) {
  const provider = party ?? (await addProvider());
  const person = owner ?? (await customer());
  const req = await createApprovedRequest(ctx.prisma, {
    categoryId: await category(),
    customerId: person.id,
    approvedAt: new Date(),
  });
  await ctx.prisma.serviceRequestMatchRound.updateMany({
    where: { requestId: req.id, roundNumber: 1, publishedAt: null },
    data: { publishedAt: new Date(), expiresAt: new Date(Date.now() + 14 * 86_400_000) },
  });
  const offer = await request(ctx.server)
    .post(`/providers/${provider.provider.id}/requests/${req.id}/offers`)
    .set('Cookie', provider.cookie)
    .send(offerPayload())
    .expect(201);
  const offerId = offer.body.id as string;
  await request(ctx.server)
    .post(`/service-requests/${req.id}/offers/${offerId}/action`)
    .set('Cookie', person.cookie)
    .send(ACCEPT_OFFER)
    .expect(201);
  const today = todayIsoDay();
  await ctx.prisma.offer.update({
    where: { id: offerId },
    data: {
      estimatedStartDate: isoDayToStoredDate(addIsoDays(today, -2)),
      estimatedCompletionDate: isoDayToStoredDate(addIsoDays(today, 5)),
    },
  });
  const { currentRoundId } = await ctx.prisma.serviceRequest.findUniqueOrThrow({
    where: { id: req.id },
    select: { currentRoundId: true },
  });
  const reported = await request(ctx.server)
    .post(`/service-requests/${req.id}/service-issue`)
    .set('Cookie', person.cookie)
    .send({
      roundId: currentRoundId,
      reason: note ? 'OTHER' : 'PROVIDER_NO_SHOW',
      ...(note ? { note } : {}),
      idempotencyKey: randomUUID(),
    })
    .expect(200);
  return {
    incidentId: reported.body.incidentId as string,
    requestId: req.id,
    offerId,
    party: provider,
    owner: person,
  };
}

function respond(party: Party, incidentId: string, responseText: string, providerId = party.provider.id) {
  return request(ctx.server)
    .post(`/providers/${providerId}/incidents/${incidentId}/response`)
    .set('Cookie', party.cookie)
    .send({ responseText });
}

function adjudicate(cookie: string, incidentId: string, decision: 'CONFIRMED' | 'DISMISSED', rationale = 'Kanıtlar incelendi, karar verildi.') {
  return request(ctx.server)
    .post(`/admin/service-incidents/${incidentId}/adjudications`)
    .set('Cookie', cookie)
    .send({ decision, rationale });
}

function correct(
  cookie: string,
  incidentId: string,
  decision: 'CONFIRMED' | 'DISMISSED',
  expectedEffectiveAdjudicationId: string,
  rationale = 'Yeni belge geldi, karar düzeltildi.',
) {
  return request(ctx.server)
    .post(`/admin/service-incidents/${incidentId}/corrections`)
    .set('Cookie', cookie)
    .send({ decision, rationale, expectedEffectiveAdjudicationId });
}

async function reliability(cookie: string, providerId: string) {
  return (await request(ctx.server).get(`/admin/providers/${providerId}/reliability`).set('Cookie', cookie).expect(200)).body;
}

async function creditRows() {
  return ctx.prisma.providerCreditTransaction.count();
}

async function snapshot(incidentId: string) {
  const incident = await ctx.prisma.providerServiceIncident.findUniqueOrThrow({
    where: { id: incidentId },
    select: { requestId: true, roundId: true, offerId: true, providerId: true },
  });
  const [round, exclusion, req, offer, threads] = await Promise.all([
    ctx.prisma.serviceRequestMatchRound.findUniqueOrThrow({ where: { id: incident.roundId } }),
    ctx.prisma.serviceRequestProviderExclusion.findUnique({ where: { incidentId } }),
    ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: incident.requestId },
      select: { status: true, currentRoundId: true, matchedOfferId: true },
    }),
    ctx.prisma.offer.findUniqueOrThrow({ where: { id: incident.offerId }, select: { status: true } }),
    ctx.prisma.messageThread.findMany({ where: { requestId: incident.requestId }, orderBy: { id: 'asc' } }),
  ]);
  return { round, exclusion, req, offer, threads };
}

// ── provider response ────────────────────────────────────────────────────────

describe('provider response', () => {
  it('the owner answers once: PROVIDER_RESPONDED, the support inbox is told, nothing is decided', async () => {
    const s = await incidentAgainst();
    const res = await respond(s.party, s.incidentId, '  Müşteriyle   randevu günü konuştuk,  ertelenmesini o istedi.  ').expect(200);
    expect(res.body).toMatchObject({
      status: 'PROVIDER_RESPONDED',
      providerResponse: 'Müşteriyle randevu günü konuştuk, ertelenmesini o istedi.',
      canRespond: false,
      outcome: null,
      replayed: false,
    });
    const row = await ctx.prisma.providerServiceIncident.findUniqueOrThrow({ where: { id: s.incidentId } });
    expect(row.effectiveAdjudicationId).toBeNull();
    expect(row.providerRespondedById).toBe(s.party.userId);
    const notice = await ctx.prisma.notificationLog.findFirst({
      where: { dedupeKey: `service-incident-provider-responded:${s.incidentId}` },
    });
    expect(notice).not.toBeNull();
  });

  it('the same text again is a replay; a different text is 409; the row never changes', async () => {
    const s = await incidentAgainst();
    await respond(s.party, s.incidentId, 'İlk ve tek yanıtım budur, lütfen dikkate alın.').expect(200);
    const replay = await respond(s.party, s.incidentId, 'İlk ve tek yanıtım budur, lütfen dikkate alın.').expect(200);
    expect(replay.body.replayed).toBe(true);
    const second = await respond(s.party, s.incidentId, 'Fikrimi değiştirdim, başka bir şey yazıyorum.').expect(409);
    expect(second.body.code).toBe('INCIDENT_RESPONSE_ALREADY_SUBMITTED');
    // The database refuses an overwrite from any writer.
    await expect(
      ctx.prisma.providerServiceIncident.update({ where: { id: s.incidentId }, data: { providerResponse: 'Başka bir yanıt metni yazıldı.' } }),
    ).rejects.toThrow(/INCIDENT_RESPONSE_ALREADY_SUBMITTED/);
  });

  it('length rules: under 10 and over 2000 characters are 400', async () => {
    const s = await incidentAgainst();
    expect((await respond(s.party, s.incidentId, '   kısa   ').expect(400)).body.code).toBe('INCIDENT_RESPONSE_TOO_SHORT');
    expect((await respond(s.party, s.incidentId, 'x'.repeat(2001)).expect(400)).body.code).toBe('INCIDENT_RESPONSE_TOO_LONG');
  });

  it('another provider: 403 on their providerId, 404 on their own id', async () => {
    const s = await incidentAgainst();
    const other = await addProvider();
    await request(ctx.server)
      .post(`/providers/${s.party.provider.id}/incidents/${s.incidentId}/response`)
      .set('Cookie', other.cookie)
      .send({ responseText: 'Başkasının bildirimine yanıt denemesi.' })
      .expect(403);
    await respond(other, s.incidentId, 'Başkasının bildirimine yanıt denemesi.').expect(404);
    await request(ctx.server).get(`/providers/${other.provider.id}/incidents/${s.incidentId}`).set('Cookie', other.cookie).expect(404);
  });

  it('customer, ADMIN and SUPER_ADMIN cannot answer for the provider', async () => {
    const s = await incidentAgainst();
    const admin = await adminCookie([...GRANTABLE_ADMIN_PERMISSIONS]);
    for (const cookie of [s.owner.cookie, admin.cookie, await superAdminCookie()]) {
      await request(ctx.server)
        .post(`/providers/${s.party.provider.id}/incidents/${s.incidentId}/response`)
        .set('Cookie', cookie)
        .send({ responseText: 'Yetkisiz bir yanıt denemesi yapılıyor.' })
        .expect(403);
    }
    expect((await ctx.prisma.providerServiceIncident.findUniqueOrThrow({ where: { id: s.incidentId } })).providerResponse).toBeNull();
  });

  it('after a decision the response is closed (409), whatever the window says', async () => {
    const s = await incidentAgainst();
    await adjudicate(await superAdminCookie(), s.incidentId, 'DISMISSED').expect(201);
    const res = await respond(s.party, s.incidentId, 'Karar sonrası gelen geç bir yanıt.').expect(409);
    expect(res.body.code).toBe('INCIDENT_ALREADY_ADJUDICATED');
  });

  it('72 hours passed: overdue is shown, the response is still accepted while undecided', async () => {
    const s = await incidentAgainst();
    await ctx.prisma.providerServiceIncident.update({
      where: { id: s.incidentId },
      data: { reportedAt: new Date(Date.now() - 80 * 3_600_000) },
    });
    const before = await request(ctx.server)
      .get(`/providers/${s.party.provider.id}/incidents/${s.incidentId}`)
      .set('Cookie', s.party.cookie)
      .expect(200);
    expect(before.body).toMatchObject({ responseOverdue: true, canRespond: true });
    await respond(s.party, s.incidentId, 'Geç de olsa yanıtımı iletiyorum.').expect(200);
    const queue = await request(ctx.server)
      .get('/admin/service-incidents?status=all')
      .set('Cookie', await superAdminCookie())
      .expect(200);
    expect(queue.body.items[0]).toMatchObject({ lateResponse: true, responseOverdue: false });
  });

  it('the provider projection is an allowlist: no customer name, phone, e-mail or address; the note masked', async () => {
    const s = await incidentAgainst(undefined, undefined, 'Usta gelmedi, beni 0555 123 45 67 numarasından arayın lütfen.');
    const req = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: s.requestId },
      select: { customerName: true, customerPhone: true, customerEmail: true, addressNote: true },
    });
    const detail = await request(ctx.server)
      .get(`/providers/${s.party.provider.id}/incidents/${s.incidentId}`)
      .set('Cookie', s.party.cookie)
      .expect(200);
    expect(Object.keys(detail.body).sort()).toEqual(
      [
        'canRespond',
        'customerNote',
        'id',
        'incidentNumber',
        'offerId',
        'outcome',
        'promisedEndDate',
        'promisedStartDate',
        'providerResponse',
        'reason',
        'reportedAt',
        'request',
        'respondedAt',
        'responseDueAt',
        'responseOverdue',
        'status',
      ].sort(),
    );
    expect(Object.keys(detail.body.request).sort()).toEqual(['categoryName', 'city', 'district', 'requestNumber']);
    expect(detail.body.customerNote).toContain('[gizlendi]');
    const list = await request(ctx.server).get(`/providers/${s.party.provider.id}/incidents`).set('Cookie', s.party.cookie).expect(200);
    for (const body of [JSON.stringify(detail.body), JSON.stringify(list.body)]) {
      for (const secret of [req.customerName, req.customerPhone, req.customerEmail, req.addressNote, s.owner.id]) {
        if (secret) expect(body).not.toContain(secret);
      }
      expect(body).not.toContain('0555 123 45 67');
    }
  });
});

// ── initial adjudication ─────────────────────────────────────────────────────

describe('initial adjudication', () => {
  it('confirm: an INITIAL adjudication, the head, the projection, the provider notice — and nothing else moves', async () => {
    const s = await incidentAgainst();
    await respond(s.party, s.incidentId, 'Hastalandım, haber veremedim, özür dilerim.').expect(200);
    const before = await snapshot(s.incidentId);
    const credits = await creditRows();
    const admin = await adminCookie([AdminPermission.SERVICE_INCIDENTS_ADJUDICATE]);

    const res = await adjudicate(admin.cookie, s.incidentId, 'CONFIRMED', '  Sağlayıcı   kendisi gelmediğini kabul etti. ').expect(201);
    expect(res.body).toMatchObject({ kind: 'INITIAL', decision: 'CONFIRMED', sequence: 1, openedReviewId: null });

    const row = await ctx.prisma.providerServiceIncident.findUniqueOrThrow({ where: { id: s.incidentId } });
    expect(row).toMatchObject({
      status: 'CONFIRMED',
      effectiveAdjudicationId: res.body.adjudicationId,
      reviewedById: admin.id,
      reviewNote: 'Sağlayıcı kendisi gelmediğini kabul etti.',
    });
    expect(await effectiveIncidentDecision(ctx.prisma, s.incidentId)).toMatchObject({ decision: 'CONFIRMED', sequence: 1 });
    expect(await ctx.prisma.notificationLog.count({ where: { dedupeKey: `service-incident-confirmed:${res.body.adjudicationId}` } })).toBe(1);

    // No refund, no round/exclusion/request/offer/thread change.
    expect(await creditRows()).toBe(credits);
    expect(await snapshot(s.incidentId)).toEqual(before);
  });

  it('dismiss: no strike, and the exclusion, the FAILED round and the reopened request stay as they were', async () => {
    const s = await incidentAgainst();
    const before = await snapshot(s.incidentId);
    const credits = await creditRows();
    const cookie = await superAdminCookie();
    await adjudicate(cookie, s.incidentId, 'DISMISSED').expect(201);
    expect(await snapshot(s.incidentId)).toEqual(before);
    expect(before.exclusion).not.toBeNull();
    expect(before.round.status).toBe(MatchRoundStatus.FAILED);
    expect(before.offer.status).toBe(OfferStatus.ACCEPTED);
    expect(before.req.status).toBe(ServiceRequestStatus.APPROVED);
    expect(await creditRows()).toBe(credits);
    expect((await reliability(cookie, s.party.provider.id)).summary).toMatchObject({ confirmed: 0, dismissed: 1, level: 'NORMAL' });
    // The excluded provider still cannot act on the request.
    await request(ctx.server)
      .post(`/providers/${s.party.provider.id}/requests/${s.requestId}/offers`)
      .set('Cookie', s.party.cookie)
      .send(offerPayload())
      .expect(404);
  });

  it('a rationale is mandatory for both decisions', async () => {
    const s = await incidentAgainst();
    const cookie = await superAdminCookie();
    for (const decision of ['CONFIRMED', 'DISMISSED'] as const) {
      expect((await adjudicate(cookie, s.incidentId, decision, '   kısa  ').expect(400)).body.code).toBe('RATIONALE_REQUIRED');
      await request(ctx.server).post(`/admin/service-incidents/${s.incidentId}/adjudications`).set('Cookie', cookie).send({ decision }).expect(400);
    }
    expect(await ctx.prisma.providerIncidentAdjudication.count()).toBe(0);
  });

  it('permissions: READ alone cannot decide; ADJUDICATE can; nobody without READ sees the queue', async () => {
    const s = await incidentAgainst();
    const reader = await adminCookie([AdminPermission.SERVICE_INCIDENTS_READ]);
    const other = await adminCookie([AdminPermission.REQUESTS_READ]);
    await request(ctx.server).get('/admin/service-incidents').set('Cookie', reader.cookie).expect(200);
    await request(ctx.server).get(`/admin/service-incidents/${s.incidentId}`).set('Cookie', reader.cookie).expect(200);
    await request(ctx.server).get('/admin/service-incidents').set('Cookie', other.cookie).expect(403);
    await adjudicate(reader.cookie, s.incidentId, 'CONFIRMED').expect(403);
    await adjudicate(s.party.cookie, s.incidentId, 'CONFIRMED').expect(403);
    await adjudicate(s.owner.cookie, s.incidentId, 'CONFIRMED').expect(403);
    const decider = await adminCookie([AdminPermission.SERVICE_INCIDENTS_ADJUDICATE]);
    await adjudicate(decider.cookie, s.incidentId, 'CONFIRMED').expect(201);
  });

  it('a second decision is 409; two racing decisions leave exactly one', async () => {
    const s = await incidentAgainst();
    const cookie = await superAdminCookie();
    await adjudicate(cookie, s.incidentId, 'CONFIRMED').expect(201);
    expect((await adjudicate(cookie, s.incidentId, 'DISMISSED').expect(409)).body.code).toBe('INCIDENT_ALREADY_ADJUDICATED');

    const t = await incidentAgainst();
    const results = await Promise.all([
      adjudicate(cookie, t.incidentId, 'CONFIRMED'),
      adjudicate(cookie, t.incidentId, 'DISMISSED'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('INCIDENT_ALREADY_ADJUDICATED');
    expect(await ctx.prisma.providerIncidentAdjudication.count({ where: { incidentId: t.incidentId } })).toBe(1);
  });

  it('the database refuses a second INITIAL and any edit or delete of a decision', async () => {
    const s = await incidentAgainst();
    const cookie = await superAdminCookie();
    const { body } = await adjudicate(cookie, s.incidentId, 'CONFIRMED').expect(201);
    const admin = await ctx.prisma.user.findFirstOrThrow({ where: { role: UserRole.SUPER_ADMIN } });
    await expect(
      ctx.prisma.providerIncidentAdjudication.create({
        data: { incidentId: s.incidentId, sequence: 1, kind: 'INITIAL', decision: 'DISMISSED', rationale: 'İkinci ilk karar denemesi', decidedByAdminId: admin.id },
      }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.providerIncidentAdjudication.update({ where: { id: body.adjudicationId }, data: { rationale: 'Değiştirilmiş gerekçe metni' } }),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.providerIncidentAdjudication.delete({ where: { id: body.adjudicationId } })).rejects.toThrow(/append-only/);
    // The head cannot be cleared, nor the projection drift from it.
    await expect(
      ctx.prisma.providerServiceIncident.update({ where: { id: s.incidentId }, data: { status: 'DISMISSED' } }),
    ).rejects.toThrow(/projection/);
  });
});

// ── correction ───────────────────────────────────────────────────────────────

describe('correction (SUPER_ADMIN, append-only)', () => {
  it('an ADMIN is refused even holding every grantable permission, and no role can be given the right', async () => {
    const s = await incidentAgainst();
    const sa = await superAdminCookie();
    const { body } = await adjudicate(sa, s.incidentId, 'CONFIRMED').expect(201);

    const admin = await adminCookie([...GRANTABLE_ADMIN_PERMISSIONS]);
    await correct(admin.cookie, s.incidentId, 'DISMISSED', body.adjudicationId).expect(403);

    // A role row carrying the reserved value (written past the editor) grants nothing.
    const smuggled = await createAdminWithPermissions(ctx.prisma, [AdminPermission.SERVICE_INCIDENTS_CORRECT, AdminPermission.SERVICE_INCIDENTS_READ]);
    await correct(await loginAs(ctx.prisma, smuggled.admin.id), s.incidentId, 'DISMISSED', body.adjudicationId).expect(403);

    // The role editor refuses it.
    const created = await request(ctx.server)
      .post('/admin/roles')
      .set('Cookie', sa)
      .send({ key: `incident-fixers-${randomUUID().slice(0, 6)}`, name: 'Düzeltme', permissions: [AdminPermission.SERVICE_INCIDENTS_CORRECT] })
      .expect(400);
    expect(created.body.code).toBe('PERMISSION_RESERVED_FOR_SUPER_ADMIN');
    const catalogue = await request(ctx.server).get('/admin/permissions').set('Cookie', sa).expect(200);
    expect(catalogue.body.permissions).not.toContain('SERVICE_INCIDENTS_CORRECT');
    expect(catalogue.body.reservedForSuperAdmin).toEqual([
      'SERVICE_INCIDENTS_CORRECT',
      'MATCH_REVIEW_OPEN_ROUND',
      'SHOWCASE_ALLOWANCE_VOID',
    ]);

    expect(await ctx.prisma.providerIncidentAdjudication.count()).toBe(1);
  });

  it('CONFIRMED → DISMISSED → CONFIRMED: appended, chained, the old rows untouched, the head moves, the strike follows', async () => {
    const s = await incidentAgainst();
    const sa = await superAdminCookie();
    const initial = (await adjudicate(sa, s.incidentId, 'CONFIRMED').expect(201)).body;
    const initialRow = await ctx.prisma.providerIncidentAdjudication.findUniqueOrThrow({ where: { id: initial.adjudicationId } });
    expect((await reliability(sa, s.party.provider.id)).summary.confirmed).toBe(1);
    const before = await snapshot(s.incidentId);
    const credits = await creditRows();

    const first = (await correct(sa, s.incidentId, 'DISMISSED', initial.adjudicationId).expect(201)).body;
    expect(first).toMatchObject({
      kind: 'CORRECTION',
      decision: 'DISMISSED',
      sequence: 2,
      previousAdjudicationId: initial.adjudicationId,
      previousDecision: 'CONFIRMED',
    });
    expect(await ctx.prisma.providerIncidentAdjudication.findUniqueOrThrow({ where: { id: initial.adjudicationId } })).toEqual(initialRow);
    expect(await effectiveIncidentDecision(ctx.prisma, s.incidentId)).toMatchObject({ decision: 'DISMISSED', adjudicationId: first.adjudicationId });
    expect((await reliability(sa, s.party.provider.id)).summary).toMatchObject({ confirmed: 0, dismissed: 1 });

    const second = (await correct(sa, s.incidentId, 'CONFIRMED', first.adjudicationId).expect(201)).body;
    expect(second).toMatchObject({ sequence: 3, previousDecision: 'DISMISSED' });
    expect((await reliability(sa, s.party.provider.id)).summary.confirmed).toBe(1);

    const detail = (await request(ctx.server).get(`/admin/service-incidents/${s.incidentId}`).set('Cookie', sa).expect(200)).body;
    expect(detail.adjudications.map((a: { kind: string; decision: string; effective: boolean; previousDecision: string | null }) => [a.kind, a.decision, a.previousDecision, a.effective])).toEqual([
      ['INITIAL', 'CONFIRMED', null, false],
      ['CORRECTION', 'DISMISSED', 'CONFIRMED', false],
      ['CORRECTION', 'CONFIRMED', 'DISMISSED', true],
    ]);
    expect(detail.creditInvariant).toBe('NO_AUTOMATIC_REFUND');
    expect(detail.exclusion.exists).toBe(true);

    // Each decision owed the provider a message of its own.
    for (const [template, id] of [
      ['service-incident-confirmed', initial.adjudicationId],
      ['service-incident-dismissed', first.adjudicationId],
      ['service-incident-confirmed', second.adjudicationId],
    ]) {
      expect(await ctx.prisma.notificationLog.count({ where: { dedupeKey: `${template}:${id}` } })).toBe(1);
    }
    expect(await creditRows()).toBe(credits);
    expect(await snapshot(s.incidentId)).toEqual(before);
  });

  it('refusals: undecided, stale expected head, same decision', async () => {
    const s = await incidentAgainst();
    const sa = await superAdminCookie();
    expect((await correct(sa, s.incidentId, 'DISMISSED', 'nothing').expect(409)).body.code).toBe('INCIDENT_NOT_ADJUDICATED');
    const initial = (await adjudicate(sa, s.incidentId, 'CONFIRMED').expect(201)).body;
    expect((await correct(sa, s.incidentId, 'CONFIRMED', initial.adjudicationId).expect(409)).body.code).toBe('INCIDENT_CORRECTION_SAME_DECISION');
    expect((await correct(sa, s.incidentId, 'DISMISSED', 'stale-head').expect(409)).body).toMatchObject({
      code: 'INCIDENT_ADJUDICATION_CHANGED',
      effectiveAdjudicationId: initial.adjudicationId,
    });
    expect((await correct(sa, s.incidentId, 'DISMISSED', initial.adjudicationId, 'kısa').expect(400)).body.code).toBe('RATIONALE_REQUIRED');
  });

  it('two corrections on the same expected head: exactly one wins, the other is 409 INCIDENT_ADJUDICATION_CHANGED', async () => {
    const s = await incidentAgainst();
    const sa = await superAdminCookie();
    const initial = (await adjudicate(sa, s.incidentId, 'CONFIRMED').expect(201)).body;
    const results = await Promise.all([
      correct(sa, s.incidentId, 'DISMISSED', initial.adjudicationId, 'Birinci süper yönetici düzeltmesi.'),
      correct(sa, s.incidentId, 'DISMISSED', initial.adjudicationId, 'İkinci süper yönetici düzeltmesi.'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('INCIDENT_ADJUDICATION_CHANGED');
    const chain = await ctx.prisma.providerIncidentAdjudication.findMany({ where: { incidentId: s.incidentId }, orderBy: { sequence: 'asc' } });
    expect(chain.map((a) => a.sequence)).toEqual([1, 2]);
    const head = await ctx.prisma.providerServiceIncident.findUniqueOrThrow({ where: { id: s.incidentId } });
    expect(head.effectiveAdjudicationId).toBe(chain[1]!.id);
  });

  it('the database refuses a correction that does not supersede the head', async () => {
    const s = await incidentAgainst();
    const sa = await superAdminCookie();
    const initial = (await adjudicate(sa, s.incidentId, 'CONFIRMED').expect(201)).body;
    const first = (await correct(sa, s.incidentId, 'DISMISSED', initial.adjudicationId).expect(201)).body;
    const admin = await ctx.prisma.user.findFirstOrThrow({ where: { role: UserRole.SUPER_ADMIN } });
    // A fork from the old head.
    await expect(
      ctx.prisma.providerIncidentAdjudication.create({
        data: {
          incidentId: s.incidentId,
          sequence: 3,
          kind: 'CORRECTION',
          decision: 'CONFIRMED',
          rationale: 'Eski başa bağlı çatal denemesi',
          decidedByAdminId: admin.id,
          supersedesAdjudicationId: initial.adjudicationId,
        },
      }),
    ).rejects.toThrow(/INCIDENT_ADJUDICATION_CHANGED/);
    // A chain into another incident's decision.
    const t = await incidentAgainst();
    await adjudicate(sa, t.incidentId, 'CONFIRMED').expect(201);
    await expect(
      ctx.prisma.providerServiceIncident.update({ where: { id: t.incidentId }, data: { effectiveAdjudicationId: first.adjudicationId } }),
    ).rejects.toThrow();
  });
});

// ── reliability ──────────────────────────────────────────────────────────────

describe('reliability', () => {
  async function confirmedAgainst(party: Party, sa: string, count: number) {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const s = await incidentAgainst(party);
      await adjudicate(sa, s.incidentId, 'CONFIRMED').expect(201);
      ids.push(s.incidentId);
    }
    return ids;
  }

  it('0–1 NORMAL, 2 WARNING, 3 ADMIN_REVIEW_REQUIRED with exactly one review; a fourth opens none', async () => {
    const party = await addProvider();
    const sa = await superAdminCookie();
    expect((await reliability(sa, party.provider.id)).summary).toMatchObject({ confirmed: 0, level: 'NORMAL', openReview: null });
    await confirmedAgainst(party, sa, 1);
    expect((await reliability(sa, party.provider.id)).summary.level).toBe('NORMAL');
    await confirmedAgainst(party, sa, 1);
    expect((await reliability(sa, party.provider.id)).summary.level).toBe('WARNING');
    expect(await ctx.prisma.providerReliabilityReview.count()).toBe(0);

    const third = await incidentAgainst(party);
    const res = await adjudicate(sa, third.incidentId, 'CONFIRMED').expect(201);
    expect(res.body.openedReviewId).toEqual(expect.any(String));
    expect(res.body.providerReliability).toEqual({ confirmed: 3, level: 'ADMIN_REVIEW_REQUIRED' });
    const card = await reliability(sa, party.provider.id);
    expect(card.summary).toMatchObject({ confirmed: 3, level: 'ADMIN_REVIEW_REQUIRED' });
    expect(card.summary.openReview).toMatchObject({ id: res.body.openedReviewId, status: 'OPEN', triggerIncidentId: third.incidentId });
    expect(await ctx.prisma.notificationLog.count({ where: { dedupeKey: `provider-reliability-review-opened:${res.body.openedReviewId}` } })).toBe(1);

    await confirmedAgainst(party, sa, 1);
    expect(await ctx.prisma.providerReliabilityReview.count()).toBe(1);

    const queue = (await request(ctx.server).get('/admin/provider-reliability').set('Cookie', sa).expect(200)).body;
    expect(queue.items).toEqual([
      expect.objectContaining({ provider: expect.objectContaining({ id: party.provider.id }), confirmed90d: 4, level: 'ADMIN_REVIEW_REQUIRED' }),
    ]);
    // No suspension, no other effect on the account.
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: party.provider.id } })).status).toBe('APPROVED');
  });

  it('dismissed incidents and confirmations reported before the 90-day window do not count', async () => {
    const party = await addProvider();
    const sa = await superAdminCookie();
    const [old] = await confirmedAgainst(party, sa, 1);
    await ctx.prisma.providerServiceIncident.update({ where: { id: old }, data: { reportedAt: new Date(Date.now() - 91 * 86_400_000) } });
    const d1 = await incidentAgainst(party);
    const d2 = await incidentAgainst(party);
    await adjudicate(sa, d1.incidentId, 'DISMISSED').expect(201);
    await adjudicate(sa, d2.incidentId, 'DISMISSED').expect(201);
    await confirmedAgainst(party, sa, 1);
    const summary = await providerReliabilitySummary(ctx.prisma, party.provider.id, new Date());
    expect(summary).toMatchObject({ confirmed: 1, dismissed: 2, total: 3, level: 'NORMAL' });
  });

  it('a correction below three keeps the review and its history; the level follows the correction', async () => {
    const party = await addProvider();
    const sa = await superAdminCookie();
    const ids = await confirmedAgainst(party, sa, 3);
    const review = await ctx.prisma.providerReliabilityReview.findFirstOrThrow();
    const head = await ctx.prisma.providerServiceIncident.findUniqueOrThrow({ where: { id: ids[2] } });
    await correct(sa, ids[2]!, 'DISMISSED', head.effectiveAdjudicationId!).expect(201);
    const card = await reliability(sa, party.provider.id);
    expect(card.summary).toMatchObject({ confirmed: 2, level: 'WARNING' });
    expect(card.summary.openReview).toMatchObject({ id: review.id, status: 'OPEN' });
    expect(card.reviews).toHaveLength(1);
    // Back to three: still one unresolved review, not a second.
    const again = await ctx.prisma.providerServiceIncident.findUniqueOrThrow({ where: { id: ids[2] } });
    await correct(sa, ids[2]!, 'CONFIRMED', again.effectiveAdjudicationId!).expect(201);
    expect(await ctx.prisma.providerReliabilityReview.count()).toBe(1);
  });

  it('a dismissed incident corrected to CONFIRMED adds the strike and can open the review', async () => {
    const party = await addProvider();
    const sa = await superAdminCookie();
    await confirmedAgainst(party, sa, 2);
    const s = await incidentAgainst(party);
    const dismissed = (await adjudicate(sa, s.incidentId, 'DISMISSED').expect(201)).body;
    expect(await ctx.prisma.providerReliabilityReview.count()).toBe(0);
    const res = await correct(sa, s.incidentId, 'CONFIRMED', dismissed.adjudicationId).expect(201);
    expect(res.body.openedReviewId).toEqual(expect.any(String));
    expect(res.body.providerReliability.level).toBe('ADMIN_REVIEW_REQUIRED');
  });

  it('concurrent confirmations crossing three open exactly one review', async () => {
    const party = await addProvider();
    const sa = await superAdminCookie();
    await confirmedAgainst(party, sa, 1);
    const a = await incidentAgainst(party);
    const b = await incidentAgainst(party);
    const c = await incidentAgainst(party);
    const results = await Promise.all([a, b, c].map((s) => adjudicate(sa, s.incidentId, 'CONFIRMED')));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(await ctx.prisma.providerReliabilityReview.count()).toBe(1);
    expect(results.filter((r) => r.body.openedReviewId).length).toBe(1);
    expect((await providerReliabilitySummary(ctx.prisma, party.provider.id, new Date())).confirmed).toBe(4);
  });

  it('review lifecycle: acknowledge, resolve with a mandatory note, final; MANAGE is required', async () => {
    const party = await addProvider();
    const sa = await superAdminCookie();
    await confirmedAgainst(party, sa, 3);
    const review = await ctx.prisma.providerReliabilityReview.findFirstOrThrow();
    const reader = await adminCookie([AdminPermission.PROVIDER_RELIABILITY_READ]);
    await request(ctx.server).post(`/admin/provider-reliability-reviews/${review.id}/acknowledge`).set('Cookie', reader.cookie).expect(403);
    const manager = await adminCookie([AdminPermission.PROVIDER_RELIABILITY_MANAGE, AdminPermission.PROVIDER_RELIABILITY_READ]);
    const ack = await request(ctx.server).post(`/admin/provider-reliability-reviews/${review.id}/acknowledge`).set('Cookie', manager.cookie).expect(200);
    expect(ack.body).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: { id: manager.id } });
    await request(ctx.server).post(`/admin/provider-reliability-reviews/${review.id}/acknowledge`).set('Cookie', manager.cookie).expect(409);
    const noNote = await request(ctx.server).post(`/admin/provider-reliability-reviews/${review.id}/resolve`).set('Cookie', manager.cookie).send({ note: 'ok' }).expect(400);
    expect(noNote.body.code).toBe('RATIONALE_REQUIRED');
    const resolved = await request(ctx.server)
      .post(`/admin/provider-reliability-reviews/${review.id}/resolve`)
      .set('Cookie', manager.cookie)
      .send({ note: 'Sağlayıcıyla görüşüldü, aktif kalacak.' })
      .expect(200);
    expect(resolved.body).toMatchObject({ status: 'RESOLVED', note: 'Sağlayıcıyla görüşüldü, aktif kalacak.' });
    await request(ctx.server).post(`/admin/provider-reliability-reviews/${review.id}/resolve`).set('Cookie', manager.cookie).send({ note: 'İkinci kez kapatma denemesi.' }).expect(409);
    await expect(ctx.prisma.providerReliabilityReview.update({ where: { id: review.id }, data: { note: 'Değiştirilmiş not metni burada.' } })).rejects.toThrow(/final/);
    await expect(ctx.prisma.providerReliabilityReview.delete({ where: { id: review.id } })).rejects.toThrow(/never deleted/);
    expect(await ctx.prisma.providerReliabilityReview.findUniqueOrThrow({ where: { id: review.id } })).toMatchObject({ status: ProviderReliabilityReviewStatus.RESOLVED });
    // A further confirmation opens a new review (the resolved one stays).
    await confirmedAgainst(party, sa, 1);
    expect(await ctx.prisma.providerReliabilityReview.count()).toBe(2);
  });

  it('the queue filters by risk level and orders the open queue oldest first', async () => {
    const warned = await addProvider();
    const sa = await superAdminCookie();
    await confirmedAgainst(warned, sa, 2);
    const a = await incidentAgainst(warned);
    const b = await incidentAgainst();
    await ctx.prisma.providerServiceIncident.update({ where: { id: b.incidentId }, data: { reportedAt: new Date(Date.now() - 3_600_000) } });
    const open = (await request(ctx.server).get('/admin/service-incidents').set('Cookie', sa).expect(200)).body;
    expect(open.items.map((item: { id: string }) => item.id)).toEqual([b.incidentId, a.incidentId]);
    const warning = (await request(ctx.server).get('/admin/service-incidents?risk=WARNING').set('Cookie', sa).expect(200)).body;
    expect(warning.items.map((item: { id: string }) => item.id)).toEqual([a.incidentId]);
    expect(warning.items[0].provider).toMatchObject({ riskLevel: 'WARNING', confirmed90d: 2 });
    const normal = (await request(ctx.server).get('/admin/service-incidents?risk=NORMAL').set('Cookie', sa).expect(200)).body;
    expect(normal.items.map((item: { id: string }) => item.id)).toEqual([b.incidentId]);
    const responded = (await request(ctx.server).get('/admin/service-incidents?response=responded').set('Cookie', sa).expect(200)).body;
    expect(responded.total).toBe(0);
  });
});

// ── customer signal ──────────────────────────────────────────────────────────

describe('customer report signal (admin-only)', () => {
  it('HIGH_DISMISSAL_RATIO after enough dismissed reports — and the customer can still report', async () => {
    const person = await customer();
    const sa = await superAdminCookie();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const s = await incidentAgainst(undefined, person);
      ids.push(s.incidentId);
    }
    // Two decided: below the sample size, no signal.
    await adjudicate(sa, ids[0]!, 'DISMISSED').expect(201);
    await adjudicate(sa, ids[1]!, 'DISMISSED').expect(201);
    expect((await customerReportSummary(ctx.prisma, person.id, new Date())).signal).toBeNull();
    await adjudicate(sa, ids[2]!, 'DISMISSED').expect(201);

    const summary = await customerReportSummary(ctx.prisma, person.id, new Date());
    expect(summary).toMatchObject({ total: 3, dismissed: 3, confirmed: 0, dismissedRatio: 1, signal: 'HIGH_DISMISSAL_RATIO' });
    const detail = (await request(ctx.server).get(`/admin/service-incidents/${ids[2]}`).set('Cookie', sa).expect(200)).body;
    expect(detail.customerReports.signal).toBe('HIGH_DISMISSAL_RATIO');

    // No functional consequence: the next report goes through and reopens.
    const next = await incidentAgainst(undefined, person);
    expect(next.incidentId).toEqual(expect.any(String));
    // Nowhere outside the admin projection.
    const own = await request(ctx.server).get(`/service-requests/my/${next.requestId}`).set('Cookie', person.cookie).expect(200);
    expect(JSON.stringify(own.body)).not.toContain('DISMISSAL');
  });
});

// ── notices ──────────────────────────────────────────────────────────────────

describe('notices (outbox)', () => {
  it('the provider is told the outcome without the rationale; a notice a correction overtook is not sent', async () => {
    const s = await incidentAgainst();
    const sa = await superAdminCookie();
    const outbox = ctx.app.get(ServiceIssueOutbox);
    await outbox.whenIdle();
    await outbox.deliverPending();
    ctx.notifications.clear();

    const initial = (await adjudicate(sa, s.incidentId, 'CONFIRMED', 'Gizli personel gerekçesi: kamera kaydı incelendi.').expect(201)).body;
    // Overtaken before the sweep runs: the CONFIRMED notice must not go out.
    await outbox.whenIdle();
    await ctx.prisma.notificationLog.updateMany({
      where: { dedupeKey: `service-incident-confirmed:${initial.adjudicationId}` },
      data: { status: 'PENDING', attemptCount: 0, lastAttemptAt: null },
    });
    ctx.notifications.clear();
    await correct(sa, s.incidentId, 'DISMISSED', initial.adjudicationId, 'Gizli düzeltme gerekçesi metni burada.').expect(201);
    await outbox.whenIdle();
    await outbox.deliverPending();

    const sent = ctx.notifications.lastOfTemplate('service-incident-dismissed');
    expect(sent?.data).toMatchObject({ corrected: 'true', outcomeText: expect.stringContaining('reddedildi') });
    expect(JSON.stringify(sent)).not.toContain('Gizli');
    expect(ctx.notifications.lastOfTemplate('service-incident-confirmed')).toBeUndefined();
    const stale = await ctx.prisma.notificationLog.findFirstOrThrow({
      where: { dedupeKey: `service-incident-confirmed:${initial.adjudicationId}` },
    });
    expect(stale.status).not.toBe('SENT');
  });
});

// ── regressions ──────────────────────────────────────────────────────────────

describe('M3 invariants hold across decisions', () => {
  it('with the switch off the customer cannot report, while decisions on existing incidents still work', async () => {
    const s = await incidentAgainst();
    await ctx.prisma.operationsSettings.update({ where: { id: 'singleton' }, data: { serviceIssueReportingEnabled: false } });
    await adjudicate(await superAdminCookie(), s.incidentId, 'CONFIRMED').expect(201);
    const { currentRoundId } = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: s.requestId }, select: { currentRoundId: true } });
    await request(ctx.server)
      .post(`/service-requests/${s.requestId}/service-issue`)
      .set('Cookie', s.owner.cookie)
      .send({ roundId: currentRoundId, reason: 'PROVIDER_NO_SHOW', idempotencyKey: randomUUID() })
      .expect(404);
  });

  it('no decision or correction writes a credit row or an OFFER_REFUND', async () => {
    const s = await incidentAgainst();
    const sa = await superAdminCookie();
    const credits = await creditRows();
    const initial = (await adjudicate(sa, s.incidentId, 'CONFIRMED').expect(201)).body;
    const corrected = (await correct(sa, s.incidentId, 'DISMISSED', initial.adjudicationId).expect(201)).body;
    await correct(sa, s.incidentId, 'CONFIRMED', corrected.adjudicationId).expect(201);
    expect(await creditRows()).toBe(credits);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: CreditTransactionType.OFFER_REFUND, referenceId: s.offerId } })).toBe(0);
  });
});
