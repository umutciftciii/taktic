import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdminPermission, ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ShowcaseEntitlementService } from '../src/modules/showcase/showcase-entitlement.service';
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
import { allowanceInconsistencies } from './offer-allowance-consistency';

/**
 * SHOWCASE-ALLOWANCE-003 — a vitrin package may carry no free offer at all
 * (`freeOfferCount = 0`).
 *
 * The 0 travels the same snapshot chain as any other count (package →
 * purchase → right / run). A run sold with 0 is born **without** an
 * OfferAllowanceGrant — a grant's quota stays positive by CHECK — and every
 * offer on its leads goes through the normal resolver to the credit price.
 * Rows sold before a package was set to 0 keep exactly what they were sold.
 */

const CATEGORY_COST = 2;

const SNAPSHOT_CONSISTENCY_SQL = readFileSync(
  resolve(__dirname, '../../../scripts/ops/showcase-allowance-001-consistency.sql'),
  'utf8',
);

const MIGRATION = resolve(
  __dirname,
  '../../../prisma/migrations/20261017090000_allow_zero_showcase_free_offer_count/migration.sql',
);

const MOCK_CARD = {
  cardholderName: 'Ayşe',
  cardNumber: '4111111111111111',
  expiryMonth: 12,
  expiryYear: 2030,
  cvv: '123',
};

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
  // Both operator checks stay silent on a zero run: it has no grant, and that
  // is the state it was sold in, not a missing row.
  expect(await ctx.prisma.$queryRawUnsafe(SNAPSHOT_CONSISTENCY_SQL)).toEqual([]);
  expect(await allowanceInconsistencies(ctx.prisma)).toEqual([]);
});

// ── builders ─────────────────────────────────────────────────────────────────

async function provider(credits = 0) {
  const category = await createCategory(ctx.prisma, 'Klima', {
    kind: ServiceCategoryKind.LEAF,
    offerCreditCost: CATEGORY_COST,
  });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  if (credits) await grantCredits(ctx.prisma, profile.id, credits);
  return { category, user, profile, cookie: await loginAs(ctx.prisma, user.id) };
}

async function operator(permissions: AdminPermission[] = []) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, [
    AdminPermission.SHOWCASE_PACKAGES_READ,
    AdminPermission.SHOWCASE_PACKAGES_WRITE,
    ...permissions,
  ]);
  return loginAs(ctx.prisma, admin.id);
}

function checkout(providerId: string, cookie: string, body: Record<string, unknown>) {
  return request(ctx.server)
    .post(`/providers/${providerId}/showcase/packages/checkout`)
    .set('Cookie', cookie)
    .send({ priceTermsAccepted: true, priceTermsVersion: 'v1', ...body });
}

function mockPay(providerId: string, cookie: string, purchaseId: string) {
  return request(ctx.server)
    .post(`/providers/${providerId}/package-purchases/${purchaseId}/mock-pay`)
    .set('Cookie', cookie)
    .send(MOCK_CARD);
}

/** Reserves the provider's right for an approved card and spends it: the run is born. */
async function publishWithRight(input: { providerId: string; categoryId: string }) {
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
    providerId: input.providerId,
    categoryId: input.categoryId,
  });
  const service = ctx.app.get(ShowcaseEntitlementService);
  const now = new Date();
  const born = await ctx.prisma.$transaction(async (tx) => {
    await service.reserveForCard(tx, {
      providerId: input.providerId,
      cardId: card.id,
      kind: 'SERVICE',
      entitlementId: null,
      now,
    });
    return service.consumeForCard(tx, {
      cardId: card.id,
      versionId: version.id,
      providerId: input.providerId,
      categoryId: input.categoryId,
      kind: 'SERVICE',
      now,
    });
  });
  return { card, ...born };
}

/** A card-bound run sold with `freeOfferCount`, through the real settlement birth. */
async function runOf(freeOfferCount: number, credits = 0) {
  const p = await provider(credits);
  const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount });
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, { providerId: p.profile.id, categoryId: p.category.id });
  const { purchase, placement } = await createLiveShowcasePlacement(ctx, {
    providerId: p.profile.id,
    cardId: card.id,
    versionId: version.id,
    packageId: pkg.id,
  });
  return { ...p, pkg, card, purchase, placement };
}

async function openLead(cardId: string, categorySlug: string) {
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const customerCookie = await loginAs(ctx.prisma, customer.id);
  const payload = showcaseLeadPayload(categorySlug);
  await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
  await request(ctx.server)
    .post(`/showcase/cards/${cardId}/leads`)
    .set('Cookie', customerCookie)
    .send({ ...payload, useAlternateContact: true })
    .expect(201);
  return ctx.prisma.showcaseLead.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
}

function offer(providerId: string, cookie: string, requestId: string, body: Record<string, unknown>) {
  return request(ctx.server)
    .post(`/providers/${providerId}/requests/${requestId}/offers`)
    .set('Cookie', cookie)
    .send(body);
}

function offerCost(providerId: string, cookie: string, requestId: string) {
  return request(ctx.server)
    .get(`/providers/${providerId}/requests/${requestId}/offer-cost`)
    .set('Cookie', cookie)
    .expect(200);
}

// ── the setting ──────────────────────────────────────────────────────────────

describe('a package with no free offer', () => {
  it('is accepted on create and edit, the default stays 3, and the audit trail records the change to 0', async () => {
    const cookie = await operator();
    const base = { priceAmount: 49_900, durationDays: 30 };

    const defaulted = await request(ctx.server)
      .post('/admin/showcase/packages')
      .set('Cookie', cookie)
      .send({ ...base, name: 'Vitrin Varsayılan', slug: 'vitrin-varsayilan' })
      .expect(201);
    expect(defaulted.body.freeOfferCount).toBe(3);

    const zero = await request(ctx.server)
      .post('/admin/showcase/packages')
      .set('Cookie', cookie)
      .send({ ...base, name: 'Vitrin Sıfır', slug: 'vitrin-sifir', freeOfferCount: 0 })
      .expect(201);
    expect(zero.body.freeOfferCount).toBe(0);

    await request(ctx.server)
      .patch(`/admin/showcase/packages/${defaulted.body.id}`)
      .set('Cookie', cookie)
      .send({ freeOfferCount: 0 })
      .expect(200);
    const history = await request(ctx.server)
      .get(`/admin/showcase/packages/${defaulted.body.id}/history`)
      .set('Cookie', cookie)
      .expect(200);
    expect(history.body.items[0].changes).toEqual([{ field: 'freeOfferCount', from: 3, to: 0 }]);

    // An edit that names other fields leaves a 0 as it is.
    const renamed = await request(ctx.server)
      .patch(`/admin/showcase/packages/${zero.body.id}`)
      .set('Cookie', cookie)
      .send({ name: 'Vitrin Sıfır Yeni' })
      .expect(200);
    expect(renamed.body.freeOfferCount).toBe(0);
  });

  it('the database accepts 0 along the snapshot chain and still refuses a negative count', async () => {
    const { purchase, placement } = await runOf(0);
    expect(purchase.freeOfferCountSnapshot).toBe(0);
    expect(placement.freeOfferCountSnapshot).toBe(0);

    await expect(
      ctx.prisma.packagePurchase.update({ where: { id: purchase.id }, data: { freeOfferCountSnapshot: -1 } }),
    ).rejects.toThrow(/PackagePurchase_free_offer_count_snapshot_shape/);
    await expect(
      ctx.prisma.showcasePlacement.update({ where: { id: placement.id }, data: { freeOfferCountSnapshot: -1 } }),
    ).rejects.toThrow(/ShowcasePlacement_free_offer_count_snapshot_non_negative/);
  });

  it('the migration only widens constraints: it writes no row and keeps the grant’s positive quota CHECK', async () => {
    const sql = readFileSync(MIGRATION, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
    expect(sql).not.toMatch(/OfferAllowanceGrant/);

    const constraints = await ctx.prisma.$queryRaw<{ conname: string; def: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conname IN (
         'ShowcasePackage_free_offer_count_range',
         'ShowcaseEntitlement_free_offer_count_snapshot_non_negative',
         'ShowcasePlacement_free_offer_count_snapshot_non_negative',
         'ShowcaseEntitlement_free_offer_count_snapshot_positive',
         'ShowcasePlacement_free_offer_count_snapshot_positive',
         'OfferAllowanceGrant_quota_total_positive'
       )
       ORDER BY conname`;
    expect(constraints.map((row) => row.conname)).toEqual([
      'OfferAllowanceGrant_quota_total_positive',
      'ShowcaseEntitlement_free_offer_count_snapshot_non_negative',
      'ShowcasePackage_free_offer_count_range',
      'ShowcasePlacement_free_offer_count_snapshot_non_negative',
    ]);
    expect(constraints.find((row) => row.conname === 'OfferAllowanceGrant_quota_total_positive')?.def).toMatch(/> 0/);
  });
});

// ── the sale ─────────────────────────────────────────────────────────────────

describe('selling a zero package', () => {
  it('checkout → right → run carry 0, the run is born without a grant, and every screen says so', async () => {
    const { category, profile, cookie } = await provider();
    const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount: 0 });

    const opened = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, expectedFreeOfferCount: 0 }).expect(201);
    const purchaseId = opened.body.purchase.id as string;
    expect(opened.body.purchase.freeOfferCountSnapshot).toBe(0);

    // Raised after the checkout: the sale promised 0 and keeps it.
    await ctx.prisma.showcasePackage.update({ where: { id: pkg.id }, data: { freeOfferCount: 5 } });
    await mockPay(profile.id, cookie, purchaseId).expect(201);
    expect((await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { purchaseId } })).freeOfferCountSnapshot).toBe(0);

    const { placementId, quotaTotal } = await publishWithRight({ providerId: profile.id, categoryId: category.id });
    expect(quotaTotal).toBe(0);
    expect((await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placementId } })).freeOfferCountSnapshot).toBe(0);
    expect(await ctx.prisma.offerAllowanceGrant.count()).toBe(0);

    const run = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/placements/${placementId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(run.body).toMatchObject({ freeOfferCount: 0, freeOffers: null });

    const publication = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/publication`)
      .set('Cookie', cookie)
      .expect(200);
    expect(publication.body.cards[0]).toMatchObject({ freeOffers: null, liveFreeOfferCount: 0 });

    const admin = await operator([AdminPermission.SHOWCASE_PLACEMENTS_READ]);
    const adminRun = await request(ctx.server)
      .get(`/admin/showcase/placements/${placementId}`)
      .set('Cookie', admin)
      .expect(200);
    expect(adminRun.body).toMatchObject({ freeOfferCount: 0, offerAllowance: null });
  });

  it('a card-bound sale of a zero package is born without a grant too', async () => {
    const { placement } = await runOf(0);
    expect(await ctx.prisma.offerAllowanceGrant.count({ where: { showcasePlacementId: placement.id } })).toBe(0);
  });

  it('a stale screen across 0 is refused both ways; an older client that sends nothing still buys 0', async () => {
    const { profile, cookie } = await provider();
    const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount: 0 });

    const promisedThree = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, expectedFreeOfferCount: 3 });
    expect(promisedThree.status).toBe(409);
    expect(promisedThree.body).toMatchObject({
      code: 'SHOWCASE_PACKAGE_FREE_OFFERS_CHANGED',
      expectedFreeOfferCount: 3,
      actualFreeOfferCount: 0,
    });

    const other = await createShowcasePackage(ctx.prisma, { freeOfferCount: 3 });
    const promisedZero = await checkout(profile.id, cookie, { showcasePackageId: other.id, expectedFreeOfferCount: 0 });
    expect(promisedZero.status).toBe(409);
    expect(promisedZero.body).toMatchObject({ expectedFreeOfferCount: 0, actualFreeOfferCount: 3 });
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);

    const legacyClient = await checkout(profile.id, cookie, { showcasePackageId: pkg.id }).expect(201);
    expect(legacyClient.body.purchase.freeOfferCountSnapshot).toBe(0);
  });
});

// ── idempotency ──────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('a pending zero checkout is reused, and is not continued once the package carries offers again', async () => {
    const { profile, cookie } = await provider();
    const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount: 0 });

    const first = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, expectedFreeOfferCount: 0 }).expect(201);
    const again = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, expectedFreeOfferCount: 0 }).expect(201);
    expect(again.body.purchase.id).toBe(first.body.purchase.id);
    expect(again.body.checkout.reused).toBe(true);

    await ctx.prisma.showcasePackage.update({ where: { id: pkg.id }, data: { freeOfferCount: 3 } });
    const fresh = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, expectedFreeOfferCount: 3 }).expect(201);
    expect(fresh.body.checkout.reused).toBe(false);
    expect(fresh.body.purchase.freeOfferCountSnapshot).toBe(3);
    expect(
      (await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: first.body.purchase.id } })).freeOfferCountSnapshot,
    ).toBe(0);
  });

  it('a redelivered settlement of a zero sale grants one right and no grant', async () => {
    const { category, profile, cookie } = await provider();
    const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount: 0 });
    const opened = await checkout(profile.id, cookie, { showcasePackageId: pkg.id }).expect(201);
    await mockPay(profile.id, cookie, opened.body.purchase.id).expect(201);
    await mockPay(profile.id, cookie, opened.body.purchase.id).expect(409);
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(1);

    await publishWithRight({ providerId: profile.id, categoryId: category.id });
    expect(await ctx.prisma.showcasePlacement.count()).toBe(1);
    expect(await ctx.prisma.offerAllowanceGrant.count()).toBe(0);
  });

  it('an offer replayed on a zero run is refused as a duplicate and charged once', async () => {
    const { category, profile, card, cookie } = await runOf(0, 10);
    const lead = await openLead(card.id, category.slug);
    await offer(profile.id, cookie, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);
    const replay = await offer(profile.id, cookie, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST }));
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(await ctx.prisma.offer.count({ where: { requestId: lead.requestId } })).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, profile.id)).toBe(10 - CATEGORY_COST);
  });
});

// ── credit consumption ───────────────────────────────────────────────────────

describe('answering leads of a zero run', () => {
  it('previews and charges the normal credit price; a promised free answer is refused', async () => {
    const { category, profile, card, cookie } = await runOf(0, 10);
    const lead = await openLead(card.id, category.slug);

    const detail = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/leads/${lead.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.freeOfferCount).toBe(0);

    const preview = await offerCost(profile.id, cookie, lead.requestId);
    expect(preview.body).toMatchObject({ kind: 'CREDITS', creditCost: CATEGORY_COST, allowance: null });

    const free = await offer(profile.id, cookie, lead.requestId, offerPayload({ expectedCreditCost: 0 }));
    expect(free.status).toBe(409);
    expect(free.body).toMatchObject({ code: 'CREDIT_COST_CHANGED', actualCreditCost: CATEGORY_COST });
    expect(await currentCreditBalance(ctx.prisma, profile.id)).toBe(10);

    const paid = await offer(profile.id, cookie, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);
    expect(paid.body.creditCost).toBe(CATEGORY_COST);
    expect(await currentCreditBalance(ctx.prisma, profile.id)).toBe(10 - CATEGORY_COST);
    expect(await ctx.prisma.offerAllowanceUsage.count()).toBe(0);
    expect(await ctx.prisma.offerAllowanceGrant.count()).toBe(0);
  });

  it('without a balance the preview says so and nothing is spent', async () => {
    const { category, profile, card, cookie } = await runOf(0, 0);
    const lead = await openLead(card.id, category.slug);
    const preview = await offerCost(profile.id, cookie, lead.requestId);
    expect(preview.body).toMatchObject({ kind: 'INSUFFICIENT_CREDITS', creditCost: CATEGORY_COST, allowance: null });
    const refused = await offer(profile.id, cookie, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST }));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await ctx.prisma.offer.count()).toBe(0);
  });

  it('concurrent answers on a zero run are each charged once, with no slot claimed', async () => {
    const { category, profile, card, cookie } = await runOf(0, 10);
    const a = await openLead(card.id, category.slug);
    const b = await openLead(card.id, category.slug);
    const c = await openLead(card.id, category.slug);

    const results = await Promise.all(
      [a, b, c].map((lead) => offer(profile.id, cookie, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST }))),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(await currentCreditBalance(ctx.prisma, profile.id)).toBe(10 - 3 * CATEGORY_COST);
    expect(await ctx.prisma.offerAllowanceUsage.count()).toBe(0);
  });
});

// ── backward compatibility ───────────────────────────────────────────────────

describe('setting a package to 0 after it has sold', () => {
  it('changes no purchase, right, run, grant or usage already sold; the next sale is born without a grant', async () => {
    const { category, profile, cookie, pkg, card, purchase, placement } = await runOf(3, 10);
    const lead = await openLead(card.id, category.slug);
    await offer(profile.id, cookie, lead.requestId, offerPayload({ expectedCreditCost: 0 })).expect(201);

    // A right bought under 3 and not yet spent.
    const opened = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, expectedFreeOfferCount: 3 }).expect(201);
    await mockPay(profile.id, cookie, opened.body.purchase.id).expect(201);

    const snapshot = async () => ({
      purchases: await ctx.prisma.packagePurchase.findMany({ orderBy: { id: 'asc' } }),
      rights: await ctx.prisma.showcaseEntitlement.findMany({ orderBy: { id: 'asc' } }),
      runs: await ctx.prisma.showcasePlacement.findMany({ orderBy: { id: 'asc' } }),
      grants: await ctx.prisma.offerAllowanceGrant.findMany({ orderBy: { id: 'asc' } }),
      usages: await ctx.prisma.offerAllowanceUsage.findMany({ orderBy: { id: 'asc' } }),
    });
    const before = await snapshot();
    expect(before.grants).toHaveLength(1);
    expect(before.grants[0]).toMatchObject({ showcasePlacementId: placement.id, quotaTotal: 3, quotaUsed: 1 });
    expect(before.usages).toHaveLength(1);

    const admin = await operator();
    await request(ctx.server)
      .patch(`/admin/showcase/packages/${pkg.id}`)
      .set('Cookie', admin)
      .send({ freeOfferCount: 0 })
      .expect(200);
    expect(await snapshot()).toEqual(before);
    expect(purchase.freeOfferCountSnapshot).toBe(3);

    // The run sold with 3 still answers free from its remaining slots.
    const second = await openLead(card.id, category.slug);
    const stillFree = await offerCost(profile.id, cookie, second.requestId);
    expect(stillFree.body).toMatchObject({ kind: 'SHOWCASE_ALLOWANCE', creditCost: 0, allowance: { quotaTotal: 3, remaining: 2 } });

    // The right bought under 3 becomes a run with 3.
    const fromOldRight = await publishWithRight({ providerId: profile.id, categoryId: category.id });
    expect(fromOldRight.quotaTotal).toBe(3);

    // The next sale is 0, and its run has no grant.
    const zeroSale = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, expectedFreeOfferCount: 0 }).expect(201);
    expect(zeroSale.body.purchase.freeOfferCountSnapshot).toBe(0);
    await mockPay(profile.id, cookie, zeroSale.body.purchase.id).expect(201);
    const fromZeroRight = await publishWithRight({ providerId: profile.id, categoryId: category.id });
    expect(fromZeroRight.quotaTotal).toBe(0);
    expect(await ctx.prisma.offerAllowanceGrant.count({ where: { showcasePlacementId: fromZeroRight.placementId } })).toBe(0);
    expect(await ctx.prisma.offerAllowanceGrant.count()).toBe(2);
  });
});
