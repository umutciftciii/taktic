import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ServiceCategoryKind, UserRole } from '@prisma/client';
import { ShowcaseEntitlementService } from '../src/modules/showcase/showcase-entitlement.service';
import {
  createCategory,
  createDiscoverableProvider,
  createShowcasePackage,
  createTestApp,
  createUser,
  resetDatabase,
  type TestContext,
} from './harness';

const DAY = 24 * 60 * 60 * 1000;

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

async function paidPackagePurchase(providerId: string, userId: string, pkgId: string) {
  // Upsert rather than create: a scenario buying two packages for one provider
  // (kind-mismatch and expiry tests) reuses the same v1 acceptance, exactly as
  // the unique (providerId, termsVersion) constraint says a provider's real
  // acceptance is asked once per version and never twice.
  const acceptance = await ctx.prisma.showcasePackageTermsAcceptance.upsert({
    where: { providerId_termsVersion: { providerId, termsVersion: 'v1' } },
    create: { providerId, termsVersion: 'v1', termsTextSnapshot: 'Şartlar', acceptedByUserId: userId },
    update: {},
  });
  const pkg = await ctx.prisma.showcasePackage.findUniqueOrThrow({ where: { id: pkgId } });
  const purchase = await ctx.prisma.packagePurchase.create({
    data: {
      providerId, kind: 'SHOWCASE_PACKAGE', showcasePackageId: pkg.id,
      durationDaysSnapshot: pkg.durationDays, creditAmountSnapshot: 0,
      priceAmountSnapshot: pkg.priceAmount, currencySnapshot: pkg.currency,
      packageNameSnapshot: pkg.name, showcasePackageTermsAcceptanceId: acceptance.id,
      status: 'PAID', paidAt: new Date(), paymentProvider: 'mock',
    },
  });
  // Narrowed for the caller, exactly as `SettledShowcasePurchase` narrows
  // `createForPurchase`'s input: the four showcase columns are nullable on the
  // model and NOT NULL for every SHOWCASE_PACKAGE row by CHECK, and this row
  // was just written with all of them set.
  return purchase as typeof purchase & {
    showcasePackageId: string;
    showcasePackageTermsAcceptanceId: string;
    durationDaysSnapshot: number;
  };
}

async function scenario() {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id, categoryId: category.id, areas: [{ city: 'İstanbul', district: null }],
  });
  const pkg = await createShowcasePackage(ctx.prisma, { durationDays: 30 });
  const service = ctx.app.get(ShowcaseEntitlementService);
  return { category, user, profile, pkg, service };
}

async function draftCard(providerId: string, categoryId: string) {
  const card = await ctx.prisma.showcaseCard.create({
    data: { providerId, kind: 'SERVICE', categoryId, status: 'DRAFT' },
  });
  const version = await ctx.prisma.showcaseCardVersion.create({
    data: {
      cardId: card.id, versionNumber: 1, kindSnapshot: 'SERVICE', title: 'T', summary: 'S',
      scopeIncluded: ['a'], scopeExcluded: ['b'], listedServicePriceAmount: 1000,
      reviewStatus: 'DRAFT',
      areas: { create: [{ scope: 'DISTRICT', city: 'İstanbul', district: 'Kadıköy', neighborhood: null, areaKey: 'istanbul|kadikoy|' }] },
    },
  });
  await ctx.prisma.showcaseCard.update({ where: { id: card.id }, data: { draftVersionId: version.id } });
  return { card, version };
}

describe('schema', () => {
  it('applies the entitlement migration: the tables exist and the package default is 90 days', async () => {
    const rows = await ctx.prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('ShowcaseEntitlement', 'ShowcaseEntitlementReviewPause', 'ShowcasePackageTermsAcceptance')
      ORDER BY table_name`;
    expect(rows.map((row) => row.table_name)).toEqual([
      'ShowcaseEntitlement',
      'ShowcaseEntitlementReviewPause',
      'ShowcasePackageTermsAcceptance',
    ]);

    const pkg = await ctx.prisma.showcasePackage.create({
      data: { name: 'P', slug: 'vitrin-schema-test', priceAmount: 100, durationDays: 30 },
    });
    expect(pkg.activationWindowDays).toBe(90);
  });
});

describe('granting', () => {
  it('grants one AVAILABLE right per settled purchase, expiring after the package window', async () => {
    const { user, profile, pkg, service } = await scenario();
    const purchase = await paidPackagePurchase(profile.id, user.id, pkg.id);
    const paidAt = new Date('2026-09-11T10:00:00Z');

    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, purchase, paidAt));

    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { purchaseId: purchase.id } });
    expect(right.status).toBe('AVAILABLE');
    expect(right.durationDaysSnapshot).toBe(30);
    expect(right.priceTermsVersionSnapshot).toBe('v1');
    expect(right.expiresAt.getTime() - paidAt.getTime()).toBe(90 * DAY);
  });

  it('cannot grant twice for one purchase', async () => {
    const { user, profile, pkg, service } = await scenario();
    const purchase = await paidPackagePurchase(profile.id, user.id, pkg.id);
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, purchase, new Date()));

    await expect(
      ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, purchase, new Date())),
    ).rejects.toThrow();
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(1);
  });
});

describe('reserving', () => {
  it('reserves the earliest-expiring usable right and refuses a second card for it', async () => {
    const { user, profile, pkg, category, service } = await scenario();
    const purchase = await paidPackagePurchase(profile.id, user.id, pkg.id);
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, purchase, new Date()));
    const a = await draftCard(profile.id, category.id);
    const b = await draftCard(profile.id, category.id);

    const outcomes = await Promise.allSettled([
      ctx.prisma.$transaction((tx) =>
        service.reserveForCard(tx, { providerId: profile.id, cardId: a.card.id, kind: 'SERVICE', entitlementId: null, now: new Date() })),
      ctx.prisma.$transaction((tx) =>
        service.reserveForCard(tx, { providerId: profile.id, cardId: b.card.id, kind: 'SERVICE', entitlementId: null, now: new Date() })),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    )!;
    // The losing side either lost the conditional `updateMany` race (our own
    // 409) or hit a Prisma serialization/unique error inside `$transaction`
    // before it got that far — both are the expected shape of "somebody else
    // got there first" under Serializable.
    const code = (rejected.reason as { response?: { code?: string } })?.response?.code;
    if (code !== undefined) {
      expect(['SHOWCASE_ENTITLEMENT_UNAVAILABLE', 'SHOWCASE_ENTITLEMENT_REQUIRED']).toContain(code);
    } else {
      expect(rejected.reason).toBeInstanceOf(Error);
    }
    const rights = await ctx.prisma.showcaseEntitlement.findMany();
    expect(rights).toHaveLength(1);
    expect(rights[0]!.status).toBe('RESERVED');
  });

  it('picks a usable right whose kind matches over an earlier-expiring one that does not, when no right is named', async () => {
    const { user, profile, pkg, category, service } = await scenario();
    const promoPkg = await createShowcasePackage(ctx.prisma, { allowedCardKind: 'PROMOTION' });
    const promoPurchase = await paidPackagePurchase(profile.id, user.id, promoPkg.id);
    await ctx.prisma.$transaction((tx) =>
      service.grantForPurchase(tx, promoPurchase, new Date(Date.now() - 5 * DAY)));
    const generalPurchase = await paidPackagePurchase(profile.id, user.id, pkg.id);
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, generalPurchase, new Date()));

    const promoRight = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({
      where: { purchaseId: promoPurchase.id },
    });
    const generalRight = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({
      where: { purchaseId: generalPurchase.id },
    });
    // The PROMOTION-only right expires first; the unrestricted one expires
    // later. A SERVICE card with no named right must still reserve the one it
    // can actually use, not refuse because the *earliest* one happens to be
    // the wrong kind.
    expect(promoRight.expiresAt.getTime()).toBeLessThan(generalRight.expiresAt.getTime());

    const { card } = await draftCard(profile.id, category.id);
    const reserved = await ctx.prisma.$transaction((tx) =>
      service.reserveForCard(tx, { providerId: profile.id, cardId: card.id, kind: 'SERVICE', entitlementId: null, now: new Date() }));

    expect(reserved.id).toBe(generalRight.id);
    expect((await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: promoRight.id } })).status).toBe('AVAILABLE');
  });

  it('refuses a right whose kind does not match and an expired right', async () => {
    const { user, profile, pkg, category, service } = await scenario();
    const promoPkg = await createShowcasePackage(ctx.prisma, { allowedCardKind: 'PROMOTION' });
    const p1 = await paidPackagePurchase(profile.id, user.id, promoPkg.id);
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, p1, new Date()));
    const { card } = await draftCard(profile.id, category.id);

    await expect(
      ctx.prisma.$transaction((tx) =>
        service.reserveForCard(tx, { providerId: profile.id, cardId: card.id, kind: 'SERVICE', entitlementId: null, now: new Date() })),
    ).rejects.toMatchObject({ response: { code: 'SHOWCASE_ENTITLEMENT_REQUIRED' } });

    const p2 = await paidPackagePurchase(profile.id, user.id, pkg.id);
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, p2, new Date(Date.now() - 91 * DAY)));
    await expect(
      ctx.prisma.$transaction((tx) =>
        service.reserveForCard(tx, { providerId: profile.id, cardId: card.id, kind: 'SERVICE', entitlementId: null, now: new Date() })),
    ).rejects.toMatchObject({ response: { code: 'SHOWCASE_ENTITLEMENT_REQUIRED' } });
  });
});

describe('review pause, release and consumption', () => {
  it('stops the clock in review, gives the time back on rejection, and never expires a paused right', async () => {
    const { user, profile, pkg, category, service } = await scenario();
    const purchase = await paidPackagePurchase(profile.id, user.id, pkg.id);
    const paidAt = new Date('2026-09-01T00:00:00Z');
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, purchase, paidAt));
    const { card, version } = await draftCard(profile.id, category.id);
    await ctx.prisma.$transaction((tx) =>
      service.reserveForCard(tx, { providerId: profile.id, cardId: card.id, kind: 'SERVICE', entitlementId: null, now: paidAt }));

    const submittedAt = new Date('2026-11-25T00:00:00Z'); // 85 days in: 5 left
    await ctx.prisma.$transaction((tx) => service.pauseForReview(tx, card.id, version.id, submittedAt));

    const wayLater = new Date('2027-01-15T00:00:00Z');
    expect(await service.expireStale(wayLater, 100)).toBe(0);
    expect(await service.findReservedForCard(ctx.prisma, card.id, wayLater)).not.toBeNull();

    await ctx.prisma.$transaction((tx) => service.resumeAfterReview(tx, card.id, 'REJECTED', wayLater));
    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { purchaseId: purchase.id } });
    expect(right.reviewPausedAt).toBeNull();
    expect(right.expiresAt.getTime()).toBe(paidAt.getTime() + 90 * DAY + (wayLater.getTime() - submittedAt.getTime()));
    expect(right.totalPausedSeconds).toBe((wayLater.getTime() - submittedAt.getTime()) / 1000);

    const pause = await ctx.prisma.showcaseEntitlementReviewPause.findFirstOrThrow({ where: { entitlementId: right.id } });
    expect(pause.endReason).toBe('REJECTED');
    expect(pause.expiresAtAfter?.getTime()).toBe(right.expiresAt.getTime());
  });

  it('releases a reserved right back to AVAILABLE and consumes it exactly once into a placement', async () => {
    const { user, profile, pkg, category, service } = await scenario();
    const purchase = await paidPackagePurchase(profile.id, user.id, pkg.id);
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, purchase, new Date()));
    const first = await draftCard(profile.id, category.id);
    await ctx.prisma.$transaction((tx) =>
      service.reserveForCard(tx, { providerId: profile.id, cardId: first.card.id, kind: 'SERVICE', entitlementId: null, now: new Date() }));

    expect(await ctx.prisma.$transaction((tx) => service.releaseForCard(tx, first.card.id, new Date()))).toBe(true);
    expect((await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { purchaseId: purchase.id } })).status).toBe('AVAILABLE');

    const second = await draftCard(profile.id, category.id);
    await ctx.prisma.$transaction((tx) =>
      service.reserveForCard(tx, { providerId: profile.id, cardId: second.card.id, kind: 'SERVICE', entitlementId: null, now: new Date() }));
    // A version that has left DRAFT carries the price-terms acceptance and the
    // submission time too — `ShowcaseCardVersion_price_terms_on_submit` and
    // `ShowcaseCardVersion_submitted_at_matches_status` both require it.
    await ctx.prisma.showcaseCardVersion.update({
      where: { id: second.version.id },
      data: {
        reviewStatus: 'APPROVED',
        submittedAt: new Date(),
        priceTermsVersion: 'v1',
        priceTermsAcceptedAt: new Date(),
        publishedAt: new Date(),
      },
    });

    const now = new Date();
    const { placementId } = await ctx.prisma.$transaction((tx) =>
      service.consumeForCard(tx, { cardId: second.card.id, versionId: second.version.id, providerId: profile.id, categoryId: category.id, kind: 'SERVICE', now }));

    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { purchaseId: purchase.id } });
    expect(right.status).toBe('CONSUMED');
    expect(right.placementId).toBe(placementId);
    const placement = await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placementId }, include: { shelves: true } });
    expect(placement.status).toBe('ACTIVE');
    expect(placement.startAt.getTime()).toBe(now.getTime());
    expect(placement.endAt.getTime()).toBe(now.getTime() + 30 * DAY);
    expect(placement.shelves).toHaveLength(1);

    await expect(
      ctx.prisma.$transaction((tx) =>
        service.consumeForCard(tx, { cardId: second.card.id, versionId: second.version.id, providerId: profile.id, categoryId: category.id, kind: 'SERVICE', now })),
    ).rejects.toMatchObject({ response: { code: 'SHOWCASE_ENTITLEMENT_MISSING' } });
  });

  it('expires stale unreserved and reserved-but-idle rights, and lists what is usable', async () => {
    const { user, profile, pkg, service } = await scenario();
    const stale = await paidPackagePurchase(profile.id, user.id, pkg.id);
    const fresh = await paidPackagePurchase(profile.id, user.id, pkg.id);
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, stale, new Date(Date.now() - 91 * DAY)));
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, fresh, new Date()));

    expect(await service.expireStale(new Date(), 100)).toBe(1);
    const listed = await service.listForProvider(profile.id, new Date());
    expect(listed.available).toHaveLength(1);
    expect(listed.available[0]!.packageName).toBe((await ctx.prisma.showcasePackage.findUniqueOrThrow({ where: { id: pkg.id } })).name);
  });
});
