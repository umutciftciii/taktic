import { randomUUID } from 'node:crypto';
import {
  AdminPermission,
  CategoryDeliveryModel,
  RequestDeliveryMode,
  ServiceCategoryStatus,
  ServiceRequestQuestionSystemField,
  ServiceRequestQuestionType,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addIsoDays, isoDayToStoredDate, todayIsoDay } from '../src/common/date-only';
import { resolveRequestDeliveryMode } from '../src/common/delivery-mode';
import { matchesRequestLocation } from '../src/common/provider-request-matching';
import { ServiceIssueOutbox } from '../src/modules/notifications/service-issue-outbox.service';
import {
  ACCEPT_OFFER,
  createAdminWithPermissions,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createProviderProfile,
  createShowcasePackage,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  proveShowcaseLeadPhone,
  providerPayload,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  showcaseLeadPayload,
  type TestContext,
} from './harness';
import { roundInconsistencies } from './match-round-consistency';

/**
 * MATCH-001 — category delivery model and location-independent remote
 * matching, end to end through the API.
 *
 * The rule under test is one sentence: a request's own `deliveryMode` (its
 * category's model at creation; the customer's choice for HYBRID) decides
 * whether provider service areas are a matching criterion, and nothing else
 * about who may see or act on it changes. Every provider-facing surface —
 * discovery list, detail, offer, publish fan-out — is asked the same question,
 * and a later change of the category moves no existing request.
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
  return loginAs(ctx.prisma, admin.id);
}

type Party = { provider: { id: string }; userId: string; cookie: string };

type Area = { city: string; district?: string | null; neighborhood?: string | null };

const KADIKOY: Area = { city: 'İstanbul', district: 'Kadıköy' };
const CANKAYA: Area = { city: 'Ankara', district: 'Çankaya' };

/** An APPROVED provider bound to the category, serving `areas` (none when empty). */
async function addProvider(categoryId: string, areas: Area[] = [KADIKOY], credits = 20): Promise<Party> {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  let providerId: string;
  if (areas.length === 0) {
    const profile = await createProviderProfile(ctx.prisma, { userId: user.id });
    await ctx.prisma.providerServiceCategory.create({ data: { providerId: profile.id, categoryId } });
    providerId = profile.id;
  } else {
    providerId = (await createDiscoverableProvider(ctx.prisma, { userId: user.id, categoryId, areas })).id;
  }
  if (credits > 0) {
    await grantCredits(ctx.prisma, providerId, credits);
  }
  return { provider: { id: providerId }, userId: user.id, cookie: await loginAs(ctx.prisma, user.id) };
}

/** Creates a request through the public form and approves it as a super admin (the publish fan-out runs). */
async function liveRequest(
  sa: string,
  categorySlug: string,
  overrides: Record<string, unknown> = {},
): Promise<{ requestId: string; customerCookie: string }> {
  // The public form's per-IP budget is not what these cases are about.
  resetAuthThrottle(ctx.app);
  const created = await request(ctx.server)
    .post('/service-requests')
    .send(serviceRequestPayload(categorySlug, overrides))
    .expect(201);
  const requestId = created.body.id as string;
  await request(ctx.server)
    .patch(`/service-requests/${requestId}/status`)
    .set('Cookie', sa)
    .send({ status: ServiceRequestStatus.APPROVED })
    .expect(200);
  const { customerId } = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
  return { requestId, customerCookie: await loginAs(ctx.prisma, customerId!) };
}

async function sees(party: Party, requestId: string) {
  const list = await request(ctx.server)
    .get(`/providers/${party.provider.id}/requests`)
    .set('Cookie', party.cookie)
    .expect(200);
  const inList = list.body.some((item: { id: string }) => item.id === requestId);
  const detail = await request(ctx.server)
    .get(`/providers/${party.provider.id}/requests/${requestId}`)
    .set('Cookie', party.cookie);
  // The list and the detail are one rule; a disagreement is itself a bug.
  expect(detail.status === 200).toBe(inList);
  return inList;
}

function postOffer(party: Party, requestId: string, overrides: Record<string, unknown> = {}) {
  return request(ctx.server)
    .post(`/providers/${party.provider.id}/requests/${requestId}/offers`)
    .set('Cookie', party.cookie)
    .send(offerPayload(overrides));
}

async function availableNotices(requestId: string) {
  return ctx.prisma.notificationLog.findMany({
    where: { template: 'request-available', requestId },
    select: { providerId: true, dedupeKey: true },
  });
}

async function deliveryModeOf(requestId: string) {
  return (
    await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId }, select: { deliveryMode: true } })
  ).deliveryMode;
}

async function currentRoundId(requestId: string) {
  return (
    await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId }, select: { currentRoundId: true } })
  ).currentRoundId;
}

/** One round: the party offers, the customer accepts, the start day passes, the customer reports. */
async function failRoundWith(requestId: string, customerCookie: string, party: Party) {
  const offer = await postOffer(party, requestId).expect(201);
  await request(ctx.server)
    .post(`/service-requests/${requestId}/offers/${offer.body.id}/action`)
    .set('Cookie', customerCookie)
    .send(ACCEPT_OFFER)
    .expect(201);
  const today = todayIsoDay();
  await ctx.prisma.offer.update({
    where: { id: offer.body.id },
    data: {
      estimatedStartDate: isoDayToStoredDate(addIsoDays(today, -2)),
      estimatedCompletionDate: isoDayToStoredDate(addIsoDays(today, 3)),
    },
  });
  await request(ctx.server)
    .post(`/service-requests/${requestId}/service-issue`)
    .set('Cookie', customerCookie)
    .send({ roundId: await currentRoundId(requestId), reason: 'PROVIDER_NO_SHOW', idempotencyKey: randomUUID() })
    .expect(200);
}

// ── the rule itself ──────────────────────────────────────────────────────────

describe('resolveRequestDeliveryMode / matchesRequestLocation', () => {
  it('fixes ON_SITE and REMOTE categories, requires a choice for HYBRID, and refuses a mode the category cannot take', () => {
    expect(resolveRequestDeliveryMode(CategoryDeliveryModel.ON_SITE, undefined)).toBe(RequestDeliveryMode.ON_SITE);
    expect(resolveRequestDeliveryMode(CategoryDeliveryModel.ON_SITE, RequestDeliveryMode.ON_SITE)).toBe(
      RequestDeliveryMode.ON_SITE,
    );
    expect(resolveRequestDeliveryMode(CategoryDeliveryModel.REMOTE, null)).toBe(RequestDeliveryMode.REMOTE);
    expect(resolveRequestDeliveryMode(CategoryDeliveryModel.HYBRID, RequestDeliveryMode.REMOTE)).toBe(
      RequestDeliveryMode.REMOTE,
    );
    expect(resolveRequestDeliveryMode(CategoryDeliveryModel.HYBRID, RequestDeliveryMode.ON_SITE)).toBe(
      RequestDeliveryMode.ON_SITE,
    );
    expect(() => resolveRequestDeliveryMode(CategoryDeliveryModel.HYBRID, undefined)).toThrow();
    expect(() => resolveRequestDeliveryMode(CategoryDeliveryModel.ON_SITE, RequestDeliveryMode.REMOTE)).toThrow();
    expect(() => resolveRequestDeliveryMode(CategoryDeliveryModel.REMOTE, RequestDeliveryMode.ON_SITE)).toThrow();
  });

  it('skips the area step for REMOTE only', () => {
    const place = { city: 'Ankara', district: 'Çankaya', neighborhood: null };
    const istanbul = [{ city: 'İstanbul', district: 'Kadıköy', neighborhood: null }];
    expect(matchesRequestLocation(istanbul, { ...place, deliveryMode: RequestDeliveryMode.ON_SITE })).toBe(false);
    expect(matchesRequestLocation(istanbul, { ...place, deliveryMode: RequestDeliveryMode.REMOTE })).toBe(true);
    expect(matchesRequestLocation([], { ...place, deliveryMode: RequestDeliveryMode.REMOTE })).toBe(true);
    expect(matchesRequestLocation([], { ...place, deliveryMode: RequestDeliveryMode.ON_SITE })).toBe(false);
  });
});

// ── category ─────────────────────────────────────────────────────────────────

describe('category delivery model', () => {
  it('defaults to ON_SITE, accepts REMOTE and HYBRID, refuses an unknown value, is public and audited', async () => {
    const { admin } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.CATEGORIES_WRITE,
      AdminPermission.CATEGORIES_STATUS,
      AdminPermission.CATALOG_READ,
    ]);
    const cookie = await loginAs(ctx.prisma, admin.id);
    const post = (body: Record<string, unknown>) => request(ctx.server).post('/categories').set('Cookie', cookie).send(body);

    const plain = await post({ name: 'Boya', slug: 'boya', offerCreditCost: 2 }).expect(201);
    expect(plain.body.deliveryModel).toBe('ON_SITE');
    const remote = await post({ name: 'Online ders', slug: 'online-ders', offerCreditCost: 2, deliveryModel: 'REMOTE' }).expect(201);
    expect(remote.body.deliveryModel).toBe('REMOTE');
    const hybrid = await post({ name: 'Danışmanlık', slug: 'danismanlik', offerCreditCost: 2, deliveryModel: 'HYBRID' }).expect(201);
    expect(hybrid.body.deliveryModel).toBe('HYBRID');
    await post({ name: 'Yanlış', slug: 'yanlis', offerCreditCost: 2, deliveryModel: 'ONLINE' }).expect(400);

    // The public page carries it: the request form needs it.
    const page = await request(ctx.server).get('/categories/online-ders').expect(200);
    expect(page.body.deliveryModel).toBe('REMOTE');

    await request(ctx.server).patch(`/categories/${remote.body.id}`).set('Cookie', cookie).send({ deliveryModel: 'HYBRID' }).expect(200);
    const history = await request(ctx.server).get('/admin/categories/online-ders/history').set('Cookie', cookie).expect(200);
    const updated = history.body.items.filter((item: { action: string }) => item.action === 'UPDATED');
    expect(updated).toHaveLength(1);
    expect(updated[0].changes).toEqual([{ field: 'deliveryModel', from: 'REMOTE', to: 'HYBRID' }]);

    // An existing category reads ON_SITE (the column default, no rewrite).
    const legacy = await createCategory(ctx.prisma, 'Eski');
    expect(legacy.deliveryModel).toBe(CategoryDeliveryModel.ON_SITE);
  });
});

// ── request creation ─────────────────────────────────────────────────────────

describe('request creation', () => {
  it('snapshots the mode: ON_SITE → ON_SITE, REMOTE → REMOTE, HYBRID by choice; HYBRID without a choice and a contradicting choice are 400', async () => {
    const onSite = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const remote = await createCategory(ctx.prisma, 'Online', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.REMOTE });
    const hybrid = await createCategory(ctx.prisma, 'Hibrit', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.HYBRID });
    const create = (slug: string, overrides: Record<string, unknown> = {}) => {
      resetAuthThrottle(ctx.app);
      return request(ctx.server).post('/service-requests').send(serviceRequestPayload(slug, overrides));
    };

    expect(await deliveryModeOf((await create(onSite.slug).expect(201)).body.id)).toBe('ON_SITE');
    expect(await deliveryModeOf((await create(remote.slug).expect(201)).body.id)).toBe('REMOTE');
    expect(await deliveryModeOf((await create(remote.slug, { deliveryMode: 'REMOTE' }).expect(201)).body.id)).toBe('REMOTE');
    expect(await deliveryModeOf((await create(hybrid.slug, { deliveryMode: 'ON_SITE' }).expect(201)).body.id)).toBe('ON_SITE');
    expect(await deliveryModeOf((await create(hybrid.slug, { deliveryMode: 'REMOTE' }).expect(201)).body.id)).toBe('REMOTE');

    const missing = await create(hybrid.slug).expect(400);
    expect(missing.body.code).toBe('DELIVERY_MODE_REQUIRED');
    expect((await create(onSite.slug, { deliveryMode: 'REMOTE' }).expect(400)).body.code).toBe('DELIVERY_MODE_MISMATCH');
    expect((await create(remote.slug, { deliveryMode: 'ON_SITE' }).expect(400)).body.code).toBe('DELIVERY_MODE_MISMATCH');
    await create(hybrid.slug, { deliveryMode: 'BOTH' }).expect(400);
  });

  it('a required ADDRESS binding does not ask a REMOTE request for a neighbourhood; ON_SITE still must', async () => {
    const remote = await createCategory(ctx.prisma, 'Online', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.HYBRID });
    await ctx.prisma.serviceRequestQuestion.create({
      data: {
        categoryId: remote.id,
        key: 'adres',
        label: 'Adres',
        type: ServiceRequestQuestionType.TEXT,
        isRequired: true,
        systemField: ServiceRequestQuestionSystemField.ADDRESS,
        sortOrder: 10,
        isActive: true,
      },
    });
    await request(ctx.server).post('/service-requests').send(serviceRequestPayload(remote.slug, { deliveryMode: 'REMOTE' })).expect(201);
    await request(ctx.server).post('/service-requests').send(serviceRequestPayload(remote.slug, { deliveryMode: 'ON_SITE' })).expect(400);
  });

  it('the database refuses a request whose mode disagrees with its category, and any change of the mode', async () => {
    const onSite = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const remote = await createCategory(ctx.prisma, 'Online', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.REMOTE });
    const base = {
      customerName: 'Müşteri',
      customerPhone: '+905550000001',
      city: 'İstanbul',
      district: 'Kadıköy',
    };
    await expect(
      ctx.prisma.serviceRequest.create({ data: { ...base, categoryId: onSite.id, deliveryMode: RequestDeliveryMode.REMOTE } }),
    ).rejects.toThrow(/does not match category model/);
    await expect(ctx.prisma.serviceRequest.create({ data: { ...base, categoryId: remote.id } })).rejects.toThrow(
      /does not match category model/,
    );
    const row = await ctx.prisma.serviceRequest.create({
      data: { ...base, categoryId: remote.id, deliveryMode: RequestDeliveryMode.REMOTE },
    });
    await expect(
      ctx.prisma.serviceRequest.update({ where: { id: row.id }, data: { deliveryMode: RequestDeliveryMode.ON_SITE } }),
    ).rejects.toThrow(/immutable/);
    // An update that does not touch the mode is untouched by the guard.
    await ctx.prisma.serviceRequest.update({ where: { id: row.id }, data: { description: 'güncel' } });
  });
});

// ── discovery, detail, offer, fan-out ────────────────────────────────────────

describe('matching matrix', () => {
  it('ON_SITE respects areas, REMOTE ignores them (cross-region and no-region providers see it), HYBRID follows the snapshot; the fan-out agrees', async () => {
    const sa = await superAdmin();
    const onSite = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const remote = await createCategory(ctx.prisma, 'Online', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.REMOTE });
    const hybrid = await createCategory(ctx.prisma, 'Hibrit', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.HYBRID });

    const local = { onSite: await addProvider(onSite.id), remote: await addProvider(remote.id), hybrid: await addProvider(hybrid.id) };
    const far = {
      onSite: await addProvider(onSite.id, [CANKAYA]),
      remote: await addProvider(remote.id, [CANKAYA]),
      hybrid: await addProvider(hybrid.id, [CANKAYA]),
    };
    const nowhere = { onSite: await addProvider(onSite.id, []), remote: await addProvider(remote.id, []), hybrid: await addProvider(hybrid.id, []) };
    // Bound to another category: never sees a REMOTE request of this one.
    const otherCategory = await createCategory(ctx.prisma, 'Başka', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.REMOTE });
    const unbound = await addProvider(otherCategory.id, [KADIKOY]);

    const r = {
      onSite: (await liveRequest(sa, onSite.slug)).requestId,
      remote: (await liveRequest(sa, remote.slug)).requestId,
      hybridOnSite: (await liveRequest(sa, hybrid.slug, { deliveryMode: 'ON_SITE' })).requestId,
      hybridRemote: (await liveRequest(sa, hybrid.slug, { deliveryMode: 'REMOTE' })).requestId,
    };

    // ON_SITE: same region yes; different region and no region no.
    expect(await sees(local.onSite, r.onSite)).toBe(true);
    expect(await sees(far.onSite, r.onSite)).toBe(false);
    expect(await sees(nowhere.onSite, r.onSite)).toBe(false);
    // REMOTE: all three.
    expect(await sees(local.remote, r.remote)).toBe(true);
    expect(await sees(far.remote, r.remote)).toBe(true);
    expect(await sees(nowhere.remote, r.remote)).toBe(true);
    expect(await sees(unbound, r.remote)).toBe(false);
    // HYBRID follows the request's own mode.
    expect(await sees(local.hybrid, r.hybridOnSite)).toBe(true);
    expect(await sees(far.hybrid, r.hybridOnSite)).toBe(false);
    expect(await sees(nowhere.hybrid, r.hybridOnSite)).toBe(false);
    expect(await sees(local.hybrid, r.hybridRemote)).toBe(true);
    expect(await sees(far.hybrid, r.hybridRemote)).toBe(true);
    expect(await sees(nowhere.hybrid, r.hybridRemote)).toBe(true);

    // The projection says so.
    const list = await request(ctx.server).get(`/providers/${far.remote.provider.id}/requests`).set('Cookie', far.remote.cookie).expect(200);
    expect(list.body.find((item: { id: string }) => item.id === r.remote).deliveryMode).toBe('REMOTE');
    // …and still nothing the customer did not publish: no contact, no address note.
    const detail = await request(ctx.server)
      .get(`/providers/${far.remote.provider.id}/requests/${r.remote}`)
      .set('Cookie', far.remote.cookie)
      .expect(200);
    expect(detail.body.deliveryMode).toBe('REMOTE');
    for (const field of ['customerName', 'customerPhone', 'customerEmail', 'customerId']) {
      expect(detail.body).not.toHaveProperty(field);
    }

    // The publish fan-out reaches exactly the providers that see the request, once each.
    const reached = async (requestId: string) =>
      (await availableNotices(requestId)).map((notice) => notice.providerId).sort();
    expect(await reached(r.onSite)).toEqual([local.onSite.provider.id]);
    expect(await reached(r.remote)).toEqual(
      [local.remote.provider.id, far.remote.provider.id, nowhere.remote.provider.id].sort(),
    );
    expect(await reached(r.hybridOnSite)).toEqual([local.hybrid.provider.id]);
    expect(await reached(r.hybridRemote)).toEqual(
      [local.hybrid.provider.id, far.hybrid.provider.id, nowhere.hybrid.provider.id].sort(),
    );
    const keys = (await availableNotices(r.remote)).map((notice) => notice.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('offer: wrong-region ON_SITE is refused, wrong-region and no-region REMOTE succeed; every other guard still holds for REMOTE', async () => {
    const sa = await superAdmin();
    const onSite = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const remote = await createCategory(ctx.prisma, 'Online', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.REMOTE });
    const other = await createCategory(ctx.prisma, 'Başka', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.REMOTE });

    const farOnSite = await addProvider(onSite.id, [CANKAYA]);
    const farRemote = await addProvider(remote.id, [CANKAYA]);
    const nowhereRemote = await addProvider(remote.id, []);
    const broke = await addProvider(remote.id, [CANKAYA], 0);
    const unbound = await addProvider(other.id, [KADIKOY]);
    const late = await addProvider(remote.id, [CANKAYA]);

    const onSiteRequest = (await liveRequest(sa, onSite.slug)).requestId;
    const live = await liveRequest(sa, remote.slug);

    // A stale URL for the wrong region: the same "does not exist" as before.
    await postOffer(farOnSite, onSiteRequest).expect(404);

    // REMOTE: schedule still required, credit still required, binding still required.
    await postOffer(farRemote, live.requestId, { estimatedStartDate: undefined, estimatedCompletionDate: undefined }).expect(400);
    const noCredit = await postOffer(broke, live.requestId);
    expect(noCredit.status).toBeGreaterThanOrEqual(400);
    expect(await ctx.prisma.offer.count({ where: { providerId: broke.provider.id } })).toBe(0);
    await postOffer(unbound, live.requestId).expect(404);

    const first = await postOffer(farRemote, live.requestId).expect(201);
    await postOffer(nowhereRemote, live.requestId).expect(201);
    // A duplicate in the same round is the same 409 as ever.
    await postOffer(farRemote, live.requestId).expect(409);

    // Once the round is matched it is no longer open, for a REMOTE request too.
    await request(ctx.server)
      .post(`/service-requests/${live.requestId}/offers/${first.body.id}/action`)
      .set('Cookie', live.customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);
    const stale = await postOffer(late, live.requestId);
    expect([404, 409]).toContain(stale.status);
    expect(await ctx.prisma.offer.count({ where: { providerId: late.provider.id } })).toBe(0);
  });
});

// ── immutability ─────────────────────────────────────────────────────────────

describe('existing request snapshot', () => {
  it('changing the category model never moves an existing request; new requests follow the new model', async () => {
    const sa = await superAdmin();
    const category = await createCategory(ctx.prisma, 'Online', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.REMOTE });
    const far = await addProvider(category.id, [CANKAYA]);
    const before = (await liveRequest(sa, category.slug)).requestId;

    await request(ctx.server).patch(`/categories/${category.id}`).set('Cookie', sa).send({ deliveryModel: 'ON_SITE' }).expect(200);
    expect(await deliveryModeOf(before)).toBe('REMOTE');
    expect(await sees(far, before)).toBe(true);
    await postOffer(far, before).expect(201);

    const after = (await liveRequest(sa, category.slug)).requestId;
    expect(await deliveryModeOf(after)).toBe('ON_SITE');
    expect(await sees(far, after)).toBe(false);

    // And back: the ON_SITE request stays ON_SITE.
    await request(ctx.server).patch(`/categories/${category.id}`).set('Cookie', sa).send({ deliveryModel: 'REMOTE' }).expect(200);
    expect(await deliveryModeOf(after)).toBe('ON_SITE');
    expect(await sees(far, after)).toBe(false);

    // The admin detail shows both facts.
    const detail = await request(ctx.server).get(`/service-requests/${after}`).set('Cookie', sa).expect(200);
    expect(detail.body.deliveryMode).toBe('ON_SITE');
    expect(detail.body.category.deliveryModel).toBe('REMOTE');
  });
});

// ── provider profile ─────────────────────────────────────────────────────────

describe('provider service areas', () => {
  it('a provider whose every category is REMOTE may apply with no area; any ON_SITE or HYBRID category still needs one', async () => {
    const remote = await createCategory(ctx.prisma, 'Online', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.REMOTE });
    const onSite = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const hybrid = await createCategory(ctx.prisma, 'Hibrit', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.HYBRID });

    const remoteOnly = await request(ctx.server)
      .post('/providers')
      .send({ ...providerPayload([remote.id]), serviceAreas: [] })
      .expect(201);
    expect(remoteOnly.body.serviceAreas).toEqual([]);

    for (const categoryIds of [[onSite.id], [hybrid.id], [remote.id, onSite.id]]) {
      const refused = await request(ctx.server)
        .post('/providers')
        .send({ ...providerPayload(categoryIds), serviceAreas: [] })
        .expect(400);
      expect(refused.body.message).toMatch(/hizmet bölgesi/);
    }
    // Areas are still accepted (and kept) for a REMOTE-only provider.
    await request(ctx.server).post('/providers').send(providerPayload([remote.id])).expect(201);
  });
});

// ── vitrin ───────────────────────────────────────────────────────────────────

describe('direct showcase lead', () => {
  async function liveCard(model: CategoryDeliveryModel) {
    const category = await createCategory(ctx.prisma, 'Vitrin', { offerCreditCost: 2, deliveryModel: model });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const owner = await createDiscoverableProvider(ctx.prisma, { userId: ownerUser.id, categoryId: category.id, areas: [KADIKOY] });
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, { providerId: owner.id, categoryId: category.id });
    const pkg = await createShowcasePackage(ctx.prisma);
    await createLiveShowcasePlacement(ctx, { providerId: owner.id, cardId: card.id, versionId: version.id, packageId: pkg.id });
    const ownerParty: Party = { provider: owner, userId: ownerUser.id, cookie: await loginAs(ctx.prisma, ownerUser.id) };
    return { category, card, ownerParty };
  }

  async function sendLead(cardId: string, slug: string, overrides: Record<string, unknown>) {
    const payload = showcaseLeadPayload(slug, overrides);
    await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
    return await request(ctx.server).post(`/showcase/cards/${cardId}/leads`).send(payload);
  }

  it('an address off the shelf is refused for ON_SITE and accepted for REMOTE; the owner can answer the REMOTE lead', async () => {
    const onSite = await liveCard(CategoryDeliveryModel.ON_SITE);
    const refused = await sendLead(onSite.card.id, onSite.category.slug, { city: 'Ankara', district: 'Çankaya' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);

    const remote = await liveCard(CategoryDeliveryModel.REMOTE);
    expect((await sendLead(remote.card.id, remote.category.slug, { city: 'Ankara', district: 'Çankaya' })).status).toBe(201);
    const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({ where: { cardId: remote.card.id } });
    expect(await deliveryModeOf(lead.requestId)).toBe('REMOTE');
    // The owner answers their own (still SUBMITTED) lead from a Kadıköy-only profile.
    await postOffer(remote.ownerParty, lead.requestId).expect(201);
  });

  it('HYBRID: the customer’s ON_SITE choice is held to the shelf, the REMOTE choice is not; a missing choice is 400', async () => {
    const hybrid = await liveCard(CategoryDeliveryModel.HYBRID);
    const ankara = { city: 'Ankara', district: 'Çankaya' };
    expect((await sendLead(hybrid.card.id, hybrid.category.slug, ankara)).status).toBe(400);
    const onSite = await sendLead(hybrid.card.id, hybrid.category.slug, { ...ankara, deliveryMode: 'ON_SITE' });
    expect(onSite.status).toBeGreaterThanOrEqual(400);
    expect(onSite.status).toBeLessThan(500);
    expect((await sendLead(hybrid.card.id, hybrid.category.slug, { ...ankara, deliveryMode: 'REMOTE' })).status).toBe(201);
  });
});

// ── REL-002 ──────────────────────────────────────────────────────────────────

describe('REL-002 rounds on a REMOTE request', () => {
  it('R1 → R2 → R3 fail → MATCH_REVIEW → staff R4: the mode stays REMOTE, failed providers stay out country-wide, R4 reaches a far provider', async () => {
    const sa = await superAdmin();
    const category = await createCategory(ctx.prisma, 'Online', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.REMOTE });
    const live = await liveRequest(sa, category.slug);
    const a = await addProvider(category.id, [KADIKOY]);
    const b = await addProvider(category.id, [CANKAYA]);
    const c = await addProvider(category.id, []);
    const d = await addProvider(category.id, [{ city: 'İzmir', district: 'Konak' }]);

    await failRoundWith(live.requestId, live.customerCookie, a);
    expect(await deliveryModeOf(live.requestId)).toBe('REMOTE');
    expect(await sees(a, live.requestId)).toBe(false);
    expect(await sees(b, live.requestId)).toBe(true);

    await failRoundWith(live.requestId, live.customerCookie, b);
    expect(await deliveryModeOf(live.requestId)).toBe('REMOTE');
    await failRoundWith(live.requestId, live.customerCookie, c);

    const review = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: live.requestId },
      select: { status: true, currentRoundId: true, deliveryMode: true },
    });
    expect(review).toMatchObject({ status: ServiceRequestStatus.MATCH_REVIEW, deliveryMode: 'REMOTE' });

    await request(ctx.server)
      .post(`/admin/service-requests/${live.requestId}/open-next-round`)
      .set('Cookie', sa)
      .send({
        expectedCurrentRoundId: review.currentRoundId,
        note: 'Müşteriyle görüşüldü; talep yeniden yayınlanacak.',
        idempotencyKey: randomUUID(),
      })
      .expect(200);
    // Auto-publish is off: R4 waits for moderation, then publishes.
    await request(ctx.server)
      .patch(`/service-requests/${live.requestId}/status`)
      .set('Cookie', sa)
      .send({ status: ServiceRequestStatus.APPROVED })
      .expect(200);

    expect(await deliveryModeOf(live.requestId)).toBe('REMOTE');
    // The excluded three stay out wherever they serve; D, in a third province, is in.
    for (const failed of [a, b, c]) {
      expect(await sees(failed, live.requestId)).toBe(false);
      await postOffer(failed, live.requestId).expect(404);
    }
    expect(await sees(d, live.requestId)).toBe(true);
    const r4 = (await availableNotices(live.requestId)).filter((notice) => notice.dedupeKey?.endsWith(':r4'));
    expect(r4.map((notice) => notice.providerId)).toEqual([d.provider.id]);
    await postOffer(d, live.requestId).expect(201);
  });
});

// ── category status gates are unchanged ──────────────────────────────────────

describe('other category gates', () => {
  it('an INACTIVE REMOTE category refuses offers exactly as before', async () => {
    const sa = await superAdmin();
    const category = await createCategory(ctx.prisma, 'Online', { offerCreditCost: 2, deliveryModel: CategoryDeliveryModel.REMOTE });
    const far = await addProvider(category.id, [CANKAYA]);
    const live = await liveRequest(sa, category.slug);
    await ctx.prisma.serviceCategory.update({
      where: { id: category.id },
      data: { status: ServiceCategoryStatus.INACTIVE, isActive: false },
    });
    const refused = await postOffer(far, live.requestId).expect(409);
    expect(refused.body.code).toBe('CATEGORY_INACTIVE');
  });
});
