import { AdminPermission, PackagePurchaseStatus, ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdminWithPermissions,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createOfferPackage,
  createShowcaseEntitlement,
  createShowcasePackage,
  createTestApp,
  createUser,
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

/**
 * SHOWCASE-ALLOWANCE-002 — GET /finance/offer-allowances.
 *
 * The report reads what the allowance tables already record and never writes:
 * a grant splits exactly into tracked + legacy + usable + unusable, the used
 * slots carry their category credit, and that credit is given an indicative TL
 * value only from the same Istanbul month's paid credit package purchases.
 */

const CATEGORY_COST = 2;

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
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48 },
    update: { marketplaceAutoPublishEnabled: false },
  });
});

afterEach(async () => {
  expect(await allowanceInconsistencies(ctx.prisma)).toEqual([]);
  expect(await reportInconsistencies(ctx.prisma)).toEqual([]);
});

// ── builders ─────────────────────────────────────────────────────────────────

type Owner = { id: string; userId: string; cookie: string };

type Cohort = {
  grants: number;
  defined: number;
  usedTracked: number;
  usedLegacy: number;
  remainingUsable: number;
  remainingUsableViaOpenLeads: number;
  remainingUnusable: number;
};

type Usage = {
  usages: number;
  credits: number;
  valuedCredits: number;
  unvaluedCredits: number;
  indicativeValueMinor: number | null;
};

type Report = {
  range: { from: string | null; to: string | null; groupBy: string; timezone: string };
  timeBases: Record<string, string>;
  cohort: Cohort;
  usage: Usage;
  unplaced: { pendingRights: number; pendingFreeOffers: number; expiredRights: number; expiredFreeOffers: number } | null;
  valuation: {
    method: string;
    months: Array<{ month: string; credits: number; purchases: number; perCreditMinor: number | null }>;
    listPriceReference: {
      minPerCreditMinor: number;
      maxPerCreditMinor: number;
      lowValueMinor: number;
      highValueMinor: number;
      packages: number;
    } | null;
  };
  integrity: { zeroAllowancePlacements: number; placementsWithoutGrant: number; voidGrants: number };
  byPackage: Array<{ package: { id: string; name: string | null }; cohort: Cohort; usage: Usage; unplaced?: unknown }>;
  byCategory: Array<{ category: { id: string; name: string | null }; cohort: Cohort; usage: Usage }>;
  byProvider: {
    items: Array<{ provider: { id: string; businessName: string | null }; cohort: Cohort; usage: Usage }>;
    total: number;
    page: number;
    pageSize: number;
    hasNextPage: boolean;
  };
  cohortByPeriod: Array<Cohort & { bucket: string }>;
  usageByPeriod: Array<Usage & { bucket: string }>;
};

async function financeCookie() {
  const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.FINANCE_READ]);
  return loginAs(ctx.prisma, admin.id);
}

async function report(query = '', cookie?: string): Promise<Report> {
  const response = await request(ctx.server)
    .get(`/finance/offer-allowances${query}`)
    .set('Cookie', cookie ?? (await financeCookie()))
    .expect(200);
  return response.body as Report;
}

async function provider(category: { id: string }) {
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const owner: Owner = { id: profile.id, userId: ownerUser.id, cookie: await loginAs(ctx.prisma, ownerUser.id) };
  return owner;
}

async function category(name = 'Klima', cost = CATEGORY_COST) {
  return createCategory(ctx.prisma, name, { kind: ServiceCategoryKind.LEAF, offerCreditCost: cost });
}

/** One approved card and a live run of it with `freeOfferCount` free offers. */
async function publish(owner: Owner, categoryId: string, options: { freeOfferCount?: number; pkgId?: string } = {}) {
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, { providerId: owner.id, categoryId });
  const pkgId =
    options.pkgId ??
    (await createShowcasePackage(ctx.prisma, { freeOfferCount: options.freeOfferCount ?? 3 })).id;
  const { placement } = await createLiveShowcasePlacement(ctx, {
    providerId: owner.id,
    cardId: card.id,
    versionId: version.id,
    packageId: pkgId,
  });
  return { card, placement, pkgId };
}

async function openLead(cardId: string, categorySlug: string) {
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const payload = showcaseLeadPayload(categorySlug);
  await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
  const created = await request(ctx.server)
    .post(`/showcase/cards/${cardId}/leads`)
    .set('Cookie', await loginAs(ctx.prisma, customer.id))
    .send({ ...payload, useAlternateContact: true });
  expect(created.status).toBe(201);
  return ctx.prisma.showcaseLead.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
}

function offer(owner: Owner, requestId: string, expectedCreditCost = 0) {
  return request(ctx.server)
    .post(`/providers/${owner.id}/requests/${requestId}/offers`)
    .set('Cookie', owner.cookie)
    .send(offerPayload({ expectedCreditCost }));
}

async function spendFree(owner: Owner, cardId: string, categorySlug: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    const lead = await openLead(cardId, categorySlug);
    const response = await offer(owner, lead.requestId);
    expect(response.status).toBe(201);
    expect(response.body.creditCost).toBe(0);
  }
}

async function endRun(placementId: string, status: 'EXPIRED' | 'CANCELLED' = 'EXPIRED') {
  const past = new Date(Date.now() - 60_000);
  await ctx.prisma.showcasePlacement.update({
    where: { id: placementId },
    data: { status, startAt: new Date(past.getTime() - 1000), endAt: past, ...(status === 'CANCELLED' ? { cancelledAt: past } : {}) },
  });
  await ctx.prisma.showcasePlacementShelf.updateMany({ where: { placementId }, data: { active: false, endAt: past } });
}

/** A paid one-time credit package purchase — the only input of the TL rate. */
async function paidCreditPurchase(
  providerId: string,
  options: { credits: number; price: number; paidAt?: Date; status?: PackagePurchaseStatus },
) {
  const pkg = await createOfferPackage(ctx.prisma, {
    creditAmount: options.credits,
    priceAmount: options.price,
    isActive: false,
  });
  return ctx.prisma.packagePurchase.create({
    data: {
      providerId,
      packageId: pkg.id,
      kind: 'OFFER_PACKAGE',
      status: options.status ?? PackagePurchaseStatus.PAID,
      creditAmountSnapshot: options.credits,
      priceAmountSnapshot: options.price,
      packageNameSnapshot: pkg.name,
      paidAt: options.paidAt ?? new Date(),
    },
  });
}

function istanbulMonthStart(now = new Date()): Date {
  const [year, month] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
  })
    .format(now)
    .split('-');
  return new Date(`${year}-${month}-01T00:00:00+03:00`);
}

function sumCohort(rows: Array<{ cohort: Cohort }>): Cohort {
  const total: Cohort = {
    grants: 0,
    defined: 0,
    usedTracked: 0,
    usedLegacy: 0,
    remainingUsable: 0,
    remainingUsableViaOpenLeads: 0,
    remainingUnusable: 0,
  };
  for (const row of rows) {
    for (const key of Object.keys(total) as Array<keyof Cohort>) {
      total[key] += row.cohort[key];
    }
  }
  return total;
}

function sumUsage(rows: Array<{ usage: Usage }>) {
  return rows.reduce(
    (acc, row) => ({
      usages: acc.usages + row.usage.usages,
      credits: acc.credits + row.usage.credits,
      valuedCredits: acc.valuedCredits + row.usage.valuedCredits,
      value: acc.value + (row.usage.indicativeValueMinor ?? 0),
    }),
    { usages: 0, credits: 0, valuedCredits: 0, value: 0 },
  );
}

function expectSplits(cohort: Cohort) {
  expect(cohort.usedTracked + cohort.usedLegacy + cohort.remainingUsable + cohort.remainingUnusable).toBe(cohort.defined);
}

// ── access ───────────────────────────────────────────────────────────────────

describe('access', () => {
  it('is 401 without a session, 403 without FINANCE_READ and 200 with FINANCE_READ alone', async () => {
    await request(ctx.server).get('/finance/offer-allowances').expect(401);

    const { admin: ledgerOnly } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.FINANCE_LEDGER_READ]);
    await request(ctx.server)
      .get('/finance/offer-allowances')
      .set('Cookie', await loginAs(ctx.prisma, ledgerOnly.id))
      .expect(403);

    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await request(ctx.server)
      .get('/finance/offer-allowances')
      .set('Cookie', await loginAs(ctx.prisma, providerUser.id))
      .expect(403);

    const body = await report();
    expect(Object.keys(body).sort()).toEqual(
      [
        'byCategory',
        'byPackage',
        'byProvider',
        'cohort',
        'cohortByPeriod',
        'filters',
        'integrity',
        'range',
        'timeBases',
        'unplaced',
        'usage',
        'usageByPeriod',
        'valuation',
      ].sort(),
    );
  });

  it('names no offer, request, lead or customer — only package, category and business names', async () => {
    const cat = await category();
    const owner = await provider(cat);
    const { card } = await publish(owner, cat.id);
    await spendFree(owner, card.id, cat.slug, 1);

    const body = await report();
    const text = JSON.stringify(body);
    for (const forbidden of ['offerId', 'requestId', 'showcaseLeadId', 'customer', 'phone', 'email']) {
      expect(text).not.toContain(forbidden);
    }
    expect(Object.keys(body.byProvider.items[0]?.provider ?? {}).sort()).toEqual(['businessName', 'id']);
  });

  it('refuses malformed windows with 400', async () => {
    const cookie = await financeCookie();
    for (const query of ['?from=2026-13-01', '?from=2026-10-10&to=2026-10-01', '?groupBy=day', '?groupBy=week', '?pageSize=500']) {
      await request(ctx.server).get(`/finance/offer-allowances${query}`).set('Cookie', cookie).expect(400);
    }
    await request(ctx.server)
      .get('/finance/offer-allowances?groupBy=day&from=2025-01-01&to=2026-06-01')
      .set('Cookie', cookie)
      .expect(400);
    // 370 civil days is the limit, counted day to day as the screen counts it.
    await request(ctx.server)
      .get('/finance/offer-allowances?groupBy=day&from=2026-01-01&to=2027-01-06')
      .set('Cookie', cookie)
      .expect(200);
    await request(ctx.server)
      .get('/finance/offer-allowances?groupBy=day&from=2026-01-01&to=2027-01-07')
      .set('Cookie', cookie)
      .expect(400);
  });
});

// ── the cohort split ─────────────────────────────────────────────────────────

describe('cohort', () => {
  it('splits a live grant into tracked use and usable remainder, with the category credit of each use', async () => {
    const cat = await category();
    const owner = await provider(cat);
    const { card } = await publish(owner, cat.id);
    await spendFree(owner, card.id, cat.slug, 2);

    const body = await report();
    expect(body.cohort).toEqual({
      grants: 1,
      defined: 3,
      usedTracked: 2,
      usedLegacy: 0,
      remainingUsable: 1,
      remainingUsableViaOpenLeads: 0,
      remainingUnusable: 0,
    });
    expect(body.usage).toMatchObject({ usages: 2, credits: 2 * CATEGORY_COST });
    expect(body.timeBases).toEqual({
      cohort: 'GRANT_VALID_FROM',
      usage: 'USAGE_CONSUMED_AT',
      unplaced: 'ENTITLEMENT_GRANTED_AT',
      valuation: 'USAGE_MONTH_PAID_CREDIT_PACKAGES',
    });
  });

  it('values a use at the category price it was spent at, not the price the category has now', async () => {
    const cat = await category();
    const owner = await provider(cat);
    const { card } = await publish(owner, cat.id);
    await spendFree(owner, card.id, cat.slug, 1);
    await ctx.prisma.serviceCategory.update({ where: { id: cat.id }, data: { offerCreditCost: 9 } });

    expect((await report()).usage.credits).toBe(CATEGORY_COST);
  });

  it('counts legacy slots apart, with no credit or TL value invented for them', async () => {
    const cat = await category();
    const owner = await provider(cat);
    const { card, placement } = await publish(owner, cat.id);
    await spendFree(owner, card.id, cat.slug, 1);
    // A rollout-era grant: two answers counted under the old unlimited rule,
    // with no usage row behind them (quotaUsed − usage rows).
    const grant = await ctx.prisma.offerAllowanceGrant.update({
      where: { showcasePlacementId: placement.id },
      data: { quotaTotal: 6, quotaUsed: 3 },
    });
    // A grant that is not a backfilled one cannot carry legacy slots: the ops
    // check names exactly this grant, twice, and nothing else.
    expect((await reportInconsistencies(ctx.prisma)).sort((a, b) => a.check.localeCompare(b.check))).toEqual([
      { check: 'GRANT_QUOTA_NOT_SNAPSHOT', subject: grant.id },
      { check: 'LEGACY_ON_NEW_GRANT', subject: grant.id },
    ]);
    await paidCreditPurchase(owner.id, { credits: 10, price: 25_000 });

    const body = await report();
    expect(body.cohort).toMatchObject({ defined: 6, usedTracked: 1, usedLegacy: 2, remainingUsable: 3 });
    expectSplits(body.cohort);
    expect(body.usage).toEqual({
      usages: 1,
      credits: CATEGORY_COST,
      valuedCredits: CATEGORY_COST,
      unvaluedCredits: 0,
      indicativeValueMinor: CATEGORY_COST * 2_500,
    });

    await ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data: { quotaTotal: 3, quotaUsed: 1 } });
  });

  it('a run sold with 0 free offers has no grant and is reported as such, not as a gap', async () => {
    const cat = await category();
    const owner = await provider(cat);
    await publish(owner, cat.id, { freeOfferCount: 0 });

    const body = await report();
    expect(body.cohort.grants).toBe(0);
    expect(body.cohort.defined).toBe(0);
    expect(body.integrity).toEqual({ zeroAllowancePlacements: 1, placementsWithoutGrant: 0, voidGrants: 0 });
  });

  it('an ended run keeps one usable slot per lead still waiting for its free answer, and no more', async () => {
    const cat = await category();
    const owner = await provider(cat);
    const { card, placement } = await publish(owner, cat.id);
    await openLead(card.id, cat.slug);
    await openLead(card.id, cat.slug);
    await endRun(placement.id);

    const withLeads = await report();
    expect(withLeads.cohort).toEqual({
      grants: 1,
      defined: 3,
      usedTracked: 0,
      usedLegacy: 0,
      remainingUsable: 2,
      remainingUsableViaOpenLeads: 2,
      remainingUnusable: 1,
    });

    // The waiting leads are what keeps the slots usable: once they are gone,
    // the remainder of an ended run can never be spent.
    await ctx.prisma.showcaseLead.updateMany({
      where: { placementId: placement.id },
      data: { status: 'CLOSED_UNANSWERED', closedAt: new Date(), closeReason: 'REQUEST_EXPIRED' },
    });
    const withoutLeads = await report();
    expect(withoutLeads.cohort).toMatchObject({ remainingUsable: 0, remainingUsableViaOpenLeads: 0, remainingUnusable: 3 });
    expectSplits(withoutLeads.cohort);
  });

  it('a cancelled (refunded) run and a VOID grant count their remainder as unusable', async () => {
    const cat = await category();
    const owner = await provider(cat);
    const first = await publish(owner, cat.id);
    await spendFree(owner, first.card.id, cat.slug, 1);
    await endRun(first.placement.id, 'CANCELLED');

    const second = await publish(owner, cat.id);
    await ctx.prisma.offerAllowanceGrant.update({
      where: { showcasePlacementId: second.placement.id },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: 'test', voidedById: owner.userId },
    });

    const body = await report();
    expect(body.cohort).toMatchObject({ grants: 2, defined: 6, usedTracked: 1, remainingUsable: 0, remainingUnusable: 5 });
    expect(body.integrity.voidGrants).toBe(1);
    expectSplits(body.cohort);
  });

  it('two answers racing for the last slot are reported as exactly the slots that were claimed', async () => {
    const cat = await category();
    const owner = await provider(cat);
    await grantCredits(ctx.prisma, owner.id, 10);
    const { card } = await publish(owner, cat.id);
    await spendFree(owner, card.id, cat.slug, 2);
    const a = await openLead(card.id, cat.slug);
    const b = await openLead(card.id, cat.slug);

    const [first, second] = await Promise.all([offer(owner, a.requestId), offer(owner, b.requestId)]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);

    const body = await report();
    // The losing lead is still waiting, but a live run's remainder is what it
    // is: zero. Nothing is double counted and nothing is left over.
    expect(body.cohort).toMatchObject({ defined: 3, usedTracked: 3, remainingUsable: 0, remainingUnusable: 0 });
    expect(body.usage).toMatchObject({ usages: 3, credits: 3 * CATEGORY_COST });
  });
});

// ── the TL value ─────────────────────────────────────────────────────────────

describe('indicative TL value', () => {
  it('is N/A when the month of use had no paid credit package purchase', async () => {
    const cat = await category();
    const owner = await provider(cat);
    const { card } = await publish(owner, cat.id);
    await spendFree(owner, card.id, cat.slug, 2);
    // The month before: never used to value this month's credits.
    await paidCreditPurchase(owner.id, {
      credits: 20,
      price: 49_900,
      paidAt: new Date(istanbulMonthStart().getTime() - 2 * 60_000),
    });

    const body = await report();
    expect(body.usage).toEqual({
      usages: 2,
      credits: 4,
      valuedCredits: 0,
      unvaluedCredits: 4,
      indicativeValueMinor: null,
    });
    expect(body.valuation.months).toHaveLength(1);
    expect(body.valuation.months[0]).toMatchObject({ credits: 4, purchases: 0, perCreditMinor: null });
  });

  it('uses the weighted TL per credit of the same Istanbul month, PAID purchases only', async () => {
    const cat = await category();
    const owner = await provider(cat);
    const { card } = await publish(owner, cat.id);
    await spendFree(owner, card.id, cat.slug, 2);
    const monthStart = istanbulMonthStart();
    // One minute into the Istanbul month — still the previous day in UTC.
    await paidCreditPurchase(owner.id, { credits: 20, price: 49_900, paidAt: new Date(monthStart.getTime() + 60_000) });
    await paidCreditPurchase(owner.id, { credits: 100, price: 179_900 });
    // Neither a refunded nor an unpaid purchase is a price anyone paid.
    await paidCreditPurchase(owner.id, { credits: 10, price: 1_000_000, status: PackagePurchaseStatus.REFUNDED });
    await paidCreditPurchase(owner.id, { credits: 10, price: 1_000_000, status: PackagePurchaseStatus.PENDING });

    const body = await report();
    const perCredit = (49_900 + 179_900) / 120;
    expect(body.usage.valuedCredits).toBe(4);
    expect(body.usage.indicativeValueMinor).toBe(2 * Math.round(CATEGORY_COST * perCredit));
    expect(body.valuation.months[0]).toMatchObject({ purchases: 2, perCreditMinor: Math.round(perCredit * 100) / 100 });
    expect(body.valuation.method).toBe('MONTHLY_WEIGHTED_PAID_CREDIT_PACKAGES');
  });

  it('shows the current list price apart, as a range over the active credit packages', async () => {
    const cat = await category();
    const owner = await provider(cat);
    const { card } = await publish(owner, cat.id);
    await spendFree(owner, card.id, cat.slug, 2);
    await createOfferPackage(ctx.prisma, { creditAmount: 20, priceAmount: 49_900 });
    await createOfferPackage(ctx.prisma, { creditAmount: 100, priceAmount: 179_900 });
    await createOfferPackage(ctx.prisma, { creditAmount: 10, priceAmount: 999_900, isActive: false });

    const body = await report();
    expect(body.usage.indicativeValueMinor).toBeNull();
    expect(body.valuation.listPriceReference).toEqual({
      basis: 'CURRENT_ACTIVE_CREDIT_PACKAGES',
      packages: 2,
      minPerCreditMinor: 1_799,
      maxPerCreditMinor: 2_495,
      lowValueMinor: 4 * 1_799,
      highValueMinor: 4 * 2_495,
    });
  });
});

// ── breakdowns, filters and windows ──────────────────────────────────────────

describe('breakdowns', () => {
  async function twoProviders() {
    const klima = await category('Klima', 2);
    const boya = await category('Boya', 5);
    const alpha = await provider(klima);
    const beta = await provider(boya);
    const a = await publish(alpha, klima.id, { freeOfferCount: 3 });
    const b = await publish(beta, boya.id, { freeOfferCount: 4 });
    await spendFree(alpha, a.card.id, klima.slug, 2);
    await spendFree(beta, b.card.id, boya.slug, 1);
    await paidCreditPurchase(alpha.id, { credits: 20, price: 50_000 });
    return { klima, boya, alpha, beta, a, b };
  }

  it('every breakdown sums to its totals, kuruş for kuruş', async () => {
    await twoProviders();
    const body = await report();

    expect(body.cohort).toMatchObject({ grants: 2, defined: 7, usedTracked: 3, remainingUsable: 4 });
    expect(body.usage).toMatchObject({ usages: 3, credits: 2 * 2 + 5, indicativeValueMinor: 9 * 2_500 });
    for (const rows of [body.byPackage, body.byCategory, body.byProvider.items]) {
      expect(sumCohort(rows)).toEqual(body.cohort);
      expect(sumUsage(rows)).toEqual({
        usages: body.usage.usages,
        credits: body.usage.credits,
        valuedCredits: body.usage.valuedCredits,
        value: body.usage.indicativeValueMinor,
      });
    }
    expect(sumCohort(body.cohortByPeriod.map((row) => ({ cohort: row })))).toEqual(body.cohort);
    expect(body.usageByPeriod.reduce((sum, row) => sum + row.credits, 0)).toBe(body.usage.credits);
    // Ordered by used credits: the Boya provider (5) before Klima (4).
    expect(body.byCategory.map((row) => row.usage.credits)).toEqual([5, 4]);
  });

  it('filters by provider, category and package, and pages the provider breakdown', async () => {
    const { klima, alpha, beta, b } = await twoProviders();

    const byProvider = await report(`?providerId=${alpha.id}`);
    expect(byProvider.cohort).toMatchObject({ grants: 1, defined: 3, usedTracked: 2 });
    expect(byProvider.usage.credits).toBe(4);

    const byCategory = await report(`?categoryId=${klima.id}`);
    expect(byCategory.cohort.defined).toBe(3);
    expect(byCategory.unplaced).toBeNull();
    expect(byCategory.byPackage[0]).not.toHaveProperty('unplaced');

    const byPackage = await report(`?packageId=${b.pkgId}`);
    expect(byPackage.cohort.defined).toBe(4);
    expect(byPackage.byProvider.items.map((row) => row.provider.id)).toEqual([beta.id]);

    const first = await report('?pageSize=1');
    const second = await report('?pageSize=1&page=2');
    expect(first.byProvider).toMatchObject({ total: 2, page: 1, pageSize: 1, hasNextPage: true });
    expect(second.byProvider).toMatchObject({ total: 2, page: 2, hasNextPage: false });
    expect([...first.byProvider.items, ...second.byProvider.items].map((row) => row.provider.id).sort()).toEqual(
      [alpha.id, beta.id].sort(),
    );
  });

  it('reads the grant window by run start and the usage window by time of use, in Istanbul days', async () => {
    const cat = await category();
    const owner = await provider(cat);
    const { card, placement } = await publish(owner, cat.id);
    await spendFree(owner, card.id, cat.slug, 1);
    // The run started at 00:30 on 1 October in Istanbul — 30 September in UTC.
    await ctx.prisma.offerAllowanceGrant.update({
      where: { showcasePlacementId: placement.id },
      data: { validFrom: new Date('2026-09-30T21:30:00.000Z') },
    });

    const october = await report('?from=2026-10-01&to=2026-10-31&groupBy=month');
    expect(october.cohort.grants).toBe(1);
    expect(october.cohortByPeriod.map((row) => row.bucket)).toEqual(['2026-10']);

    const september = await report('?from=2026-09-01&to=2026-09-30');
    expect(september.cohort.grants).toBe(0);
    // The use happened today, outside September: the two clocks never mix.
    expect(september.usage.usages).toBe(0);

    const days = await report('?from=2026-09-30&to=2026-10-01&groupBy=day');
    expect(days.cohortByPeriod.map((row) => row.bucket)).toEqual(['2026-10-01']);
  });
});

// ── unplaced rights ──────────────────────────────────────────────────────────

describe('unplaced rights', () => {
  it('are shown apart and never added to the grant totals', async () => {
    const cat = await category();
    const owner = await provider(cat);
    const pkg = await createShowcasePackage(ctx.prisma, { freeOfferCount: 5 });
    await createShowcaseEntitlement(ctx, { providerId: owner.id, userId: owner.userId, packageId: pkg.id });
    const expired = await createShowcaseEntitlement(ctx, { providerId: owner.id, userId: owner.userId, packageId: pkg.id });
    await ctx.prisma.showcaseEntitlement.update({ where: { id: expired.entitlement.id }, data: { status: 'EXPIRED' } });

    const body = await report();
    expect(body.unplaced).toEqual({ pendingRights: 1, pendingFreeOffers: 5, expiredRights: 1, expiredFreeOffers: 5 });
    expect(body.cohort.defined).toBe(0);
    expect(body.byPackage).toHaveLength(1);
    expect(body.byPackage[0]).toMatchObject({
      package: { id: pkg.id },
      cohort: { defined: 0 },
      unplaced: { pendingRights: 1, pendingFreeOffers: 5 },
    });
  });
});
