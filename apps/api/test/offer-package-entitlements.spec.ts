import {
  OfferEntitlementSource,
  OfferPackageType,
  OfferStatus,
  ProviderEntitlementStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createEntitlement,
  createOfferPackage,
  createTestApp,
  createUser,
  currentCreditBalance,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  type TestContext,
} from './harness';
import {
  PACKAGE_PERIOD_DAYS,
  nextPeriodStart,
  periodEnd,
} from '../src/modules/entitlements/entitlement-period';

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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A provider that can actually send an offer — approved, bound to the category,
 * in the request's area — with a category price and no credits unless asked.
 */
async function offerFixture(options: { categoryCost?: number; credits?: number } = {}) {
  const category = await createCategory(ctx.prisma, 'Klima', {
    offerCreditCost: options.categoryCost ?? 3,
  });
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId: category.id,
  });
  const cookie = await loginAs(ctx.prisma, ownerUser.id);

  if (options.credits) {
    await grantCredits(ctx.prisma, provider.id, options.credits);
  }

  return { category, ownerUser, provider, cookie };
}

function offerUrl(providerId: string, requestId: string) {
  return `/providers/${providerId}/requests/${requestId}/offers`;
}

async function sendOffer(
  cookie: string,
  providerId: string,
  requestId: string,
  overrides: Record<string, unknown> = {},
) {
  return request(ctx.server)
    .post(offerUrl(providerId, requestId))
    .set('Cookie', cookie)
    .send(offerPayload(overrides));
}

describe('period arithmetic', () => {
  it('runs 30×24h from the payment instant, never a calendar month', () => {
    // The example from the product rule: bought on 27 September, valid to
    // 27 October.
    const paidAt = new Date('2026-09-27T09:15:00.000Z');
    expect(periodEnd(paidAt).toISOString()).toBe('2026-10-27T09:15:00.000Z');

    // A 31-day month is where calendar arithmetic would disagree: "one month
    // after 31 January" has no answer, and thirty days does.
    expect(periodEnd(new Date('2026-01-31T00:00:00.000Z')).toISOString()).toBe(
      '2026-03-02T00:00:00.000Z',
    );

    // And a 31-day month the other way: 30 days from 2 August is 1 September,
    // not 2 September.
    expect(periodEnd(new Date('2026-08-02T00:00:00.000Z')).toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });

  it('starts a renewal at the previous end, or at the payment when that is later', () => {
    const previousEnd = new Date('2026-10-27T09:15:00.000Z');

    // Paid before the period ran out: no gap, no overlap.
    expect(
      nextPeriodStart(new Date('2026-10-20T00:00:00.000Z'), previousEnd).toISOString(),
    ).toBe(previousEnd.toISOString());

    // Paid three days late: the new period starts when the money arrived, so
    // the provider is not sold days that had already elapsed.
    const late = new Date('2026-10-30T00:00:00.000Z');
    expect(nextPeriodStart(late, previousEnd).toISOString()).toBe(late.toISOString());

    // A first purchase has nothing to chain onto.
    expect(nextPeriodStart(late, null).toISOString()).toBe(late.toISOString());
  });
});

describe('entitlement priority', () => {
  it('spends an unlimited period before quota and before credits', async () => {
    const { category, provider, cookie } = await offerFixture({ categoryCost: 3, credits: 50 });
    const unlimitedPackage = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.CATEGORY_UNLIMITED,
      scopeCategoryIds: [category.id],
    });
    const quotaPackage = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
    });
    await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: unlimitedPackage.id,
      type: OfferPackageType.CATEGORY_UNLIMITED,
      scopeCategoryIds: [category.id],
    });
    const quota = await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: quotaPackage.id,
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 20,
    });

    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const response = await sendOffer(cookie, provider.id, serviceRequest.id);

    expect(response.status).toBe(201);

    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(offer.entitlementSource).toBe(OfferEntitlementSource.UNLIMITED);
    // Neither of the two metered rights was touched.
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(50);
    const quotaAfter = await ctx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: quota.id },
    });
    expect(quotaAfter.remainingQuota).toBe(20);
  });

  it('spends quota before credits, atomically', async () => {
    const { category, provider, cookie } = await offerFixture({ categoryCost: 3, credits: 50 });
    const quotaPackage = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
    });
    const quota = await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: quotaPackage.id,
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 10,
    });

    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const response = await sendOffer(cookie, provider.id, serviceRequest.id);

    expect(response.status).toBe(201);
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(offer.entitlementSource).toBe(OfferEntitlementSource.MONTHLY_QUOTA);
    expect(offer.entitlementId).toBe(quota.id);
    expect(offer.creditSpentTransactionId).toBeNull();

    const quotaAfter = await ctx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: quota.id },
    });
    expect(quotaAfter.remainingQuota).toBe(7);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(50);
  });

  it('falls back to one-time credits when no period covers the request', async () => {
    const { category, provider, cookie } = await offerFixture({ categoryCost: 3, credits: 50 });
    const otherCategory = await createCategory(ctx.prisma, 'Boya', { offerCreditCost: 3 });
    const unlimitedPackage = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.CATEGORY_UNLIMITED,
      scopeCategoryIds: [otherCategory.id],
    });
    await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: unlimitedPackage.id,
      type: OfferPackageType.CATEGORY_UNLIMITED,
      // In scope for a category this request is not in.
      scopeCategoryIds: [otherCategory.id],
    });

    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const response = await sendOffer(cookie, provider.id, serviceRequest.id);

    expect(response.status).toBe(201);
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(offer.entitlementSource).toBe(OfferEntitlementSource.ONE_TIME_CREDIT);
    expect(offer.creditSpentTransactionId).not.toBeNull();
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(47);
  });

  it('answers the unchanged 402 when nothing can pay', async () => {
    const { category, provider, cookie } = await offerFixture({ categoryCost: 3 });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });

    const response = await sendOffer(cookie, provider.id, serviceRequest.id);

    expect(response.status).toBe(402);
    expect(await ctx.prisma.offer.count()).toBe(0);
  });

  it('ignores an expired period and a period that has not started', async () => {
    const { category, provider, cookie } = await offerFixture({ categoryCost: 3, credits: 10 });
    const quotaPackage = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
    });

    // Yesterday's period, and next month's.
    await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: quotaPackage.id,
      type: OfferPackageType.MONTHLY_QUOTA,
      startAt: new Date(Date.now() - 40 * DAY_MS),
      endAt: new Date(Date.now() - DAY_MS),
    });
    await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: quotaPackage.id,
      type: OfferPackageType.MONTHLY_QUOTA,
      startAt: new Date(Date.now() + DAY_MS),
      endAt: new Date(Date.now() + 31 * DAY_MS),
    });

    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const response = await sendOffer(cookie, provider.id, serviceRequest.id);

    expect(response.status).toBe(201);
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(offer.entitlementSource).toBe(OfferEntitlementSource.ONE_TIME_CREDIT);
  });

  it('does not use a period belonging to another provider', async () => {
    const { category, provider, cookie } = await offerFixture({ categoryCost: 3, credits: 10 });
    const otherProvider = await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
    });
    const quotaPackage = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
    });
    await createEntitlement(ctx.prisma, {
      providerId: otherProvider.id,
      packageId: quotaPackage.id,
      type: OfferPackageType.MONTHLY_QUOTA,
    });

    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const response = await sendOffer(cookie, provider.id, serviceRequest.id);

    expect(response.status).toBe(201);
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(offer.entitlementSource).toBe(OfferEntitlementSource.ONE_TIME_CREDIT);
  });
});

describe('quota consumption under concurrency', () => {
  it('never lets two parallel offers spend the same last credit', async () => {
    const { category, provider, cookie } = await offerFixture({ categoryCost: 5 });
    const quotaPackage = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
    });
    const quota = await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: quotaPackage.id,
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 10,
      // Exactly one offer's worth left, and no credit balance behind it.
      remainingQuota: 5,
    });

    const first = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const second = await createApprovedRequest(ctx.prisma, { categoryId: category.id });

    const [a, b] = await Promise.all([
      sendOffer(cookie, provider.id, first.id),
      sendOffer(cookie, provider.id, second.id),
    ]);

    const statuses = [a.status, b.status].sort();
    // One offer, one refusal. The refusal is either the 402 the resolver
    // raises or the 409 a Serializable write conflict produces; both mean
    // "not granted", and neither may be a second offer.
    expect(statuses[0]).toBe(201);
    expect([402, 409]).toContain(statuses[1]);

    const quotaAfter = await ctx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: quota.id },
    });
    expect(quotaAfter.remainingQuota).toBe(0);
    expect(await ctx.prisma.offer.count({ where: { providerId: provider.id } })).toBe(1);
  });

  it('leaves the quota untouched when the offer itself is refused', async () => {
    const { category, provider, cookie } = await offerFixture({ categoryCost: 5 });
    const quotaPackage = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
    });
    const quota = await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: quotaPackage.id,
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 10,
    });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });

    // A second offer on the same request is refused by the one-offer-per-request
    // rule, after the resolver has already chosen a right.
    expect((await sendOffer(cookie, provider.id, serviceRequest.id)).status).toBe(201);
    expect((await sendOffer(cookie, provider.id, serviceRequest.id)).status).toBe(409);

    const quotaAfter = await ctx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: quota.id },
    });
    expect(quotaAfter.remainingQuota).toBe(5);
  });
});

describe('unlimited scope and category status', () => {
  it('covers a leaf reached through a group in the snapshot', async () => {
    const group = await createCategory(ctx.prisma, 'Grup', { kind: 'GROUP' as never });
    const leaf = await createCategory(ctx.prisma, 'Yaprak', {
      offerCreditCost: 4,
      parentId: group.id,
    });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: ownerUser.id,
      categoryId: leaf.id,
    });
    const cookie = await loginAs(ctx.prisma, ownerUser.id);

    const pkg = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.CATEGORY_UNLIMITED,
      scopeCategoryIds: [group.id],
    });
    const entitlement = await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: pkg.id,
      type: OfferPackageType.CATEGORY_UNLIMITED,
      scopeCategoryIds: [group.id],
    });
    // The expansion the settlement path performs, written by hand here because
    // this case is about matching rather than about settlement.
    await ctx.prisma.providerPackageEntitlementScope.create({
      data: {
        entitlementId: entitlement.id,
        categoryId: leaf.id,
        categoryNameSnapshot: leaf.name,
        categoryKindSnapshot: leaf.kind,
        selected: false,
      },
    });

    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: leaf.id });
    const response = await sendOffer(cookie, provider.id, serviceRequest.id);

    expect(response.status).toBe(201);
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(offer.entitlementSource).toBe(OfferEntitlementSource.UNLIMITED);
  });

  it('does not widen a bought period when the package scope is edited afterwards', async () => {
    const { category, provider, cookie } = await offerFixture({ categoryCost: 3, credits: 10 });
    const later = await createCategory(ctx.prisma, 'Sonradan', { offerCreditCost: 3 });
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: later.id },
    });

    const pkg = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.CATEGORY_UNLIMITED,
      scopeCategoryIds: [category.id],
    });
    await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: pkg.id,
      type: OfferPackageType.CATEGORY_UNLIMITED,
      scopeCategoryIds: [category.id],
    });

    // The package definition gains a category after the period was sold.
    await ctx.prisma.offerPackageScopeCategory.create({
      data: { packageId: pkg.id, categoryId: later.id },
    });

    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: later.id });
    const response = await sendOffer(cookie, provider.id, serviceRequest.id);

    expect(response.status).toBe(201);
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: response.body.id } });
    // The period did not stretch: the credit balance paid instead.
    expect(offer.entitlementSource).toBe(OfferEntitlementSource.ONE_TIME_CREDIT);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(7);
  });

  it('refuses an offer on an INACTIVE category even inside an unlimited scope', async () => {
    const { category, provider, cookie } = await offerFixture({ categoryCost: 3 });
    const pkg = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.CATEGORY_UNLIMITED,
      scopeCategoryIds: [category.id],
    });
    await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: pkg.id,
      type: OfferPackageType.CATEGORY_UNLIMITED,
      scopeCategoryIds: [category.id],
    });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });

    await ctx.prisma.serviceCategory.update({
      where: { id: category.id },
      data: { status: 'INACTIVE', isActive: false },
    });

    const response = await sendOffer(cookie, provider.id, serviceRequest.id);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CATEGORY_INACTIVE');
    expect(await ctx.prisma.offer.count()).toBe(0);
  });

  it('enforces the package daily offer limit without silently charging credits', async () => {
    const { category, provider, cookie } = await offerFixture({ categoryCost: 3, credits: 50 });
    const pkg = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.CATEGORY_UNLIMITED,
      dailyOfferLimit: 1,
      scopeCategoryIds: [category.id],
    });
    await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: pkg.id,
      type: OfferPackageType.CATEGORY_UNLIMITED,
      dailyOfferLimit: 1,
      scopeCategoryIds: [category.id],
    });

    const first = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const second = await createApprovedRequest(ctx.prisma, { categoryId: category.id });

    expect((await sendOffer(cookie, provider.id, first.id)).status).toBe(201);

    const blocked = await sendOffer(cookie, provider.id, second.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('UNLIMITED_DAILY_LIMIT_REACHED');
    // The refusal did not quietly become a credit purchase.
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(50);
    expect(await ctx.prisma.offer.count({ where: { providerId: provider.id } })).toBe(1);
  });
});

describe('withdrawal and refunds', () => {
  it('does not give quota back when the provider withdraws the offer', async () => {
    const { category, provider, cookie } = await offerFixture({ categoryCost: 4 });
    const quotaPackage = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
    });
    const quota = await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: quotaPackage.id,
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 20,
    });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });

    const created = await sendOffer(cookie, provider.id, serviceRequest.id);
    expect(created.status).toBe(201);

    const withdrawn = await request(ctx.server)
      .post(`/providers/${provider.id}/offers/${created.body.id}/withdraw`)
      .set('Cookie', cookie)
      .send({});
    expect(withdrawn.status).toBe(201);
    expect(withdrawn.body.status).toBe(OfferStatus.WITHDRAWN);

    // Exactly the rule one-time credits already follow: a withdrawn offer is
    // not refunded.
    const quotaAfter = await ctx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: quota.id },
    });
    expect(quotaAfter.remainingQuota).toBe(16);
  });
});

describe('period sweeping', () => {
  it('marks a period expired once its clock has run out', async () => {
    const provider = await createDiscoverableProvider(ctx.prisma, {
      categoryId: (await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 })).id,
    });
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.MONTHLY_QUOTA });
    const entitlement = await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: pkg.id,
      type: OfferPackageType.MONTHLY_QUOTA,
      startAt: new Date(Date.now() - 31 * DAY_MS),
      endAt: new Date(Date.now() - DAY_MS),
    });

    const { EntitlementsService } = await import('../src/modules/entitlements/entitlements.service');
    const service = ctx.app.get(EntitlementsService);
    const result = await service.expireDuePeriods();

    expect(result.expired).toBeGreaterThanOrEqual(1);
    const after = await ctx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    expect(after.status).toBe(ProviderEntitlementStatus.EXPIRED);
  });
});

describe('the period length the API advertises', () => {
  it('is thirty days, everywhere it is stated', async () => {
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: ownerUser.id,
      categoryId: (await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 })).id,
    });
    const cookie = await loginAs(ctx.prisma, ownerUser.id);

    const catalogue = await request(ctx.server)
      .get(`/providers/${provider.id}/offer-packages`)
      .set('Cookie', cookie);

    expect(catalogue.status).toBe(200);
    expect(catalogue.body.periodDays).toBe(PACKAGE_PERIOD_DAYS);
    expect(PACKAGE_PERIOD_DAYS).toBe(30);
  });
});
