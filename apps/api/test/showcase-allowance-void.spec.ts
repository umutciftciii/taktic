import { randomUUID } from 'node:crypto';
import { AdminPermission, OfferAllowanceVoidReason, ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ServiceIssueOutbox } from '../src/modules/notifications/service-issue-outbox.service';
import {
  enqueueShowcaseAllowanceVoidedNotice,
  ShowcaseAllowanceVoidOutbox,
} from '../src/modules/notifications/showcase-allowance-void-outbox.service';
import { formatOfferAllowanceEvent } from '../src/modules/offer-allowances/offer-allowance-events';
import {
  createAdminWithPermissions,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  currentCreditBalance,
  grantCredits,
  loginAs,
  offerPayload,
  proveShowcaseLeadPhone,
  resetAuthThrottle,
  resetDatabase,
  showcaseLeadPayload,
  type TestContext,
} from './harness';
import { allowanceInconsistencies, reportInconsistencies } from './offer-allowance-consistency';
import { roundInconsistencies } from './match-round-consistency';

/**
 * SHOWCASE-ALLOWANCE-004 — a super admin voids what is left of a vitrin run's
 * free offers.
 *
 * Final (the DB trigger refuses any change to a VOID grant), whole (no partial
 * void), confirmed (the dialog's three figures are a compare-and-set), told to
 * the provider exactly once through the outbox (without the reason or the
 * note), and nothing else: no usage row, ledger row, purchase, entitlement,
 * placement or lead moves.
 */

const CATEGORY_COST = 2;
const NOTE = 'Sahte talep şüphesiyle iç inceleme kaydı.';

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
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48 },
    update: { marketplaceAutoPublishEnabled: false },
  });
});

afterEach(async () => {
  await ctx.app.get(ShowcaseAllowanceVoidOutbox).whenIdle();
  await ctx.app.get(ServiceIssueOutbox).whenIdle();
  expect(await roundInconsistencies(ctx.prisma)).toEqual([]);
  expect(await allowanceInconsistencies(ctx.prisma)).toEqual([]);
});

// ── builders ─────────────────────────────────────────────────────────────────

type Owner = { id: string; userId: string; cookie: string };

async function scenario(options: { credits?: number; freeOfferCount?: number } = {}) {
  const category = await createCategory(ctx.prisma, 'Klima', {
    kind: ServiceCategoryKind.LEAF,
    offerCreditCost: CATEGORY_COST,
  });
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  if (options.credits) {
    await grantCredits(ctx.prisma, profile.id, options.credits);
  }
  const owner: Owner = { id: profile.id, userId: ownerUser.id, cookie: await loginAs(ctx.prisma, ownerUser.id) };
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, { providerId: owner.id, categoryId: category.id });
  const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount: options.freeOfferCount ?? 3 });
  const { placement } = await createLiveShowcasePlacement(ctx, {
    providerId: owner.id,
    cardId: card.id,
    versionId: version.id,
    packageId: pkg.id,
  });
  return { category, owner, card, placement };
}

async function superAdmin() {
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { user, cookie: await loginAs(ctx.prisma, user.id) };
}

async function openLead(cardId: string, categorySlug: string) {
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const customerCookie = await loginAs(ctx.prisma, customer.id);
  const payload = showcaseLeadPayload(categorySlug);
  await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
  const created = await request(ctx.server)
    .post(`/showcase/cards/${cardId}/leads`)
    .set('Cookie', customerCookie)
    .send({ ...payload, useAlternateContact: true });
  expect(created.status).toBe(201);
  return ctx.prisma.showcaseLead.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
}

function offer(owner: Owner, requestId: string, body: Record<string, unknown>) {
  return request(ctx.server)
    .post(`/providers/${owner.id}/requests/${requestId}/offers`)
    .set('Cookie', owner.cookie)
    .send(body);
}

function preview(owner: Owner, requestId: string) {
  return request(ctx.server).get(`/providers/${owner.id}/requests/${requestId}/offer-cost`).set('Cookie', owner.cookie);
}

async function spendFree(owner: Owner, cardId: string, categorySlug: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    const lead = await openLead(cardId, categorySlug);
    const response = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 }));
    expect(response.status).toBe(201);
    expect(response.body.creditCost).toBe(0);
  }
}

async function grantOf(placementId: string) {
  return ctx.prisma.offerAllowanceGrant.findUniqueOrThrow({ where: { showcasePlacementId: placementId } });
}

/** What the confirmation dialog would show and post back, read from the admin projection. */
async function expectationsFor(cookie: string, placementId: string) {
  const detail = await request(ctx.server).get(`/admin/showcase/placements/${placementId}`).set('Cookie', cookie).expect(200);
  const allowance = detail.body.offerAllowance;
  return {
    expectedQuotaTotal: allowance.quotaTotal as number,
    expectedQuotaUsed: allowance.quotaUsed as number,
    expectedOpenLeads: allowance.openLeads as number,
  };
}

function voidCall(cookie: string, placementId: string, body: Record<string, unknown>) {
  return request(ctx.server)
    .post(`/admin/showcase/placements/${placementId}/allowance/void`)
    .set('Cookie', cookie)
    .send(body);
}

async function voidBody(cookie: string, placementId: string, overrides: Record<string, unknown> = {}) {
  return { reasonCode: 'FRAUD', note: NOTE, ...(await expectationsFor(cookie, placementId)), ...overrides };
}

/** Every row a void must leave alone, read whole. */
async function untouchable() {
  return {
    usages: await ctx.prisma.offerAllowanceUsage.findMany({ orderBy: { id: 'asc' } }),
    ledger: await ctx.prisma.providerCreditTransaction.findMany({ orderBy: { id: 'asc' } }),
    purchases: await ctx.prisma.packagePurchase.findMany({ orderBy: { id: 'asc' } }),
    entitlements: await ctx.prisma.showcaseEntitlement.findMany({ orderBy: { id: 'asc' } }),
    providerEntitlements: await ctx.prisma.providerPackageEntitlement.findMany({ orderBy: { id: 'asc' } }),
    placements: await ctx.prisma.showcasePlacement.findMany({ orderBy: { id: 'asc' } }),
    leads: await ctx.prisma.showcaseLead.findMany({ orderBy: { id: 'asc' } }),
    offers: await ctx.prisma.offer.findMany({ orderBy: { id: 'asc' } }),
  };
}

function voidData(actorId: string) {
  return { status: 'VOID' as const, voidedAt: new Date(), voidReason: 'OTHER' as const, voidNote: NOTE, voidedById: actorId };
}

// ── the database ─────────────────────────────────────────────────────────────

describe('the database makes VOID final and the grant immutable', () => {
  it('refuses identity, owner and quota changes on an ACTIVE grant, and any decrease of quotaUsed', async () => {
    const { placement, category } = await scenario();
    const grant = await grantOf(placement.id);
    const otherUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const other = await createDiscoverableProvider(ctx.prisma, { userId: otherUser.id, categoryId: category.id });

    for (const data of [{ quotaTotal: 5 }, { providerId: other.id }, { source: 'SHOWCASE_PLACEMENT' as const, showcasePlacementId: null }]) {
      await expect(ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data })).rejects.toThrow(
        /identity, owner and quota are immutable/,
      );
    }
    await ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data: { quotaUsed: 1 } });
    await expect(
      ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data: { quotaUsed: 0 } }),
    ).rejects.toThrow(/quotaUsed never decreases/);
    await expect(grantOf(placement.id)).resolves.toMatchObject({ quotaUsed: 1, quotaTotal: 3 });
    // Back to the fixture's shape, triggers off, so nothing else in the case depends on the probe.
    await ctx.prisma.$transaction([
      ctx.prisma.$executeRawUnsafe('SET LOCAL session_replication_role = replica'),
      ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data: { quotaUsed: 0 } }),
    ]);
  });

  it('refuses a grant born VOID', async () => {
    const { placement, owner } = await scenario({ freeOfferCount: 0 });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await expect(
      ctx.prisma.offerAllowanceGrant.create({
        data: {
          providerId: owner.id,
          source: 'SHOWCASE_PLACEMENT',
          benefit: 'FREE_OFFER',
          showcasePlacementId: placement.id,
          quotaTotal: 3,
          validFrom: placement.startAt,
          ...voidData(admin.id),
        },
      }),
    ).rejects.toThrow(/must be born ACTIVE/);
  });

  it('refuses a void by anyone but a SUPER_ADMIN, without a note, with a short note, or with nothing left', async () => {
    const { placement, owner, card, category } = await scenario();
    const grant = await grantOf(placement.id);
    const admin = await createUser(ctx.prisma, { role: UserRole.ADMIN });
    const root = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    await expect(
      ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data: voidData(admin.id) }),
    ).rejects.toThrow(/only be voided by a SUPER_ADMIN/);
    await expect(
      ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data: voidData(owner.userId) }),
    ).rejects.toThrow(/only be voided by a SUPER_ADMIN/);
    await expect(
      ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data: { ...voidData(root.id), voidNote: null } }),
    ).rejects.toThrow(/OfferAllowanceGrant_void_shape/);
    await expect(
      ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data: { ...voidData(root.id), voidNote: '   kısa   ' } }),
    ).rejects.toThrow(/OfferAllowanceGrant_void_note_length/);
    await expect(
      ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data: { ...voidData(root.id), quotaUsed: 1 } }),
    ).rejects.toThrow(/cannot claim a slot and be voided/);

    await spendFree(owner, card.id, category.slug, 3);
    await expect(
      ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data: voidData(root.id) }),
    ).rejects.toThrow(/nothing left to void/);
  });

  it('a VOID grant can never be changed again, back to ACTIVE or otherwise, and never deleted', async () => {
    const { placement } = await scenario();
    const grant = await grantOf(placement.id);
    const root = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data: voidData(root.id) });

    for (const data of [
      { status: 'ACTIVE' as const, voidedAt: null, voidReason: null, voidNote: null, voidedById: null },
      { voidNote: 'Başka bir açıklama yazıldı.' },
      { voidReason: 'FRAUD' as const },
      { quotaUsed: 1 },
      { validFrom: new Date() },
    ]) {
      await expect(ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data })).rejects.toThrow(
        /a voided grant is final/,
      );
    }
    await expect(ctx.prisma.offerAllowanceGrant.delete({ where: { id: grant.id } })).rejects.toThrow(
      /a voided grant is permanent/,
    );
    expect(await grantOf(placement.id)).toMatchObject({ status: 'VOID', voidReason: 'OTHER', voidNote: NOTE, quotaUsed: 0 });
  });
});

// ── who may ──────────────────────────────────────────────────────────────────

describe('who may void', () => {
  it('only a SUPER_ADMIN: anonymous 401, a provider 403, an ADMIN holding every vitrin permission 403', async () => {
    const { placement, owner } = await scenario();
    const body = { reasonCode: 'FRAUD', note: NOTE, expectedQuotaTotal: 3, expectedQuotaUsed: 0, expectedOpenLeads: 0 };

    await request(ctx.server).post(`/admin/showcase/placements/${placement.id}/allowance/void`).send(body).expect(401);
    expect((await voidCall(owner.cookie, placement.id, body)).status).toBe(403);

    const { admin } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.SHOWCASE_PLACEMENTS_READ,
      AdminPermission.SHOWCASE_PLACEMENTS_MODERATE,
      AdminPermission.SHOWCASE_PLACEMENT_CANCEL,
      AdminPermission.OFFERS_READ,
    ]);
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    const refused = await voidCall(adminCookie, placement.id, body);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('INSUFFICIENT_PERMISSION');
    expect((await grantOf(placement.id)).status).toBe('ACTIVE');
  });

  it('a role row that smuggles the permission in still grants nothing, and the role editor refuses it', async () => {
    const { placement } = await scenario();
    const { admin } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.SHOWCASE_ALLOWANCE_VOID,
      AdminPermission.SHOWCASE_PLACEMENTS_READ,
    ]);
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    const body = { reasonCode: 'FRAUD', note: NOTE, expectedQuotaTotal: 3, expectedQuotaUsed: 0, expectedOpenLeads: 0 };
    expect((await voidCall(adminCookie, placement.id, body)).status).toBe(403);

    const root = await superAdmin();
    const catalogue = await request(ctx.server).get('/admin/permissions').set('Cookie', root.cookie).expect(200);
    expect(catalogue.body.permissions).not.toContain('SHOWCASE_ALLOWANCE_VOID');
    expect(catalogue.body.reservedForSuperAdmin).toContain('SHOWCASE_ALLOWANCE_VOID');
    const created = await request(ctx.server)
      .post('/admin/roles')
      .set('Cookie', root.cookie)
      .send({ key: `voiders-${randomUUID().slice(0, 6)}`, name: 'İptal edenler', permissions: ['SHOWCASE_ALLOWANCE_VOID'] });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe('PERMISSION_RESERVED_FOR_SUPER_ADMIN');
  });
});

// ── what the request must carry ───────────────────────────────────────────────

describe('the request', () => {
  it('needs a known reason code, a real note and all three expectations', async () => {
    const { placement } = await scenario();
    const root = await superAdmin();
    const good = await voidBody(root.cookie, placement.id);

    expect((await voidCall(root.cookie, placement.id, { ...good, reasonCode: undefined })).status).toBe(400);
    expect((await voidCall(root.cookie, placement.id, { ...good, reasonCode: 'SUSPICION' })).status).toBe(400);
    expect((await voidCall(root.cookie, placement.id, { ...good, expectedOpenLeads: undefined })).status).toBe(400);
    expect((await voidCall(root.cookie, placement.id, { ...good, note: 'x'.repeat(1001) })).status).toBe(400);
    const short = await voidCall(root.cookie, placement.id, { ...good, note: '   kısa    ' });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe('OFFER_ALLOWANCE_VOID_NOTE_REQUIRED');

    expect((await grantOf(placement.id)).status).toBe('ACTIVE');
    expect(await ctx.prisma.notificationLog.count({ where: { template: 'showcase-allowance-voided' } })).toBe(0);
  });

  it('answers each impossible void with its own code, and writes nothing', async () => {
    const root = await superAdmin();
    const missing = await voidCall(root.cookie, 'no-such-placement', {
      reasonCode: 'FRAUD',
      note: NOTE,
      expectedQuotaTotal: 3,
      expectedQuotaUsed: 0,
      expectedOpenLeads: 0,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('SHOWCASE_PLACEMENT_NOT_FOUND');

    const zero = await scenario({ freeOfferCount: 0 });
    expect(await ctx.prisma.offerAllowanceGrant.count({ where: { showcasePlacementId: zero.placement.id } })).toBe(0);
    const zeroRefusal = await voidCall(root.cookie, zero.placement.id, {
      reasonCode: 'FRAUD',
      note: NOTE,
      expectedQuotaTotal: 1,
      expectedQuotaUsed: 0,
      expectedOpenLeads: 0,
    });
    expect(zeroRefusal.status).toBe(409);
    expect(zeroRefusal.body.code).toBe('OFFER_ALLOWANCE_ZERO_PACKAGE');

    // A run that ended before allowances existed: sold with free offers, no grant row.
    const legacy = await scenario();
    await ctx.prisma.offerAllowanceGrant.delete({ where: { showcasePlacementId: legacy.placement.id } });
    await ctx.prisma.showcasePlacement.update({
      where: { id: legacy.placement.id },
      data: { status: 'EXPIRED', startAt: new Date(Date.now() - 120_000), endAt: new Date(Date.now() - 60_000) },
    });
    await ctx.prisma.showcasePlacementShelf.updateMany({ where: { placementId: legacy.placement.id }, data: { active: false } });
    const legacyRefusal = await voidCall(root.cookie, legacy.placement.id, {
      reasonCode: 'FRAUD',
      note: NOTE,
      expectedQuotaTotal: 3,
      expectedQuotaUsed: 0,
      expectedOpenLeads: 0,
    });
    expect(legacyRefusal.status).toBe(409);
    expect(legacyRefusal.body.code).toBe('OFFER_ALLOWANCE_NOT_FOUND');

    const spent = await scenario();
    await spendFree(spent.owner, spent.card.id, spent.category.slug, 3);
    const spentRefusal = await voidCall(root.cookie, spent.placement.id, await voidBody(root.cookie, spent.placement.id));
    expect(spentRefusal.status).toBe(409);
    expect(spentRefusal.body.code).toBe('OFFER_ALLOWANCE_NOTHING_TO_VOID');
    expect((await grantOf(spent.placement.id)).status).toBe('ACTIVE');

    expect(await ctx.prisma.notificationLog.count({ where: { template: 'showcase-allowance-voided' } })).toBe(0);
  });

  it('refuses when what the dialog showed moved — a slot spent or a lead arrived — and reports the current figures', async () => {
    const { placement, owner, card, category } = await scenario({ credits: 10 });
    const root = await superAdmin();
    const shown = await voidBody(root.cookie, placement.id);
    expect(shown).toMatchObject({ expectedQuotaTotal: 3, expectedQuotaUsed: 0, expectedOpenLeads: 0 });

    await openLead(card.id, category.slug);
    const leadArrived = await voidCall(root.cookie, placement.id, shown);
    expect(leadArrived.status).toBe(409);
    expect(leadArrived.body).toMatchObject({
      code: 'OFFER_ALLOWANCE_CHANGED',
      current: { quotaTotal: 3, quotaUsed: 0, openLeads: 1 },
    });

    await spendFree(owner, card.id, category.slug, 1);
    const slotSpent = await voidCall(root.cookie, placement.id, { ...shown, expectedOpenLeads: 1 });
    expect(slotSpent.status).toBe(409);
    expect(slotSpent.body).toMatchObject({ code: 'OFFER_ALLOWANCE_CHANGED', current: { quotaUsed: 1, openLeads: 1 } });

    expect((await grantOf(placement.id)).status).toBe('ACTIVE');
  });
});

// ── the void ─────────────────────────────────────────────────────────────────

describe('a void', () => {
  it('voids the whole remainder and touches nothing else: usages, ledger, purchase, entitlements, run, leads, offers', async () => {
    const { placement, owner, card, category } = await scenario({ credits: 10 });
    await spendFree(owner, card.id, category.slug, 1);
    const waiting = await openLead(card.id, category.slug);
    const root = await superAdmin();
    const before = await untouchable();
    const balanceBefore = await currentCreditBalance(ctx.prisma, owner.id);

    const body = await voidBody(root.cookie, placement.id, { reasonCode: 'TERMS_VIOLATION' });
    expect(body).toMatchObject({ expectedQuotaTotal: 3, expectedQuotaUsed: 1, expectedOpenLeads: 1 });
    const response = await voidCall(root.cookie, placement.id, body).expect(200);

    expect(response.body.offerAllowance).toMatchObject({
      status: 'VOID',
      quotaTotal: 3,
      quotaUsed: 1,
      remaining: 2,
      voidedRemaining: 2,
      voidReason: 'TERMS_VIOLATION',
      voidNote: NOTE,
      voidedBy: { id: root.user.id },
      openLeads: 1,
    });
    expect(response.body.offerAllowance.voidedAt).toEqual(expect.any(String));
    expect(response.body.status).toBe('ACTIVE');

    const grant = await grantOf(placement.id);
    expect(grant).toMatchObject({ status: 'VOID', quotaTotal: 3, quotaUsed: 1, voidedById: root.user.id });

    expect(await untouchable()).toEqual(before);
    expect(await currentCreditBalance(ctx.prisma, owner.id)).toBe(balanceBefore);
    expect((await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe('OPEN');
  });

  it('is told to the provider exactly once, through the outbox, without the reason, the note or the operator', async () => {
    const { placement, owner } = await scenario();
    const root = await superAdmin();
    await voidCall(root.cookie, placement.id, await voidBody(root.cookie, placement.id)).expect(200);
    await ctx.app.get(ShowcaseAllowanceVoidOutbox).whenIdle();

    const rows = await ctx.prisma.notificationLog.findMany({ where: { template: 'showcase-allowance-voided' } });
    const grant = await grantOf(placement.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'SENT',
      dedupeKey: `showcase-allowance-voided:${grant.id}`,
      providerId: owner.id,
      attemptCount: 1,
    });

    const mails = ctx.notifications.ofTemplate('showcase-allowance-voided');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.data).toMatchObject({ voidedCount: '3' });
    const serialised = JSON.stringify(mails[0]);
    for (const secret of [NOTE, 'FRAUD', root.user.id, root.user.email ?? '@@none@@']) {
      expect(serialised).not.toContain(secret);
    }

    // Idempotent: a second enqueue of the same void and a second sweep send nothing more.
    expect(await enqueueShowcaseAllowanceVoidedNotice(ctx.prisma, grant.id)).toBe(0);
    await ctx.app.get(ShowcaseAllowanceVoidOutbox).deliverPending();
    expect(await ctx.prisma.notificationLog.count({ where: { template: 'showcase-allowance-voided' } })).toBe(1);
    expect(ctx.notifications.ofTemplate('showcase-allowance-voided')).toHaveLength(1);
  });

  it('a notice that was not sent before the process stopped is delivered by the next sweep', async () => {
    const { placement } = await scenario();
    const root = await superAdmin();
    const grant = await grantOf(placement.id);
    // The void's transaction, without the post-commit send.
    await ctx.prisma.$transaction(async (tx) => {
      await tx.offerAllowanceGrant.update({ where: { id: grant.id }, data: { ...voidData(root.user.id), voidReason: 'FRAUD' } });
      expect(await enqueueShowcaseAllowanceVoidedNotice(tx, grant.id)).toBe(1);
    });
    expect(ctx.notifications.ofTemplate('showcase-allowance-voided')).toHaveLength(0);

    const result = await ctx.app.get(ShowcaseAllowanceVoidOutbox).deliverPending();
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(ctx.notifications.ofTemplate('showcase-allowance-voided')).toHaveLength(1);
  });

  it('a second void is 409 ALREADY_VOID and changes nothing; two at once leave exactly one void and one notice', async () => {
    const { placement } = await scenario();
    const root = await superAdmin();
    const other = await superAdmin();
    const body = await voidBody(root.cookie, placement.id);

    const [first, second] = await Promise.all([
      voidCall(root.cookie, placement.id, body),
      voidCall(other.cookie, placement.id, { ...body, reasonCode: 'ABUSE' }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(['OFFER_ALLOWANCE_ALREADY_VOID', 'CONCURRENT_MODIFICATION']).toContain(loser.body.code);

    const replay = await voidCall(root.cookie, placement.id, body);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('OFFER_ALLOWANCE_ALREADY_VOID');

    await ctx.app.get(ShowcaseAllowanceVoidOutbox).whenIdle();
    expect(await ctx.prisma.notificationLog.count({ where: { template: 'showcase-allowance-voided' } })).toBe(1);
    expect(ctx.notifications.ofTemplate('showcase-allowance-voided')).toHaveLength(1);
  });

  it('logs one offer_allowance_voided event line of ids and figures only', () => {
    expect(
      formatOfferAllowanceEvent('offer_allowance_voided', { grantId: 'g1', placementId: 'p1', voidedCount: 2, reasonCode: 'FRAUD' }),
    ).toBe('offer_allowance_event event=offer_allowance_voided grantId=g1 placementId=p1 voidedCount=2 reasonCode=FRAUD');
  });
});

// ── after a void ─────────────────────────────────────────────────────────────

describe('after a void, the offer path', () => {
  it('previews the category price, refuses the old free expectation with 409 and charges nothing silently', async () => {
    const { placement, owner, card, category } = await scenario({ credits: 10 });
    const lead = await openLead(card.id, category.slug);
    const root = await superAdmin();
    await voidCall(root.cookie, placement.id, await voidBody(root.cookie, placement.id)).expect(200);

    const shown = await preview(owner, lead.requestId).expect(200);
    expect(shown.body).toMatchObject({
      kind: 'CREDITS',
      creditCost: CATEGORY_COST,
      allowance: null,
      allowanceVoided: true,
    });

    const stale = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 }));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'CREDIT_COST_CHANGED',
      expectedCreditCost: 0,
      actualCreditCost: CATEGORY_COST,
      allowanceVoided: true,
    });
    expect(stale.body.message).toMatch(/iptal edildi/);
    expect(await currentCreditBalance(ctx.prisma, owner.id)).toBe(10);
    expect(await ctx.prisma.offer.count()).toBe(0);

    // The open lead is still the provider's, answered at the category price on an explicit retry.
    const paid = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);
    expect(paid.body.creditCost).toBe(CATEGORY_COST);
    expect(await currentCreditBalance(ctx.prisma, owner.id)).toBe(10 - CATEGORY_COST);
    expect((await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('ANSWERED');
    expect(await ctx.prisma.offerAllowanceUsage.count()).toBe(0);
    expect((await grantOf(placement.id)).quotaUsed).toBe(0);
  });

  it('without credits, a stale free expectation is the 409 first, not the 402', async () => {
    const { placement, owner, card, category } = await scenario();
    const lead = await openLead(card.id, category.slug);
    const root = await superAdmin();
    await voidCall(root.cookie, placement.id, await voidBody(root.cookie, placement.id)).expect(200);

    const stale = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 }));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'CREDIT_COST_CHANGED', allowanceVoided: true });
    expect((await preview(owner, lead.requestId).expect(200)).body).toMatchObject({
      kind: 'INSUFFICIENT_CREDITS',
      allowanceVoided: true,
    });
  });

  it('a void racing an offer for the same slot: never both, never a silent charge, nothing double-counted', async () => {
    const { placement, owner, card, category } = await scenario({ credits: 10 });
    const root = await superAdmin();
    const lead = await openLead(card.id, category.slug);
    const body = await voidBody(root.cookie, placement.id);

    const [voided, answered] = await Promise.all([
      voidCall(root.cookie, placement.id, body),
      offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 })),
    ]);

    expect([200, 409]).toContain(voided.status);
    expect([201, 409]).toContain(answered.status);
    expect(voided.status === 200 && answered.status === 201).toBe(false);
    expect(await currentCreditBalance(ctx.prisma, owner.id)).toBe(10);

    const grant = await grantOf(placement.id);
    const usages = await ctx.prisma.offerAllowanceUsage.count();
    if (voided.status === 200) {
      expect(grant).toMatchObject({ status: 'VOID', quotaUsed: 0 });
      expect(usages).toBe(0);
      expect(answered.body.code).toBe('CREDIT_COST_CHANGED');
    } else {
      expect(['OFFER_ALLOWANCE_CHANGED', 'CONCURRENT_MODIFICATION']).toContain(voided.body.code);
      expect(grant).toMatchObject({ status: 'ACTIVE', quotaUsed: 1 });
      expect(usages).toBe(1);
    }
  });
});

// ── what each screen reads ───────────────────────────────────────────────────

describe('the screens', () => {
  it('the provider sees VOID with nothing left, and never the reason, the note or who did it', async () => {
    const { placement, owner } = await scenario();
    const root = await superAdmin();
    await voidCall(root.cookie, placement.id, await voidBody(root.cookie, placement.id)).expect(200);

    const publication = await request(ctx.server)
      .get(`/providers/${owner.id}/showcase/publication`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(publication.body.cards[0].freeOffers).toEqual({ total: 3, used: 0, remaining: 0, status: 'VOID' });

    const run = await request(ctx.server)
      .get(`/providers/${owner.id}/showcase/placements/${placement.id}`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(run.body.freeOffers).toEqual({ total: 3, used: 0, remaining: 0, status: 'VOID' });

    const serialised = JSON.stringify([publication.body, run.body]);
    for (const secret of [NOTE, 'FRAUD', 'voidNote', 'voidReason', 'voidedBy', root.user.id]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('an operator who may only read sees the void and the open leads, but not who did it beyond a name', async () => {
    const { placement, card, category } = await scenario();
    await openLead(card.id, category.slug);
    const root = await superAdmin();
    await voidCall(root.cookie, placement.id, await voidBody(root.cookie, placement.id)).expect(200);

    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.SHOWCASE_PLACEMENTS_READ]);
    const reader = await loginAs(ctx.prisma, admin.id);
    const detail = await request(ctx.server).get(`/admin/showcase/placements/${placement.id}`).set('Cookie', reader).expect(200);
    expect(detail.body.offerAllowance).toMatchObject({ status: 'VOID', openLeads: 1, voidedRemaining: 3, voidReason: 'FRAUD' });
    expect(Object.keys(detail.body.offerAllowance.voidedBy).sort()).toEqual(['id', 'name']);
    expect(detail.body.offerAllowance).not.toHaveProperty('usages');
  });

  it('the finance report shows the voided remainder apart, inside the unchanged sum', async () => {
    const { placement, owner, card, category } = await scenario();
    await spendFree(owner, card.id, category.slug, 1);
    const root = await superAdmin();
    await voidCall(root.cookie, placement.id, await voidBody(root.cookie, placement.id)).expect(200);

    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.FINANCE_READ]);
    const finance = await loginAs(ctx.prisma, admin.id);
    const report = await request(ctx.server).get('/finance/offer-allowances').set('Cookie', finance).expect(200);
    const cohort = report.body.cohort;
    expect(cohort).toMatchObject({
      grants: 1,
      defined: 3,
      usedTracked: 1,
      usedLegacy: 0,
      remainingUsable: 0,
      remainingUnusable: 2,
      remainingVoided: 2,
    });
    expect(cohort.usedTracked + cohort.usedLegacy + cohort.remainingUsable + cohort.remainingUnusable).toBe(cohort.defined);
    expect(report.body.integrity.voidGrants).toBe(1);
    expect(report.body.usage).toMatchObject({ usages: 1, credits: CATEGORY_COST });
    expect(report.body.byPackage[0].cohort.remainingVoided).toBe(2);
    expect(await reportInconsistencies(ctx.prisma)).toEqual([]);
  });
});

// ── nothing else voids ───────────────────────────────────────────────────────

describe('nothing else voids a grant', () => {
  it('cancelling the run leaves its grant ACTIVE and its open leads on their free answer', async () => {
    const { placement, owner, card, category } = await scenario();
    const lead = await openLead(card.id, category.slug);
    const { admin } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.SHOWCASE_PLACEMENTS_READ,
      AdminPermission.SHOWCASE_PLACEMENT_CANCEL,
    ]);
    const operator = await loginAs(ctx.prisma, admin.id);
    await request(ctx.server)
      .post(`/admin/showcase/placements/${placement.id}/cancel`)
      .set('Cookie', operator)
      .send({ note: 'Kart kurallara aykırı bulundu.' })
      .expect(200);

    expect(await grantOf(placement.id)).toMatchObject({ status: 'ACTIVE', voidedAt: null });
    expect((await preview(owner, lead.requestId).expect(200)).body).toMatchObject({
      kind: 'SHOWCASE_ALLOWANCE',
      allowanceVoided: false,
    });
    expect(await ctx.prisma.notificationLog.count({ where: { template: 'showcase-allowance-voided' } })).toBe(0);
  });

  it('no source outside the void service writes VOID', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative, resolve } = await import('node:path');
    const root = resolve(__dirname, '../src');
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (path.endsWith('.ts') && /status:\s*OfferAllowanceStatus\.VOID,\s*\n\s*voidedAt/.test(readFileSync(path, 'utf8'))) {
          writers.push(relative(root, path));
        }
      }
    };
    walk(root);
    expect(writers).toEqual(['modules/showcase/showcase-allowance-void.service.ts']);
  });
});

// The DTO validates against Prisma's enum, which is the column's type: the API
// can never accept a code the column refuses.
it('the void reason codes are the five the column accepts', () => {
  expect(Object.values(OfferAllowanceVoidReason).sort()).toEqual(['ABUSE', 'FRAUD', 'OPERATOR_ERROR', 'OTHER', 'TERMS_VIOLATION']);
});
