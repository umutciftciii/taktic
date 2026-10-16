import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdminPermission, ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { grantShowcasePlacementAllowance } from '../src/modules/offer-allowances/offer-allowance-ledger';
import { ShowcaseEntitlementService } from '../src/modules/showcase/showcase-entitlement.service';
import {
  createAdminWithPermissions,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createOfferPackage,
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
 * SHOWCASE-ALLOWANCE-001 — the free vitrin offers a run carries are the
 * package's `freeOfferCount`, snapshotted along the sale:
 *
 *   package → purchase (checkout) → right / run → grant (`quotaTotal`)
 *
 * An operator editing the package changes the next checkout and nothing
 * already sold. Consumption, ordering, the ledger and refunds are
 * CAMPAIGN-ENTITLEMENT-001's and are only re-checked here against a count
 * other than 3.
 */

const CATEGORY_COST = 2;

const SNAPSHOT_CONSISTENCY_SQL = readFileSync(
  resolve(__dirname, '../../../scripts/ops/showcase-allowance-001-consistency.sql'),
  'utf8',
);

const MIGRATION = resolve(
  __dirname,
  '../../../prisma/migrations/20261016090000_add_showcase_package_free_offer_count/migration.sql',
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
  expect(await snapshotInconsistencies()).toEqual([]);
  expect(await allowanceInconsistencies(ctx.prisma)).toEqual([]);
});

// ── builders ─────────────────────────────────────────────────────────────────

function snapshotInconsistencies() {
  return ctx.prisma.$queryRawUnsafe<{ check: string; subject: string }[]>(SNAPSHOT_CONSISTENCY_SQL);
}

async function provider() {
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
  return { category, user, profile, cookie: await loginAs(ctx.prisma, user.id) };
}

async function operator() {
  const { admin } = await createAdminWithPermissions(ctx.prisma, [
    AdminPermission.SHOWCASE_PACKAGES_READ,
    AdminPermission.SHOWCASE_PACKAGES_WRITE,
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

// ── the catalogue ────────────────────────────────────────────────────────────

describe('the package setting', () => {
  it('defaults to 3, takes 0..50 on create and edit, and records the change in the audit trail', async () => {
    const cookie = await operator();
    const base = { priceAmount: 49_900, durationDays: 30 };

    const defaulted = await request(ctx.server)
      .post('/admin/showcase/packages')
      .set('Cookie', cookie)
      .send({ ...base, name: 'Vitrin Varsayılan', slug: 'vitrin-varsayilan' })
      .expect(201);
    expect(defaulted.body.freeOfferCount).toBe(3);

    const five = await request(ctx.server)
      .post('/admin/showcase/packages')
      .set('Cookie', cookie)
      .send({ ...base, name: 'Vitrin Beş', slug: 'vitrin-bes', freeOfferCount: 5 })
      .expect(201);
    expect(five.body.freeOfferCount).toBe(5);

    for (const invalid of [-1, 51, 2.5, '4', null]) {
      const refused = await request(ctx.server)
        .post('/admin/showcase/packages')
        .set('Cookie', cookie)
        .send({ ...base, name: 'Vitrin Hatalı', slug: `vitrin-hatali-${String(invalid).replace(/\W/g, 'x')}`, freeOfferCount: invalid });
      expect(refused.status, `create ${String(invalid)}`).toBe(400);
      const patched = await request(ctx.server)
        .patch(`/admin/showcase/packages/${five.body.id}`)
        .set('Cookie', cookie)
        .send({ freeOfferCount: invalid });
      expect(patched.status, `edit ${String(invalid)}`).toBe(400);
    }
    expect(await ctx.prisma.showcasePackage.count()).toBe(2);

    for (const boundary of [1, 50, 7]) {
      const saved = await request(ctx.server)
        .patch(`/admin/showcase/packages/${five.body.id}`)
        .set('Cookie', cookie)
        .send({ freeOfferCount: boundary })
        .expect(200);
      expect(saved.body.freeOfferCount).toBe(boundary);
    }

    const history = await request(ctx.server)
      .get(`/admin/showcase/packages/${five.body.id}/history`)
      .set('Cookie', cookie)
      .expect(200);
    expect(history.body.items.slice(0, 3).map((item: { changes: unknown }) => item.changes)).toEqual([
      [{ field: 'freeOfferCount', from: 50, to: 7 }],
      [{ field: 'freeOfferCount', from: 1, to: 50 }],
      [{ field: 'freeOfferCount', from: 5, to: 1 }],
    ]);
  });

  it('the database refuses a count outside 0..50 whatever the writer', async () => {
    const pkg = await createShowcasePackage(ctx.prisma);
    for (const invalid of [-1, 51]) {
      await expect(
        ctx.prisma.showcasePackage.update({ where: { id: pkg.id }, data: { freeOfferCount: invalid } }),
      ).rejects.toThrow(/ShowcasePackage_free_offer_count_range/);
    }
  });

  it('the provider’s shop lists every package with its own count', async () => {
    const { profile, cookie } = await provider();
    await createShowcasePackage(ctx.prisma, { name: 'Üçlü' });
    await createShowcasePackage(ctx.prisma, { name: 'Sekizli', freeOfferCount: 8 });

    const listed = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/packages`)
      .set('Cookie', cookie)
      .expect(200);
    const counts = Object.fromEntries(
      listed.body.packages.map((pkg: { name: string; freeOfferCount: number }) => [pkg.name.split(' ')[0], pkg.freeOfferCount]),
    );
    expect(counts).toEqual({ Üçlü: 3, Sekizli: 8 });
  });
});

// ── the snapshot chain ───────────────────────────────────────────────────────

describe('the snapshot chain', () => {
  it('checkout → right → run → grant carry the count shown at checkout; later edits reach none of them', async () => {
    const { category, profile, cookie } = await provider();
    const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount: 5 });

    const opened = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, expectedFreeOfferCount: 5 }).expect(201);
    const purchaseId = opened.body.purchase.id as string;
    expect(opened.body.purchase.freeOfferCountSnapshot).toBe(5);

    // Edited between the checkout and the payment: the sale already promised 5.
    await ctx.prisma.showcasePackage.update({ where: { id: pkg.id }, data: { freeOfferCount: 9 } });
    await mockPay(profile.id, cookie, purchaseId).expect(201);

    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { purchaseId } });
    expect(right.freeOfferCountSnapshot).toBe(5);

    const rights = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/entitlements`)
      .set('Cookie', cookie)
      .expect(200);
    expect(rights.body.available[0]).toMatchObject({ freeOfferCount: 5 });

    // Edited again before the right is spent.
    await ctx.prisma.showcasePackage.update({ where: { id: pkg.id }, data: { freeOfferCount: 1 } });
    const { placementId, quotaTotal } = await publishWithRight({ providerId: profile.id, categoryId: category.id });
    expect(quotaTotal).toBe(5);

    const placement = await ctx.prisma.showcasePlacement.findUniqueOrThrow({
      where: { id: placementId },
      include: { offerAllowanceGrant: true },
    });
    expect(placement.freeOfferCountSnapshot).toBe(5);
    expect(placement.offerAllowanceGrant).toMatchObject({ quotaTotal: 5, quotaUsed: 0, status: 'ACTIVE' });

    // And after the run is on the air.
    await ctx.prisma.showcasePackage.update({ where: { id: pkg.id }, data: { freeOfferCount: 50 } });
    expect(await ctx.prisma.offerAllowanceGrant.findUniqueOrThrow({ where: { showcasePlacementId: placementId } })).toMatchObject({
      quotaTotal: 5,
    });

    // The provider's own screens read the run's numbers.
    const runs = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/placements/${placementId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(runs.body).toMatchObject({ freeOfferCount: 5, freeOffers: { total: 5, used: 0, remaining: 5, status: 'ACTIVE' } });
    const publication = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/publication`)
      .set('Cookie', cookie)
      .expect(200);
    expect(publication.body.cards[0].freeOffers).toEqual({ total: 5, used: 0, remaining: 5, status: 'ACTIVE' });
  });

  it('a card-bound (legacy) sale snapshots the count onto its run and grant the same way', async () => {
    const { category, profile } = await provider();
    const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount: 4 });
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, { providerId: profile.id, categoryId: category.id });
    const { purchase, placement } = await createLiveShowcasePlacement(ctx, {
      providerId: profile.id,
      cardId: card.id,
      versionId: version.id,
      packageId: pkg.id,
    });
    expect(purchase.freeOfferCountSnapshot).toBe(4);
    expect(placement.freeOfferCountSnapshot).toBe(4);
    expect(await ctx.prisma.offerAllowanceGrant.findUniqueOrThrow({ where: { showcasePlacementId: placement.id } })).toMatchObject({
      quotaTotal: 4,
    });
  });

  it('a checkout an older version opened (no snapshot) settles as the legacy 3, whatever the package says now', async () => {
    const { category, profile, cookie } = await provider();
    const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount: 6 });
    const opened = await checkout(profile.id, cookie, { showcasePackageId: pkg.id }).expect(201);
    const purchaseId = opened.body.purchase.id as string;
    await ctx.prisma.packagePurchase.update({ where: { id: purchaseId }, data: { freeOfferCountSnapshot: null } });

    await mockPay(profile.id, cookie, purchaseId).expect(201);
    expect((await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { purchaseId } })).freeOfferCountSnapshot).toBe(3);
    const { quotaTotal } = await publishWithRight({ providerId: profile.id, categoryId: category.id });
    expect(quotaTotal).toBe(3);
  });

  it('a stale screen is refused, not sold a different count; an older client that sends nothing still buys', async () => {
    const { profile, cookie } = await provider();
    const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount: 5 });

    const stale = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, expectedFreeOfferCount: 3 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'SHOWCASE_PACKAGE_FREE_OFFERS_CHANGED',
      expectedFreeOfferCount: 3,
      actualFreeOfferCount: 5,
    });
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);

    for (const invalid of [-1, 51, '5', null]) {
      expect((await checkout(profile.id, cookie, { showcasePackageId: pkg.id, expectedFreeOfferCount: invalid })).status).toBe(400);
    }

    const legacyClient = await checkout(profile.id, cookie, { showcasePackageId: pkg.id }).expect(201);
    expect(legacyClient.body.purchase.freeOfferCountSnapshot).toBe(5);
  });

  it('a pending checkout opened under the old count is not continued under the new one', async () => {
    const { profile, cookie } = await provider();
    const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount: 5 });

    const first = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, expectedFreeOfferCount: 5 }).expect(201);
    const again = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, expectedFreeOfferCount: 5 }).expect(201);
    expect(again.body.purchase.id).toBe(first.body.purchase.id);
    expect(again.body.checkout.reused).toBe(true);

    await ctx.prisma.showcasePackage.update({ where: { id: pkg.id }, data: { freeOfferCount: 9 } });
    const fresh = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, expectedFreeOfferCount: 9 }).expect(201);
    expect(fresh.body.purchase.id).not.toBe(first.body.purchase.id);
    expect(fresh.body.checkout.reused).toBe(false);
    expect(fresh.body.purchase.freeOfferCountSnapshot).toBe(9);
    expect(
      (await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: first.body.purchase.id } })).freeOfferCountSnapshot,
    ).toBe(5);
  });

  it('a credit package purchase never carries a free offer count (CHECK)', async () => {
    const { profile } = await provider();
    const offerPackage = await createOfferPackage(ctx.prisma);
    await expect(
      ctx.prisma.packagePurchase.create({
        data: {
          providerId: profile.id,
          kind: 'OFFER_PACKAGE',
          packageId: offerPackage.id,
          creditAmountSnapshot: 10,
          priceAmountSnapshot: 10_000,
          packageNameSnapshot: offerPackage.name,
          freeOfferCountSnapshot: 3,
        },
      }),
    ).rejects.toThrow(/PackagePurchase_free_offer_count_snapshot_shape/);
  });
});

// ── idempotency ──────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('a redelivered settlement grants one right; a replayed birth keeps the first grant and reports its quota', async () => {
    const { category, profile, cookie } = await provider();
    const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount: 2 });
    const opened = await checkout(profile.id, cookie, { showcasePackageId: pkg.id }).expect(201);
    await mockPay(profile.id, cookie, opened.body.purchase.id).expect(201);
    await mockPay(profile.id, cookie, opened.body.purchase.id).expect(409);
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(1);

    const { placementId } = await publishWithRight({ providerId: profile.id, categoryId: category.id });
    const replay = await ctx.prisma.$transaction((tx) =>
      grantShowcasePlacementAllowance(tx, { placementId, providerId: profile.id, startAt: new Date(), quotaTotal: 7 }),
    );
    expect(replay.quotaTotal).toBe(2);
    expect(await ctx.prisma.offerAllowanceGrant.count({ where: { showcasePlacementId: placementId } })).toBe(1);
  });

  it('a non-positive quota never reaches the database', async () => {
    const { category, profile } = await provider();
    const pkg = await createShowcasePackage(ctx.prisma);
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, { providerId: profile.id, categoryId: category.id });
    const { placement } = await createLiveShowcasePlacement(ctx, {
      providerId: profile.id,
      cardId: card.id,
      versionId: version.id,
      packageId: pkg.id,
    });
    await expect(
      ctx.prisma.$transaction((tx) =>
        grantShowcasePlacementAllowance(tx, { placementId: placement.id, providerId: profile.id, startAt: new Date(), quotaTotal: 0 }),
      ),
    ).rejects.toThrow(/Invalid showcase allowance quota/);
  });
});

// ── consumption against a count other than 3 ─────────────────────────────────

describe('consumption with the package’s count', () => {
  async function runOf(freeOfferCount: number, credits = 0) {
    const { category, profile, user } = await provider();
    if (credits) await grantCredits(ctx.prisma, profile.id, credits);
    const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount });
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, { providerId: profile.id, categoryId: category.id });
    const { placement } = await createLiveShowcasePlacement(ctx, {
      providerId: profile.id,
      cardId: card.id,
      versionId: version.id,
      packageId: pkg.id,
    });
    return { category, profile, card, placement, cookie: await loginAs(ctx.prisma, user.id) };
  }

  it('a 1-offer run: two answers race for the only slot — one free, one refused; the paid retry is charged normally', async () => {
    const { category, profile, card, placement, cookie } = await runOf(1, 10);
    const a = await openLead(card.id, category.slug);
    const b = await openLead(card.id, category.slug);

    const preview = await request(ctx.server)
      .get(`/providers/${profile.id}/requests/${a.requestId}/offer-cost`)
      .set('Cookie', cookie)
      .expect(200);
    expect(preview.body).toMatchObject({ kind: 'SHOWCASE_ALLOWANCE', creditCost: 0, allowance: { quotaTotal: 1, quotaUsed: 0, remaining: 1 } });

    const [first, second] = await Promise.all([
      offer(profile.id, cookie, a.requestId, offerPayload({ expectedCreditCost: 0 })),
      offer(profile.id, cookie, b.requestId, offerPayload({ expectedCreditCost: 0 })),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const loser = first.status === 409 ? { response: first, lead: a } : { response: second, lead: b };
    expect(loser.response.body).toMatchObject({ code: 'CREDIT_COST_CHANGED', actualCreditCost: CATEGORY_COST });

    expect(await ctx.prisma.offerAllowanceGrant.findUniqueOrThrow({ where: { showcasePlacementId: placement.id } })).toMatchObject({
      quotaTotal: 1,
      quotaUsed: 1,
    });
    expect((await ctx.prisma.offerAllowanceUsage.findMany()).map((usage) => usage.ordinal)).toEqual([1]);
    expect(await currentCreditBalance(ctx.prisma, profile.id)).toBe(10);

    const paid = await offer(profile.id, cookie, loser.lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);
    expect(paid.body.creditCost).toBe(CATEGORY_COST);
    expect(await currentCreditBalance(ctx.prisma, profile.id)).toBe(10 - CATEGORY_COST);
    expect(await ctx.prisma.offerAllowanceUsage.count()).toBe(1);
  });

  it('a 5-offer run gives five free answers with ordinals 1..5, then the category price', async () => {
    const { category, profile, card, placement, cookie } = await runOf(5, 10);
    for (let slot = 1; slot <= 5; slot += 1) {
      const lead = await openLead(card.id, category.slug);
      const answered = await offer(profile.id, cookie, lead.requestId, offerPayload({ expectedCreditCost: 0 })).expect(201);
      expect(answered.body.creditCost).toBe(0);
    }
    expect((await ctx.prisma.offerAllowanceUsage.findMany({ orderBy: { ordinal: 'asc' } })).map((u) => u.ordinal)).toEqual([
      1, 2, 3, 4, 5,
    ]);

    const sixth = await openLead(card.id, category.slug);
    await offer(profile.id, cookie, sixth.requestId, offerPayload({ expectedCreditCost: 0 })).expect(409);
    await offer(profile.id, cookie, sixth.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);
    expect(await ctx.prisma.offerAllowanceGrant.findUniqueOrThrow({ where: { showcasePlacementId: placement.id } })).toMatchObject({
      quotaTotal: 5,
      quotaUsed: 5,
    });
    expect(await currentCreditBalance(ctx.prisma, profile.id)).toBe(10 - CATEGORY_COST);
  });
});

// ── the migration's backfill ─────────────────────────────────────────────────

describe('migration backfill', () => {
  function backfill(): string {
    const sql = readFileSync(MIGRATION, 'utf8');
    const start = sql.indexOf('-- BEGIN BACKFILL');
    const end = sql.indexOf('-- END BACKFILL');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return sql
      .slice(start, end)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
  }

  it('gives every pre-existing vitrin purchase the legacy 3, touches no credit purchase, and is a no-op twice', async () => {
    const { profile, cookie } = await provider();
    const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount: 8 });
    const opened = await checkout(profile.id, cookie, { showcasePackageId: pkg.id }).expect(201);
    const offerPackage = await createOfferPackage(ctx.prisma);
    const credit = await ctx.prisma.packagePurchase.create({
      data: {
        providerId: profile.id,
        kind: 'OFFER_PACKAGE',
        packageId: offerPackage.id,
        creditAmountSnapshot: 10,
        priceAmountSnapshot: 10_000,
        packageNameSnapshot: offerPackage.name,
      },
    });
    // The pre-migration state: no snapshot on any row.
    await ctx.prisma.packagePurchase.update({ where: { id: opened.body.purchase.id }, data: { freeOfferCountSnapshot: null } });

    expect(await ctx.prisma.$executeRawUnsafe(backfill())).toBe(1);
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: opened.body.purchase.id } })).freeOfferCountSnapshot).toBe(3);
    expect((await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: credit.id } })).freeOfferCountSnapshot).toBeNull();
    expect(await ctx.prisma.$executeRawUnsafe(backfill())).toBe(0);
  });
});
