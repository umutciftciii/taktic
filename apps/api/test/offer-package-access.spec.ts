import { OfferPackageType, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createEntitlement,
  createOfferPackage,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

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

/** A provider holding one unlimited period, plus the accounts around them. */
async function fixture() {
  const category = await createCategory(ctx.prisma, 'Klima', {
    offerCreditCost: 3,
    unlimitedPackageEligible: true,
  });
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, { userId: ownerUser.id });
  const pkg = await createOfferPackage(ctx.prisma, {
    type: OfferPackageType.CATEGORY_UNLIMITED,
    dailyOfferLimit: 4,
    scopeCategoryIds: [category.id],
  });
  const entitlement = await createEntitlement(ctx.prisma, {
    providerId: provider.id,
    packageId: pkg.id,
    type: OfferPackageType.CATEGORY_UNLIMITED,
    dailyOfferLimit: 4,
    paymentMethodReference: 'pm_should_never_be_returned',
    scopeCategoryIds: [category.id],
  });

  const otherUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  await createProviderProfile(ctx.prisma, { userId: otherUser.id });
  const customerUser = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const adminUser = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

  return {
    category,
    provider,
    pkg,
    entitlement,
    ownerCookie: await loginAs(ctx.prisma, ownerUser.id),
    otherProviderCookie: await loginAs(ctx.prisma, otherUser.id),
    customerCookie: await loginAs(ctx.prisma, customerUser.id),
    adminCookie: await loginAs(ctx.prisma, adminUser.id),
  };
}

describe('who may read a provider’s packages', () => {
  it('answers 401 to an anonymous caller on every package route', async () => {
    const { provider, entitlement } = await fixture();

    const calls: (() => request.Test)[] = [
      () => request(ctx.server).get(`/providers/${provider.id}/entitlements`),
      () => request(ctx.server).get(`/providers/${provider.id}/offer-packages`),
      () =>
        request(ctx.server)
          .patch(`/providers/${provider.id}/entitlements/${entitlement.id}/auto-renew`)
          .send({ enabled: false }),
      () =>
        request(ctx.server).post(
          `/providers/${provider.id}/entitlements/${entitlement.id}/cancel`,
        ),
      () => request(ctx.server).get('/admin/offer-packages'),
    ];

    for (const call of calls) {
      expect((await call()).status).toBe(401);
    }
  });

  it('answers 403 to a customer and to a different provider', async () => {
    const { provider, entitlement, customerCookie, otherProviderCookie } = await fixture();

    for (const cookie of [customerCookie, otherProviderCookie]) {
      expect(
        (
          await request(ctx.server)
            .get(`/providers/${provider.id}/entitlements`)
            .set('Cookie', cookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(ctx.server)
            .get(`/providers/${provider.id}/offer-packages`)
            .set('Cookie', cookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(ctx.server)
            .post(`/providers/${provider.id}/entitlements/${entitlement.id}/cancel`)
            .set('Cookie', cookie)
        ).status,
      ).toBe(403);
    }
  });

  it('refuses the admin package screens to everyone but a SUPER_ADMIN', async () => {
    const { ownerCookie, customerCookie, adminCookie } = await fixture();

    for (const cookie of [ownerCookie, customerCookie]) {
      expect(
        (await request(ctx.server).get('/admin/offer-packages').set('Cookie', cookie)).status,
      ).toBe(403);
    }

    expect(
      (await request(ctx.server).get('/admin/offer-packages').set('Cookie', adminCookie)).status,
    ).toBe(200);
  });

  it('lets an admin read the audit trail without any payment credential', async () => {
    const { provider, entitlement, adminCookie } = await fixture();
    await ctx.prisma.packageRenewalAttempt.create({
      data: {
        entitlementId: entitlement.id,
        periodIndex: 1,
        status: 'FAILED',
        failureCode: 'PAYMENT_DECLINED',
        paymentProvider: 'mock',
        providerTransactionRef: 'txn-safe-reference',
      },
    });

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}/entitlements`)
      .set('Cookie', adminCookie)
      .expect(200);

    const [item] = response.body.entitlements;
    // The reference an operator needs to find the transaction on the provider's
    // side is present…
    expect(item.renewalAttempts[0].providerTransactionRef).toBe('txn-safe-reference');
    expect(item.renewalAttempts[0].failureCode).toBe('PAYMENT_DECLINED');
    // …and the stored payment method is a boolean, never the token.
    expect(item.paymentMethodOnFile).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('pm_should_never_be_returned');
  });

  it('never returns a stored payment reference to the provider either', async () => {
    const { provider, ownerCookie } = await fixture();

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}/entitlements`)
      .set('Cookie', ownerCookie)
      .expect(200);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('pm_should_never_be_returned');
    expect(body).not.toContain('paymentMethodReference');
    // The provider's own view carries what the screen actually renders.
    const [item] = response.body.entitlements;
    expect(item.type).toBe(OfferPackageType.CATEGORY_UNLIMITED);
    expect(item.periodDays).toBe(30);
    expect(item.dailyOfferLimit).toBe(4);
    expect(item.dailyOfferUsed).toBe(0);
    expect(item.scope).toHaveLength(1);
  });

  it('lets a provider change only their own auto-renew, never an admin on their behalf', async () => {
    const { provider, entitlement, adminCookie } = await fixture();

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/entitlements/${entitlement.id}/cancel`)
      .set('Cookie', adminCookie);

    // The guard lets an admin read; the handler refuses to act as the account.
    expect(response.status).toBe(403);
  });
});

describe('what the public catalogue may say', () => {
  it('keeps period packages off the unauthenticated credit-package listing', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      offerCreditCost: 3,
      unlimitedPackageEligible: true,
    });
    const oneTime = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.ONE_TIME_CREDITS,
      creditAmount: 25,
    });
    const quota = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 40,
    });
    const unlimited = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.CATEGORY_UNLIMITED,
      scopeCategoryIds: [category.id],
    });

    const response = await request(ctx.server).get('/credit-packages').expect(200);
    const ids = response.body.map((item: { id: string }) => item.id);

    expect(ids).toContain(oneTime.id);
    expect(ids).not.toContain(quota.id);
    expect(ids).not.toContain(unlimited.id);
    // The response shape is the one it has always been: no quota size, no
    // period length, no daily cap and no scope reaches an unauthenticated
    // caller — not even as a null.
    expect(Object.keys(response.body[0]).sort()).toEqual([
      'createdAt',
      'creditAmount',
      'currency',
      'description',
      'id',
      'isActive',
      'name',
      'priceAmount',
      'slug',
      'sortOrder',
      'updatedAt',
    ]);
  });

  it('keeps the unlimited-eligibility flag off the public category listing', async () => {
    await createCategory(ctx.prisma, 'Klima', {
      offerCreditCost: 3,
      unlimitedPackageEligible: true,
    });

    const response = await request(ctx.server).get('/categories').expect(200);

    expect(JSON.stringify(response.body)).not.toContain('unlimitedPackageEligible');
  });
});

describe('admin package management', () => {
  async function adminCookie() {
    const adminUser = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    return loginAs(ctx.prisma, adminUser.id);
  }

  it('creates a monthly quota package with a server-chosen 30-day period', async () => {
    const cookie = await adminCookie();

    const response = await request(ctx.server)
      .post('/credit-packages')
      .set('Cookie', cookie)
      .send({
        name: 'Aylık 40 kota',
        slug: 'aylik-40-kota',
        type: OfferPackageType.MONTHLY_QUOTA,
        quotaCredits: 40,
        priceAmount: 149_900,
      });

    expect(response.status).toBe(201);
    expect(response.body.type).toBe(OfferPackageType.MONTHLY_QUOTA);
    expect(response.body.quotaCredits).toBe(40);
    expect(response.body.periodDays).toBe(30);
    expect(response.body.creditAmount).toBe(0);
    expect(response.body.dailyOfferLimit).toBeNull();
  });

  it('refuses an unlimited scope that names a category nobody made eligible', async () => {
    const cookie = await adminCookie();
    const notEligible = await createCategory(ctx.prisma, 'Regüle', { offerCreditCost: 5 });

    const response = await request(ctx.server)
      .post('/credit-packages')
      .set('Cookie', cookie)
      .send({
        name: 'Limitsiz',
        slug: 'limitsiz-regule',
        type: OfferPackageType.CATEGORY_UNLIMITED,
        priceAmount: 299_900,
        scopeCategoryIds: [notEligible.id],
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('limitsiz paket kapsamına alınamaz');
    expect(await ctx.prisma.offerCreditPackage.count()).toBe(0);
  });

  it('refuses an INACTIVE category even when it was marked eligible', async () => {
    const cookie = await adminCookie();
    const inactive = await createCategory(ctx.prisma, 'Kapalı', {
      offerCreditCost: 5,
      isActive: false,
      unlimitedPackageEligible: true,
    });

    const response = await request(ctx.server)
      .post('/credit-packages')
      .set('Cookie', cookie)
      .send({
        name: 'Limitsiz',
        slug: 'limitsiz-kapali',
        type: OfferPackageType.CATEGORY_UNLIMITED,
        priceAmount: 299_900,
        scopeCategoryIds: [inactive.id],
      });

    expect(response.status).toBe(400);
  });

  it('requires a scope for an unlimited package and forbids one everywhere else', async () => {
    const cookie = await adminCookie();
    const eligible = await createCategory(ctx.prisma, 'Klima', {
      offerCreditCost: 3,
      unlimitedPackageEligible: true,
    });

    const noScope = await request(ctx.server)
      .post('/credit-packages')
      .set('Cookie', cookie)
      .send({
        name: 'Kapsamsız limitsiz',
        slug: 'kapsamsiz-limitsiz',
        type: OfferPackageType.CATEGORY_UNLIMITED,
        priceAmount: 299_900,
      });
    expect(noScope.status).toBe(400);

    const scopedOneTime = await request(ctx.server)
      .post('/credit-packages')
      .set('Cookie', cookie)
      .send({
        name: 'Kapsamlı kredi',
        slug: 'kapsamli-kredi',
        creditAmount: 10,
        priceAmount: 99_900,
        scopeCategoryIds: [eligible.id],
      });
    expect(scopedOneTime.status).toBe(400);
  });

  it('creates an unlimited package and lists its scope back', async () => {
    const cookie = await adminCookie();
    const eligible = await createCategory(ctx.prisma, 'Klima', {
      offerCreditCost: 3,
      unlimitedPackageEligible: true,
    });

    const created = await request(ctx.server)
      .post('/credit-packages')
      .set('Cookie', cookie)
      .send({
        name: 'Klima limitsiz',
        slug: 'klima-limitsiz',
        type: OfferPackageType.CATEGORY_UNLIMITED,
        priceAmount: 299_900,
        dailyOfferLimit: 8,
        scopeCategoryIds: [eligible.id],
      })
      .expect(201);

    expect(created.body.dailyOfferLimit).toBe(8);

    const listed = await request(ctx.server)
      .get('/admin/offer-packages')
      .set('Cookie', cookie)
      .expect(200);

    const found = listed.body.find((item: { id: string }) => item.id === created.body.id);
    expect(found.scopeCategories).toHaveLength(1);
    expect(found.scopeCategories[0].category.id).toBe(eligible.id);
  });

  it('leaves a sold period untouched when the package price and scope change', async () => {
    const cookie = await adminCookie();
    const eligible = await createCategory(ctx.prisma, 'Klima', {
      offerCreditCost: 3,
      unlimitedPackageEligible: true,
    });
    const other = await createCategory(ctx.prisma, 'Boya', {
      offerCreditCost: 3,
      unlimitedPackageEligible: true,
    });
    const pkg = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.CATEGORY_UNLIMITED,
      priceAmount: 299_900,
      scopeCategoryIds: [eligible.id],
    });
    const provider = await createProviderProfile(ctx.prisma, {});
    const entitlement = await createEntitlement(ctx.prisma, {
      providerId: provider.id,
      packageId: pkg.id,
      type: OfferPackageType.CATEGORY_UNLIMITED,
      scopeCategoryIds: [eligible.id],
    });

    await request(ctx.server)
      .patch(`/credit-packages/${pkg.id}`)
      .set('Cookie', cookie)
      .send({ priceAmount: 999_900, scopeCategoryIds: [other.id], dailyOfferLimit: 1 })
      .expect(200);

    const after = await ctx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
      include: { scopes: true },
    });
    expect(after.priceAmountSnapshot).toBe(100_000);
    expect(after.dailyOfferLimitSnapshot).toBeNull();
    expect(after.scopes.map((scope) => scope.categoryId)).toEqual([eligible.id]);
  });

  it('does not let a package change what it sells', async () => {
    const cookie = await adminCookie();
    const pkg = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.ONE_TIME_CREDITS,
      creditAmount: 10,
    });

    await request(ctx.server)
      .patch(`/credit-packages/${pkg.id}`)
      .set('Cookie', cookie)
      .send({ type: OfferPackageType.MONTHLY_QUOTA, quotaCredits: 50 })
      .expect(400);

    const after = await ctx.prisma.offerCreditPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    expect(after.type).toBe(OfferPackageType.ONE_TIME_CREDITS);
    expect(after.creditAmount).toBe(10);
  });
});
