import { AdminPermission, CreditTransactionType, OfferStatus, ProviderStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCEPT_OFFER,
  backdateOfferSubmission,
  createAdminWithPermissions,
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
 * PROVIDER-STATUS-001: suspending, rejecting and re-activating a provider.
 *
 * - A suspension says why, like a rejection. The reasons and the internal note
 *   are the operator's: the admin detail and the status history read them,
 *   and no provider- or customer-facing response carries them (allowlist,
 *   not denylist — the owner's key set is pinned exactly).
 * - A suspended provider's live offers (SUBMITTED, VIEWED, SHORTLISTED) are
 *   hidden from the customer — list, comparison, detail, counters — and every
 *   action on them answers 409 PROVIDER_UNAVAILABLE. Nothing about the offer
 *   is written: not its status, not `viewedAt`, not the ledger.
 * - The unviewed-offer refund is the one that already exists (OFFER-VIEW-001):
 *   a hidden offer the customer never saw is paid back when its window ends;
 *   one they had seen is not.
 * - An accepted job continues: the offer stays on the list, messaging and the
 *   shared contact keep working.
 * - Approval again brings the hidden offers back, acceptable as before.
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
const SUSPENSION_REASON = 'GIZLI-ASKI-GEREKCESI şikâyet incelemesi';
const REJECTION_REASON = 'GIZLI-RET-GEREKCESI belge eksik';
const MODERATION_NOTE = 'GIZLI-IC-NOT telefonla arandı';
const SECRETS = [SUSPENSION_REASON, REJECTION_REASON, MODERATION_NOTE];
const MODERATION_KEYS = ['moderationNote', 'rejectionReason', 'suspensionReason'];

async function rootCookie() {
  const root = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, root.id);
}

function setStatus(cookie: string, providerId: string, body: Record<string, unknown>) {
  return request(ctx.server).patch(`/providers/${providerId}/status`).set('Cookie', cookie).send(body);
}

async function suspend(cookie: string, providerId: string) {
  await setStatus(cookie, providerId, {
    status: ProviderStatus.SUSPENDED,
    suspensionReason: SUSPENSION_REASON,
    moderationNote: MODERATION_NOTE,
  }).expect(200);
}

async function reactivate(cookie: string, providerId: string) {
  await setStatus(cookie, providerId, { status: ProviderStatus.APPROVED }).expect(200);
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
  return { provider, ownerUser, cookie, offerId: created.body.id as string };
}

async function fixture() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id });
  const customerCookie = await loginAs(ctx.prisma, customer.id);
  const kept = await addOffer(category.id, serviceRequest.id);
  const hidden = await addOffer(category.id, serviceRequest.id);
  return { category, customer, customerCookie, requestId: serviceRequest.id, kept, hidden, root: await rootCookie() };
}

const offerUrl = (requestId: string, offerId: string) => `/service-requests/${requestId}/offers/${offerId}`;

function readOffer(offerId: string) {
  return ctx.prisma.offer.findUniqueOrThrow({
    where: { id: offerId },
    select: { status: true, viewedAt: true, acceptedAt: true, rejectedAt: true, refundBlockedAt: true, creditRefundedAt: true },
  });
}

function ledger(providerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: { providerId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, type: true, amount: true },
  });
}

function refundRows(offerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: { type: CreditTransactionType.OFFER_REFUND, referenceType: 'Offer', referenceId: offerId },
  });
}

function expectUnavailable(response: request.Response) {
  expect(response.status).toBe(409);
  expect(response.body).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: 'Bu teklif şu anda kullanılamıyor.' });
  for (const secret of SECRETS) expect(JSON.stringify(response.body)).not.toContain(secret);
  expect(JSON.stringify(response.body)).not.toMatch(/SUSPENDED|askı/i);
}

// ── reason, note, audit, RBAC ───────────────────────────────────────────────

describe('suspension reason (F-1)', () => {
  it('is required: missing or blank is 400 and writes nothing', async () => {
    const root = await rootCookie();
    const category = await createCategory(ctx.prisma, 'Klima');
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });

    await setStatus(root, provider.id, { status: ProviderStatus.SUSPENDED }).expect(400);
    await setStatus(root, provider.id, { status: ProviderStatus.SUSPENDED, suspensionReason: '   ' }).expect(400);
    await setStatus(root, provider.id, {
      status: ProviderStatus.SUSPENDED,
      // A rejection reason is not a suspension reason.
      rejectionReason: REJECTION_REASON,
      moderationNote: MODERATION_NOTE,
    }).expect(400);

    const row = await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } });
    expect(row.status).toBe(ProviderStatus.APPROVED);
    expect(row.suspendedAt).toBeNull();
    expect(row.suspensionReason).toBeNull();
    expect(await ctx.prisma.providerStatusChange.count({ where: { providerId: provider.id } })).toBe(0);
  });

  it('is stored on the profile and the audit row, read back by the history; cleared by re-activation', async () => {
    const operator = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.PROVIDERS_MODERATE,
      AdminPermission.PROVIDERS_READ_DETAIL,
    ]);
    const cookie = await loginAs(ctx.prisma, operator.admin.id);
    const category = await createCategory(ctx.prisma, 'Klima');
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });

    await suspend(cookie, provider.id);
    let row = await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } });
    expect(row).toMatchObject({
      status: ProviderStatus.SUSPENDED,
      suspensionReason: SUSPENSION_REASON,
      moderationNote: MODERATION_NOTE,
      rejectionReason: null,
    });

    // The note is this move's own: a re-activation that sends none leaves none.
    await reactivate(cookie, provider.id);
    row = await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } });
    expect(row).toMatchObject({ status: ProviderStatus.APPROVED, suspensionReason: null, moderationNote: null });

    const history = await request(ctx.server)
      .get(`/providers/${provider.id}/status-history`)
      .set('Cookie', cookie)
      .expect(200);
    const [approved, suspended] = history.body.items;
    expect(suspended).toMatchObject({
      changes: [{ field: 'status', from: 'APPROVED', to: 'SUSPENDED' }],
      reason: SUSPENSION_REASON,
      note: MODERATION_NOTE,
      actor: { id: operator.admin.id },
    });
    expect(approved).toMatchObject({
      changes: [{ field: 'status', from: 'SUSPENDED', to: 'APPROVED' }],
      reason: null,
      note: null,
    });

    const audit = await ctx.prisma.providerStatusChange.findMany({
      where: { providerId: provider.id },
      orderBy: { createdAt: 'asc' },
      select: { toStatus: true, suspensionReason: true, rejectionReason: true, moderationNote: true },
    });
    expect(audit).toEqual([
      { toStatus: 'SUSPENDED', suspensionReason: SUSPENSION_REASON, rejectionReason: null, moderationNote: MODERATION_NOTE },
      { toStatus: 'APPROVED', suspensionReason: null, rejectionReason: null, moderationNote: null },
    ]);

    // The operator's detail carries the current reason.
    await suspend(cookie, provider.id);
    const detail = await request(ctx.server).get(`/providers/${provider.id}/admin-detail`).set('Cookie', cookie).expect(200);
    expect(detail.body.suspensionReason).toBe(SUSPENSION_REASON);
  });

  it('only PROVIDERS_MODERATE moves a status; the history needs PROVIDERS_READ_DETAIL', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: ownerUser.id, categoryId: category.id });
    const reader = await createAdminWithPermissions(ctx.prisma, [AdminPermission.PROVIDERS_READ_DETAIL, AdminPermission.PROVIDERS_READ]);
    const readerCookie = await loginAs(ctx.prisma, reader.admin.id);
    const listOnly = await createAdminWithPermissions(ctx.prisma, [AdminPermission.PROVIDERS_READ]);
    const listOnlyCookie = await loginAs(ctx.prisma, listOnly.admin.id);
    const owner = await loginAs(ctx.prisma, ownerUser.id);

    for (const cookie of [readerCookie, listOnlyCookie, owner]) {
      await setStatus(cookie, provider.id, { status: ProviderStatus.SUSPENDED, suspensionReason: SUSPENSION_REASON }).expect(403);
    }
    await request(ctx.server).patch(`/providers/${provider.id}/status`).send({ status: 'SUSPENDED', suspensionReason: 'x' }).expect(401);
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status).toBe(ProviderStatus.APPROVED);

    await suspend(await rootCookie(), provider.id);
    await request(ctx.server).get(`/providers/${provider.id}/status-history`).set('Cookie', listOnlyCookie).expect(403);
    await request(ctx.server).get(`/providers/${provider.id}/status-history`).set('Cookie', owner).expect(403);
    const history = await request(ctx.server).get(`/providers/${provider.id}/status-history`).set('Cookie', readerCookie).expect(200);
    expect(history.body.items[0].reason).toBe(SUSPENSION_REASON);
  });

  it('the database refuses a new suspension row without a reason (CHECK)', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    const actor = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    for (const suspensionReason of [null, '  ']) {
      await expect(
        ctx.prisma.providerStatusChange.create({
          data: { providerId: provider.id, fromStatus: 'APPROVED', toStatus: 'SUSPENDED', actorId: actor.id, suspensionReason },
        }),
      ).rejects.toThrow(/ProviderStatusChange_suspension_has_reason/);
    }
    // Every other move is unaffected.
    await ctx.prisma.providerStatusChange.create({
      data: { providerId: provider.id, fromStatus: 'APPROVED', toStatus: 'REJECTED', actorId: actor.id, rejectionReason: 'x' },
    });
  });
});

// ── no leak to the provider or the customer ─────────────────────────────────

/** The provider's own projection, exactly: an allowlist, not a denylist. */
const OWNER_PROVIDER_KEYS = [
  'addressNote',
  'approvedAt',
  'businessName',
  'businessRegistration',
  'city',
  'claimedAt',
  'contactName',
  'createdAt',
  'description',
  'district',
  'email',
  'id',
  'phone',
  'rejectedAt',
  'serviceAreas',
  'serviceCategories',
  'status',
  'suspendedAt',
  'taxNumberMasked',
  'taxType',
  'upcomingServiceCategories',
  'updatedAt',
  'user',
  'userId',
];

describe('the reasons and the note never reach the provider or the customer', () => {
  it('owner reads (me, dashboard, by id) and the owner save are the allowlist, for every moderated status', async () => {
    const root = await rootCookie();
    const category = await createCategory(ctx.prisma, 'Klima');
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: ownerUser.id, categoryId: category.id });
    const owner = await loginAs(ctx.prisma, ownerUser.id);

    const moves: Record<string, unknown>[] = [
      { status: ProviderStatus.SUSPENDED, suspensionReason: SUSPENSION_REASON, moderationNote: MODERATION_NOTE },
      { status: ProviderStatus.REJECTED, rejectionReason: REJECTION_REASON, moderationNote: MODERATION_NOTE },
    ];

    for (const move of moves) {
      await setStatus(root, provider.id, move).expect(200);

      const reads = [
        (await request(ctx.server).get('/providers/me').set('Cookie', owner).expect(200)).body,
        (await request(ctx.server).get('/providers/me/dashboard').set('Cookie', owner).expect(200)).body.provider,
        (await request(ctx.server).get(`/providers/${provider.id}`).set('Cookie', owner).expect(200)).body,
      ];
      for (const body of reads) {
        const { visibility: _visibility, ...record } = body as Record<string, unknown>;
        expect(Object.keys(record).sort(), String(move.status)).toEqual(OWNER_PROVIDER_KEYS);
        for (const key of MODERATION_KEYS) expect(body).not.toHaveProperty(key);
        for (const secret of SECRETS) expect(JSON.stringify(body)).not.toContain(secret);
      }
    }
  });

  it('a customer reading a suspended provider’s accepted offer, the matched contact and the public profile sees none of it', async () => {
    const { customerCookie, requestId, kept, root } = await fixture();
    await request(ctx.server).post(`${offerUrl(requestId, kept.offerId)}/action`).set('Cookie', customerCookie).send(ACCEPT_OFFER).expect(201);
    await suspend(root, kept.provider.id);

    const bodies = [
      (await request(ctx.server).get(`/service-requests/${requestId}/offers`).set('Cookie', customerCookie).expect(200)).body,
      (await request(ctx.server).get(offerUrl(requestId, kept.offerId)).set('Cookie', customerCookie).expect(200)).body,
      (await request(ctx.server).get(`/service-requests/${requestId}/matched-contact`).set('Cookie', customerCookie).expect(200)).body,
      (await request(ctx.server).get(`/service-requests/my/${requestId}`).set('Cookie', customerCookie).expect(200)).body,
      (await request(ctx.server).get(`/providers/${kept.provider.id}`).set('Cookie', customerCookie).expect(404)).body,
    ];
    for (const body of bodies) {
      const text = JSON.stringify(body);
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
    // Every provider object a customer response carries is free of the
    // moderation keys (the request's own `rejectionReason` is the request's
    // moderation, not the provider's, and is not looked at here).
    const providerObjects = [
      ...(bodies[0] as Array<{ provider: object }>).map((offer) => offer.provider),
      (bodies[1] as { provider: object }).provider,
      (bodies[2] as { provider: object }).provider,
    ];
    for (const provider of providerObjects) {
      for (const key of MODERATION_KEYS) expect(provider).not.toHaveProperty(key);
    }
  });
});

// ── the customer surfaces (F-3) ─────────────────────────────────────────────

describe('a suspended provider’s live offers are hidden from the customer', () => {
  it('list, counter, detail and view: hidden / 409, and nothing written', async () => {
    const { customerCookie, requestId, kept, hidden, root } = await fixture();
    const before = await readOffer(hidden.offerId);
    const ledgerBefore = await ledger(hidden.provider.id);

    await suspend(root, hidden.provider.id);

    const list = await request(ctx.server).get(`/service-requests/${requestId}/offers`).set('Cookie', customerCookie).expect(200);
    expect(list.body.map((offer: { id: string }) => offer.id)).toEqual([kept.offerId]);

    const mine = await request(ctx.server).get('/service-requests/my').set('Cookie', customerCookie).expect(200);
    const row = (mine.body.items ?? mine.body).find((item: { id: string }) => item.id === requestId);
    expect(row.offersCount).toBe(1);
    const one = await request(ctx.server).get(`/service-requests/my/${requestId}`).set('Cookie', customerCookie).expect(200);
    expect(one.body.offersCount).toBe(1);

    expectUnavailable(await request(ctx.server).get(offerUrl(requestId, hidden.offerId)).set('Cookie', customerCookie));
    expectUnavailable(await request(ctx.server).post(`${offerUrl(requestId, hidden.offerId)}/view`).set('Cookie', customerCookie));

    // A stranger is told what they were always told; the access check comes first.
    const stranger = await loginAs(ctx.prisma, (await createUser(ctx.prisma, { role: UserRole.CUSTOMER })).id);
    const foreign = await request(ctx.server).get(offerUrl(requestId, hidden.offerId)).set('Cookie', stranger);
    expect(foreign.status).not.toBe(409);
    expect([403, 404]).toContain(foreign.status);

    expect(await readOffer(hidden.offerId)).toEqual(before);
    expect(await ledger(hidden.provider.id)).toEqual(ledgerBefore);
  });

  it('impressions (list and compare) skip the hidden offer: viewedAt stays null (OFFER-VIEW-001)', async () => {
    const { customerCookie, requestId, kept, hidden, root } = await fixture();
    await suspend(root, hidden.provider.id);

    for (const surface of ['LIST', 'COMPARE']) {
      await request(ctx.server)
        .post(`/service-requests/${requestId}/offers/impressions`)
        .set('Cookie', customerCookie)
        .send({ offerIds: [kept.offerId, hidden.offerId], surface })
        .expect(200);
    }
    expect((await readOffer(kept.offerId)).viewedAt).not.toBeNull();
    expect(await readOffer(hidden.offerId)).toMatchObject({ viewedAt: null, status: OfferStatus.SUBMITTED });
  });

  it('a stamp the customer made before the suspension is kept exactly', async () => {
    const { customerCookie, requestId, hidden, root } = await fixture();
    await request(ctx.server).post(`${offerUrl(requestId, hidden.offerId)}/view`).set('Cookie', customerCookie).expect(201);
    const seen = await readOffer(hidden.offerId);
    expect(seen.viewedAt).not.toBeNull();

    await suspend(root, hidden.provider.id);
    expectUnavailable(await request(ctx.server).post(`${offerUrl(requestId, hidden.offerId)}/view`).set('Cookie', customerCookie));
    await reactivate(root, hidden.provider.id);
    await request(ctx.server).post(`${offerUrl(requestId, hidden.offerId)}/view`).set('Cookie', customerCookie).expect(201);

    expect((await readOffer(hidden.offerId)).viewedAt).toEqual(seen.viewedAt);
  });

  it('accept, shortlist and reject answer 409 PROVIDER_UNAVAILABLE — for the customer and an operator — and change nothing', async () => {
    const { customerCookie, requestId, hidden, root } = await fixture();
    await suspend(root, hidden.provider.id);
    const before = await readOffer(hidden.offerId);
    const ledgerBefore = await ledger(hidden.provider.id);

    for (const cookie of [customerCookie, root]) {
      for (const body of [ACCEPT_OFFER, { action: 'SHORTLIST' }, { action: 'REJECT' }]) {
        expectUnavailable(await request(ctx.server).post(`${offerUrl(requestId, hidden.offerId)}/action`).set('Cookie', cookie).send(body));
      }
    }

    expect(await readOffer(hidden.offerId)).toEqual(before);
    expect(await ledger(hidden.provider.id)).toEqual(ledgerBefore);
    const serviceRequest = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(serviceRequest).toMatchObject({ status: ServiceRequestStatus.APPROVED, matchedOfferId: null });
    expect(await ctx.prisma.contactRevealEvent.count({ where: { requestId } })).toBe(0);
  });

  it('a shortlisted offer is hidden as well; a rival’s acceptance still closes it as before', async () => {
    const { customerCookie, requestId, kept, hidden, root } = await fixture();
    await request(ctx.server).post(`${offerUrl(requestId, hidden.offerId)}/action`).set('Cookie', customerCookie).send({ action: 'SHORTLIST' }).expect(201);
    await suspend(root, hidden.provider.id);

    const list = await request(ctx.server).get(`/service-requests/${requestId}/offers`).set('Cookie', customerCookie).expect(200);
    expect(list.body.map((offer: { id: string }) => offer.id)).toEqual([kept.offerId]);

    await request(ctx.server).post(`${offerUrl(requestId, kept.offerId)}/action`).set('Cookie', customerCookie).send(ACCEPT_OFFER).expect(201);
    expect((await readOffer(hidden.offerId)).status).toBe(OfferStatus.REJECTED);
  });

  it('every other provider’s offers and an operator’s offer screens are unaffected', async () => {
    const { requestId, hidden, root } = await fixture();
    await suspend(root, hidden.provider.id);
    const admin = await request(ctx.server).get(`/offers?providerId=${hidden.provider.id}`).set('Cookie', root).expect(200);
    const ids = (admin.body.items ?? admin.body).map((offer: { id: string }) => offer.id);
    expect(ids).toContain(hidden.offerId);
    await request(ctx.server).get(`/offers/${hidden.offerId}`).set('Cookie', root).expect(200);
    // The provider still sees and may withdraw its own offer.
    const own = await request(ctx.server).get(`/providers/${hidden.provider.id}/offers`).set('Cookie', hidden.cookie).expect(200);
    expect(JSON.stringify(own.body)).toContain(hidden.offerId);
    expect(requestId).toBeTruthy();
  });
});

describe('the unviewed-offer refund is the existing one', () => {
  it('a hidden offer never seen is paid back when its window ends; one seen before the suspension is not', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const root = await rootCookie();
    const unseenRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id });
    const seenRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id });

    const unseen = await addOffer(category.id, unseenRequest.id);
    const seen = await addOffer(category.id, seenRequest.id);
    await request(ctx.server).post(`${offerUrl(seenRequest.id, seen.offerId)}/view`).set('Cookie', customerCookie).expect(201);

    await suspend(root, unseen.provider.id);
    await suspend(root, seen.provider.id);
    await backdateOfferSubmission(ctx.prisma, unseen.offerId, 72);
    await backdateOfferSubmission(ctx.prisma, seen.offerId, 72);

    const result = await ctx.app.get(UnviewedOfferRefundService).execute();
    expect(result.refunded).toBe(1);
    expect(await refundRows(unseen.offerId)).toHaveLength(1);
    expect(await refundRows(seen.offerId)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, unseen.provider.id)).toBe(STARTING_CREDITS);
    expect(await currentCreditBalance(ctx.prisma, seen.provider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
    // Status untouched by the suspension, and by the refund.
    expect((await readOffer(unseen.offerId)).status).toBe(OfferStatus.SUBMITTED);
  });
});

describe('an accepted job continues', () => {
  it('the accepted offer stays on the list; messaging and the matched contact keep working', async () => {
    const { customerCookie, requestId, kept, root } = await fixture();
    await request(ctx.server).post(`${offerUrl(requestId, kept.offerId)}/action`).set('Cookie', customerCookie).send(ACCEPT_OFFER).expect(201);
    const thread = await request(ctx.server).post('/messages/threads/resolve').set('Cookie', customerCookie).send({ requestId }).expect(201);

    await suspend(root, kept.provider.id);

    const list = await request(ctx.server).get(`/service-requests/${requestId}/offers`).set('Cookie', customerCookie).expect(200);
    expect(list.body.find((offer: { id: string }) => offer.id === kept.offerId).status).toBe(OfferStatus.ACCEPTED);
    await request(ctx.server).get(offerUrl(requestId, kept.offerId)).set('Cookie', customerCookie).expect(200);

    await request(ctx.server)
      .post(`/messages/threads/${thread.body.id}/messages`)
      .set('Cookie', customerCookie)
      .send({ body: 'Yarın uygun musunuz?' })
      .expect(201);
    await request(ctx.server)
      .post(`/messages/threads/${thread.body.id}/messages`)
      .set('Cookie', kept.cookie)
      .send({ body: 'Evet, saat onda geliyoruz.' })
      .expect(201);

    const contact = await request(ctx.server).get(`/service-requests/${requestId}/matched-contact`).set('Cookie', customerCookie).expect(200);
    expect(contact.body.provider.id).toBe(kept.provider.id);
    await request(ctx.server).get(`/providers/${kept.provider.id}/offers/${kept.offerId}/matched-contact`).set('Cookie', kept.cookie).expect(200);
  });
});

describe('re-activation', () => {
  it('brings the hidden offer back, acceptable as before', async () => {
    const { customerCookie, requestId, kept, hidden, root } = await fixture();
    await suspend(root, hidden.provider.id);
    await reactivate(root, hidden.provider.id);

    const list = await request(ctx.server).get(`/service-requests/${requestId}/offers`).set('Cookie', customerCookie).expect(200);
    expect(list.body.map((offer: { id: string }) => offer.id).sort()).toEqual([kept.offerId, hidden.offerId].sort());
    await request(ctx.server).post(`${offerUrl(requestId, hidden.offerId)}/action`).set('Cookie', customerCookie).send(ACCEPT_OFFER).expect(201);
    expect((await readOffer(hidden.offerId)).status).toBe(OfferStatus.ACCEPTED);
  });

  it('every non-approved status hides alike (REJECTED, PENDING_REVIEW, DRAFT)', async () => {
    const { customerCookie, requestId, hidden, root } = await fixture();
    for (const move of [
      { status: ProviderStatus.REJECTED, rejectionReason: REJECTION_REASON },
      { status: ProviderStatus.PENDING_REVIEW },
      { status: ProviderStatus.DRAFT },
    ]) {
      await setStatus(root, hidden.provider.id, move).expect(200);
      expectUnavailable(await request(ctx.server).get(offerUrl(requestId, hidden.offerId)).set('Cookie', customerCookie));
    }
  });
});

describe('a suspension racing an acceptance', () => {
  it('never leaves a suspended provider matched', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await resetDatabase(ctx.prisma);
      const { customerCookie, requestId, hidden, root } = await fixture();
      const [accept] = await Promise.all([
        request(ctx.server).post(`${offerUrl(requestId, hidden.offerId)}/action`).set('Cookie', customerCookie).send(ACCEPT_OFFER),
        setStatus(root, hidden.provider.id, { status: ProviderStatus.SUSPENDED, suspensionReason: SUSPENSION_REASON }),
      ]);
      const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: hidden.provider.id } });
      const matchedTo = (await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } })).matchedOfferId;
      expect(provider.status).toBe(ProviderStatus.SUSPENDED);
      // Either the acceptance committed first (a job that continues), or it was refused.
      if (accept.status === 201) {
        expect(matchedTo).toBe(hidden.offerId);
      } else {
        expect(accept.status).toBe(409);
        expect(matchedTo).toBeNull();
      }
    }
  });
});
