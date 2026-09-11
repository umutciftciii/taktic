import { ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createDiscoverableProvider,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The package-first sale: a provider buys a right, not a run for a card.
 *
 * The card comes later and spends the right when it is approved; here the only
 * things that exist are a package, an acceptance of the terms in force, and a
 * purchase that names neither card nor version.
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

async function scenario() {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const pkg = await createShowcasePackage(ctx.prisma);
  return { category, user, profile, pkg, cookie: await loginAs(ctx.prisma, user.id) };
}

const checkout = (providerId: string, cookie: string, body: Record<string, unknown>) =>
  request(ctx.server)
    .post(`/providers/${providerId}/showcase/packages/checkout`)
    .set('Cookie', cookie)
    .send(body);

const MOCK_CARD = {
  cardholderName: 'Ayşe',
  cardNumber: '4111111111111111',
  expiryMonth: 12,
  expiryYear: 2030,
  cvv: '123',
};

describe('the package-first checkout', () => {
  it('refuses without an acceptance of the terms in force, and reports them', async () => {
    const { profile, pkg, cookie } = await scenario();

    const terms = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/packages/terms`)
      .set('Cookie', cookie)
      .expect(200);
    expect(terms.body).toMatchObject({ version: 'v1', accepted: false, acceptedAt: null });
    expect(typeof terms.body.text).toBe('string');

    const refused = await checkout(profile.id, cookie, { showcasePackageId: pkg.id });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED');
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });

  it('records the acceptance once, opens a card-less purchase, and reuses it while pending', async () => {
    const { profile, pkg, cookie } = await scenario();

    const first = await checkout(profile.id, cookie, {
      showcasePackageId: pkg.id,
      priceTermsAccepted: true,
      priceTermsVersion: 'v1',
    });
    expect(first.status).toBe(201);
    expect(first.body.checkout.reused).toBe(false);

    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: first.body.purchase.id },
    });
    expect(purchase.kind).toBe('SHOWCASE_PACKAGE');
    expect(purchase.showcaseCardId).toBeNull();
    expect(purchase.showcasePriceTermsAcceptanceId).toBeNull();
    expect(purchase.showcasePackageTermsAcceptanceId).not.toBeNull();
    expect(purchase.creditAmountSnapshot).toBe(0);
    expect(purchase.durationDaysSnapshot).toBe(30);

    // The second call no longer needs the checkbox: the provider already agreed.
    const second = await checkout(profile.id, cookie, { showcasePackageId: pkg.id });
    expect(second.status).toBe(201);
    expect(second.body.purchase.id).toBe(first.body.purchase.id);
    expect(second.body.checkout.reused).toBe(true);
    expect(
      await ctx.prisma.showcasePackageTermsAcceptance.count({ where: { providerId: profile.id } }),
    ).toBe(1);

    const terms = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/packages/terms`)
      .set('Cookie', cookie)
      .expect(200);
    expect(terms.body.accepted).toBe(true);
    expect(typeof terms.body.acceptedAt).toBe('string');
  });

  it('refuses an inactive package, a stale terms version, and every role but the owner', async () => {
    const { profile, cookie } = await scenario();
    const inactive = await createShowcasePackage(ctx.prisma, { isActive: false });
    expect(
      (
        await checkout(profile.id, cookie, {
          showcasePackageId: inactive.id,
          priceTermsAccepted: true,
          priceTermsVersion: 'v1',
        })
      ).status,
    ).toBe(404);

    const pkg = await createShowcasePackage(ctx.prisma);
    const stale = await checkout(profile.id, cookie, {
      showcasePackageId: pkg.id,
      priceTermsAccepted: true,
      priceTermsVersion: 'v0',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED');

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    expect(
      (
        await checkout(profile.id, adminCookie, {
          showcasePackageId: pkg.id,
          priceTermsAccepted: true,
          priceTermsVersion: 'v1',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(ctx.server)
          .post(`/providers/${profile.id}/showcase/packages/checkout`)
          .send({ showcasePackageId: pkg.id })
      ).status,
    ).toBe(401);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
    expect(await ctx.prisma.showcasePackageTermsAcceptance.count()).toBe(0);
  });

  it('settles through the mock form into one AVAILABLE right, and only one', async () => {
    const { profile, pkg, cookie } = await scenario();
    const opened = await checkout(profile.id, cookie, {
      showcasePackageId: pkg.id,
      priceTermsAccepted: true,
      priceTermsVersion: 'v1',
    });
    const purchaseId = opened.body.purchase.id as string;

    const paid = await request(ctx.server)
      .post(`/providers/${profile.id}/package-purchases/${purchaseId}/mock-pay`)
      .set('Cookie', cookie)
      .send(MOCK_CARD);
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe('PAID');

    const rights = await ctx.prisma.showcaseEntitlement.findMany({ where: { purchaseId } });
    expect(rights).toHaveLength(1);
    expect(rights[0]?.status).toBe('AVAILABLE');
    expect(await ctx.prisma.showcasePlacement.count()).toBe(0);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
    // No receipt template exists for a right; the return screen tells the provider.
    expect(ctx.notifications.sent).toHaveLength(0);

    const again = await request(ctx.server)
      .post(`/providers/${profile.id}/package-purchases/${purchaseId}/mock-pay`)
      .set('Cookie', cookie)
      .send(MOCK_CARD);
    expect(again.status).toBe(409);
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(1);

    const listed = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/entitlements`)
      .set('Cookie', cookie)
      .expect(200);
    expect(listed.body.available).toHaveLength(1);
    expect(listed.body.available[0]).toMatchObject({ durationDays: 30, allowedCardKind: null });
  });

  it('grants nothing when the mock payment is declined', async () => {
    const { profile, pkg, cookie } = await scenario();
    const opened = await checkout(profile.id, cookie, {
      showcasePackageId: pkg.id,
      priceTermsAccepted: true,
      priceTermsVersion: 'v1',
    });
    const declined = await request(ctx.server)
      .post(`/providers/${profile.id}/package-purchases/${opened.body.purchase.id}/mock-pay`)
      .set('Cookie', cookie)
      .send({ ...MOCK_CARD, cardNumber: '4111111111110000' });
    expect(declined.body.status).toBe('FAILED');
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(0);
  });
});
