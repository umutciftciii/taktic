import { OfferPackageType, PackagePurchaseStatus, ServiceCategoryKind, UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createOfferPackage,
  createShowcasePackage,
  createTestApp,
  createUser,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * One money rail, two catalogues — and the constraints that keep them honest.
 *
 * The design decision under test: vitrin purchases live on `PackagePurchase`
 * rather than on a table of their own. That is not convenience. `providerOrderId`
 * and `paymentReference` are unique **on this table**, and that uniqueness is
 * the whole of the guarantee that one settled payment-provider order settles one
 * purchase. Split across two tables, one order could close a row in each and no
 * constraint anywhere would see it — which is the last case in this file.
 *
 * Everything else here is the discriminator holding its shape. Each case goes at
 * the database rather than the endpoint, because a CHECK is what protects a
 * future code path that forgets to branch; an application rule protects only the
 * paths that exist today.
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
  });
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
    providerId: profile.id,
    categoryId: category.id,
  });
  const showcasePackage = await createShowcasePackage(ctx.prisma);
  const offerPackage = await createOfferPackage(ctx.prisma);

  return { category, profile, card, version, showcasePackage, offerPackage };
}

describe('the kind discriminator', () => {
  it('keeps every existing purchase an offer purchase, with its package intact', async () => {
    const { profile, offerPackage } = await scenario();

    // The column's default is the whole of its backfill: a row written without
    // naming a kind means exactly what every row in this table meant before the
    // column existed.
    const purchase = await ctx.prisma.packagePurchase.create({
      data: {
        providerId: profile.id,
        packageId: offerPackage.id,
        creditAmountSnapshot: 10,
        priceAmountSnapshot: 10_000,
        currencySnapshot: 'TRY',
        packageNameSnapshot: offerPackage.name,
      },
    });

    expect(purchase.kind).toBe('OFFER_PACKAGE');
    expect(purchase.packageId).toBe(offerPackage.id);
    expect(purchase.showcasePackageId).toBeNull();
    expect(purchase.durationDaysSnapshot).toBeNull();
  });

  it('refuses an offer purchase that also names a vitrin package', async () => {
    const { profile, offerPackage, showcasePackage } = await scenario();

    await expect(
      ctx.prisma.packagePurchase.create({
        data: {
          providerId: profile.id,
          packageId: offerPackage.id,
          showcasePackageId: showcasePackage.id,
          creditAmountSnapshot: 10,
          priceAmountSnapshot: 10_000,
          currencySnapshot: 'TRY',
          packageNameSnapshot: offerPackage.name,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a vitrin purchase that names an offer package', async () => {
    const { profile, offerPackage, showcasePackage, card, version } = await scenario();

    await expect(
      ctx.prisma.packagePurchase.create({
        data: {
          providerId: profile.id,
          kind: 'SHOWCASE_PACKAGE',
          packageId: offerPackage.id,
          showcasePackageId: showcasePackage.id,
          showcaseCardId: card.id,
          showcaseCardVersionId: version.id,
          durationDaysSnapshot: 30,
          creditAmountSnapshot: 0,
          priceAmountSnapshot: 49_900,
          currencySnapshot: 'TRY',
          packageNameSnapshot: showcasePackage.name,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a vitrin purchase with no card behind it', async () => {
    const { profile, showcasePackage } = await scenario();

    await expect(
      ctx.prisma.packagePurchase.create({
        data: {
          providerId: profile.id,
          kind: 'SHOWCASE_PACKAGE',
          showcasePackageId: showcasePackage.id,
          creditAmountSnapshot: 0,
          priceAmountSnapshot: 49_900,
          currencySnapshot: 'TRY',
          packageNameSnapshot: showcasePackage.name,
        },
      }),
    ).rejects.toThrow();
  });

  /**
   * The constraint that matters most.
   *
   * A vitrin purchase sells visibility and may never load an offer-credit
   * balance. If a settlement path is ever edited and the branch is missed, this
   * is what turns the mistake into a loud failure rather than a provider quietly
   * receiving credits nobody sold them.
   */
  it('refuses a vitrin purchase that carries credit', async () => {
    const { profile, showcasePackage, card, version } = await scenario();

    await expect(
      ctx.prisma.packagePurchase.create({
        data: {
          providerId: profile.id,
          kind: 'SHOWCASE_PACKAGE',
          showcasePackageId: showcasePackage.id,
          showcaseCardId: card.id,
          showcaseCardVersionId: version.id,
          durationDaysSnapshot: 30,
          creditAmountSnapshot: 25,
          priceAmountSnapshot: 49_900,
          currencySnapshot: 'TRY',
          packageNameSnapshot: showcasePackage.name,
        },
      }),
    ).rejects.toThrow();
  });

  /**
   * One provider order settles one purchase — across both catalogues.
   *
   * This is the case a separate `ShowcasePurchase` table would have made
   * impossible to catch. The uniqueness is on this table, so a Lemon order that
   * already closed a credit purchase cannot also close a vitrin one, and the
   * database says so rather than the application remembering to check.
   */
  it('refuses one provider order settling both an offer purchase and a vitrin one', async () => {
    const { profile, offerPackage, showcasePackage, card, version } = await scenario();
    const orderId = 'lemon-order-shared-1';

    await ctx.prisma.packagePurchase.create({
      data: {
        providerId: profile.id,
        packageId: offerPackage.id,
        creditAmountSnapshot: 10,
        priceAmountSnapshot: 10_000,
        currencySnapshot: 'TRY',
        packageNameSnapshot: offerPackage.name,
        status: PackagePurchaseStatus.PAID,
        paidAt: new Date(),
        providerOrderId: orderId,
      },
    });

    await expect(
      ctx.prisma.packagePurchase.create({
        data: {
          providerId: profile.id,
          kind: 'SHOWCASE_PACKAGE',
          showcasePackageId: showcasePackage.id,
          showcaseCardId: card.id,
          showcaseCardVersionId: version.id,
          durationDaysSnapshot: 30,
          creditAmountSnapshot: 0,
          priceAmountSnapshot: 49_900,
          currencySnapshot: 'TRY',
          packageNameSnapshot: showcasePackage.name,
          status: PackagePurchaseStatus.PAID,
          paidAt: new Date(),
          providerOrderId: orderId,
        },
      }),
    ).rejects.toThrow();
  });

  it('leaves the offer package catalogue behaving exactly as it did', async () => {
    const { profile } = await scenario();
    const monthly = await createOfferPackage(ctx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
    });

    const purchase = await ctx.prisma.packagePurchase.create({
      data: {
        providerId: profile.id,
        packageId: monthly.id,
        creditAmountSnapshot: 0,
        priceAmountSnapshot: monthly.priceAmount,
        currencySnapshot: 'TRY',
        packageNameSnapshot: monthly.name,
      },
      include: { package: true },
    });

    expect(purchase.kind).toBe('OFFER_PACKAGE');
    expect(purchase.package?.type).toBe(OfferPackageType.MONTHLY_QUOTA);
  });
});
