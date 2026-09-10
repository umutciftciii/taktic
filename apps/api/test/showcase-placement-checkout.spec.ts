import {
  ProviderStatus,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptShowcasePriceTerms,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  currentCreditBalance,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * Buying a vitrin run: what has to be true first, and — just as importantly —
 * what deliberately does not.
 *
 * ## The main regression this file protects
 *
 * **A provider may publish as many cards as they like on the same shelf.** An
 * earlier design refused a second card in a category and district the provider
 * already occupied, and refused a narrow card when a wider one covered it. Both
 * refusals are gone: they cut the revenue model at the point of sale, and told a
 * paying business that its second card was worth nothing. The concern behind
 * them — one business filling the visitor's screen — is real and is answered in
 * the feed's ordering, not here.
 *
 * Two cases below assert the absence of those refusals, and they are the reason
 * this file exists.
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

async function scenario(
  options: { areas?: Array<{ city: string; district?: string | null }> } = {},
) {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
    providerId: profile.id,
    categoryId: category.id,
    areas: options.areas ?? [{ city: 'İstanbul', district: 'Kadıköy' }],
  });
  const pkg = await createShowcasePackage(ctx.prisma);
  // A sale needs an acceptance of the price-responsibility text in force. That
  // gate has its own suite — `showcase-price-terms-acceptance.spec.ts` — so it
  // is satisfied here rather than re-asserted, exactly as the card's approval
  // is.
  await acceptShowcasePriceTerms(ctx.prisma, {
    providerId: profile.id,
    cardId: card.id,
    userId: user.id,
  });

  return { category, user, profile, card, version, pkg, cookie: await loginAs(ctx.prisma, user.id) };
}

function checkout(providerId: string, cookie: string, body: Record<string, unknown>) {
  return request(ctx.server)
    .post(`/providers/${providerId}/showcase/placements/checkout`)
    .set('Cookie', cookie)
    .send(body);
}

describe('who may buy', () => {
  it('refuses an anonymous caller', async () => {
    const { profile, card, pkg } = await scenario();

    const response = await request(ctx.server)
      .post(`/providers/${profile.id}/showcase/placements/checkout`)
      .send({ cardId: card.id, showcasePackageId: pkg.id });

    expect(response.status).toBe(401);
  });

  it('refuses a customer', async () => {
    const { profile, card, pkg } = await scenario();
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await loginAs(ctx.prisma, customer.id);

    const response = await checkout(profile.id, cookie, {
      cardId: card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(403);
  });

  /**
   * Buying is an act of the account that owns the business, never an
   * administrative one — the identical rule `PaymentsService` applies to credit
   * packages. An operator supporting a provider can read every one of these
   * screens and can suspend a run; they cannot spend that business's money.
   */
  it('refuses a SUPER_ADMIN acting on the provider path', async () => {
    const { profile, card, pkg } = await scenario();
    const adminUser = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, adminUser.id);

    const response = await checkout(profile.id, cookie, {
      cardId: card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(403);
  });

  it("answers 404 for another provider's card, not 403", async () => {
    const { profile, cookie, pkg } = await scenario();
    const other = await scenario();

    const response = await checkout(profile.id, cookie, {
      cardId: other.card.id,
      showcasePackageId: pkg.id,
    });

    // A 403 would confirm the id is real, which is how somebody walks the id
    // space to learn what competitors are about to advertise.
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('SHOWCASE_CARD_NOT_FOUND');
  });
});

describe('what has to be true before a checkout opens', () => {
  it('refuses a card that has never been approved', async () => {
    const { profile, cookie, category, pkg } = await scenario();
    const draft = await ctx.prisma.showcaseCard.create({
      data: { providerId: profile.id, kind: 'SERVICE', categoryId: category.id, status: 'DRAFT' },
    });

    const response = await checkout(profile.id, cookie, {
      cardId: draft.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_CARD_NOT_PUBLISHABLE');
  });

  it('refuses while the provider is not approved', async () => {
    const { profile, cookie, card, pkg } = await scenario();
    await ctx.prisma.providerProfile.update({
      where: { id: profile.id },
      data: { status: ProviderStatus.SUSPENDED },
    });

    const response = await checkout(profile.id, cookie, {
      cardId: card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_PROVIDER_NOT_APPROVED');
  });

  it('refuses once the category has been closed', async () => {
    const { profile, cookie, card, pkg, category } = await scenario();
    await ctx.prisma.serviceCategory.update({
      where: { id: category.id },
      data: { status: ServiceCategoryStatus.INACTIVE, isActive: false },
    });

    const response = await checkout(profile.id, cookie, {
      cardId: card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');
  });

  it("refuses once the card's area has left the provider's coverage", async () => {
    const { profile, cookie, card, pkg } = await scenario();
    await ctx.prisma.providerServiceArea.deleteMany({ where: { providerId: profile.id } });
    await ctx.prisma.providerServiceArea.create({
      data: { providerId: profile.id, scope: 'DISTRICT', city: 'Ankara', district: 'Çankaya' },
    });

    const response = await checkout(profile.id, cookie, {
      cardId: card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_AREA_NOT_COVERED');
  });

  it('refuses a package that is not sold for this card kind', async () => {
    const { profile, cookie, card } = await scenario();
    const promotionOnly = await createShowcasePackage(ctx.prisma, {
      allowedCardKind: 'PROMOTION',
    });

    const response = await checkout(profile.id, cookie, {
      cardId: card.id,
      showcasePackageId: promotionOnly.id,
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_PACKAGE_KIND_MISMATCH');
  });

  it('refuses a second run for a card that already has one', async () => {
    const { profile, cookie, card, version, pkg } = await scenario();
    await createLiveShowcasePlacement(ctx, {
      providerId: profile.id,
      cardId: card.id,
      versionId: version.id,
      packageId: pkg.id,
    });

    const response = await checkout(profile.id, cookie, {
      cardId: card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_CARD_ALREADY_PLACED');
  });
});

/**
 * The two absences that are the point of this phase's design.
 *
 * Both cases would have been refusals under the earlier draft. Both must be
 * 201s: a business buys reach one card at a time, and how much of the visitor's
 * screen it ends up occupying is decided by the feed's rotation.
 */
describe('a provider may occupy the same shelf more than once', () => {
  it('sells a second card in the same category and district', async () => {
    const { profile, cookie, category, card, version, pkg, user } = await scenario();
    await createLiveShowcasePlacement(ctx, {
      providerId: profile.id,
      cardId: card.id,
      versionId: version.id,
      packageId: pkg.id,
    });

    const second = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: profile.id,
      categoryId: category.id,
      title: 'İkinci kart',
      areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    });
    // An acceptance names one card, so the second one needs its own.
    await acceptShowcasePriceTerms(ctx.prisma, {
      providerId: profile.id,
      cardId: second.card.id,
      userId: user.id,
    });

    const response = await checkout(profile.id, cookie, {
      cardId: second.card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(201);
  });

  it('sells a district card beside a province-wide one', async () => {
    const { profile, cookie, category, card, version, pkg, user } = await scenario({
      areas: [{ city: 'İstanbul', district: null }],
    });
    await createLiveShowcasePlacement(ctx, {
      providerId: profile.id,
      cardId: card.id,
      versionId: version.id,
      packageId: pkg.id,
    });

    const narrow = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: profile.id,
      categoryId: category.id,
      title: 'Kadıköy kartı',
      areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    });
    await acceptShowcasePriceTerms(ctx.prisma, {
      providerId: profile.id,
      cardId: narrow.card.id,
      userId: user.id,
    });

    const response = await checkout(profile.id, cookie, {
      cardId: narrow.card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(201);
  });
});

describe('the purchase a checkout opens', () => {
  it('is PENDING, carries no credit, and names the card and its live version', async () => {
    const { profile, cookie, card, version, pkg } = await scenario();

    const response = await checkout(profile.id, cookie, {
      cardId: card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(201);

    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: response.body.purchase.id },
    });

    expect(purchase.kind).toBe('SHOWCASE_PACKAGE');
    expect(purchase.status).toBe('PENDING');
    expect(purchase.packageId).toBeNull();
    expect(purchase.showcaseCardId).toBe(card.id);
    expect(purchase.showcaseCardVersionId).toBe(version.id);
    expect(purchase.durationDaysSnapshot).toBe(pkg.durationDays);
    expect(purchase.priceAmountSnapshot).toBe(pkg.priceAmount);
    // Zero by construction, and a CHECK agrees. A vitrin purchase sells
    // visibility and may never load an offer-credit balance.
    expect(purchase.creditAmountSnapshot).toBe(0);
    expect(purchase.creditTransactionId).toBeNull();
  });

  it('opens no run and moves no balance until a payment settles', async () => {
    const { profile, cookie, card, pkg } = await scenario();

    await checkout(profile.id, cookie, { cardId: card.id, showcasePackageId: pkg.id });

    expect(await ctx.prisma.showcasePlacement.count()).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, profile.id)).toBe(0);
  });

  it('never puts the correlation token in the response', async () => {
    const { profile, cookie, card, pkg } = await scenario();

    const response = await checkout(profile.id, cookie, {
      cardId: card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.body.purchase.paymentReference).toBeUndefined();
  });
});

describe('the eligibility dry run', () => {
  it('answers eligible for a publishable card and writes nothing', async () => {
    const { profile, cookie, card, pkg } = await scenario();

    const response = await request(ctx.server)
      .get(
        `/providers/${profile.id}/showcase/placements/eligibility?cardId=${card.id}&showcasePackageId=${pkg.id}`,
      )
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.eligible).toBe(true);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });

  it('answers with the same code the checkout would refuse with', async () => {
    const { profile, cookie, card, pkg, category } = await scenario();
    await ctx.prisma.serviceCategory.update({
      where: { id: category.id },
      data: { status: ServiceCategoryStatus.INACTIVE, isActive: false },
    });

    const response = await request(ctx.server)
      .get(
        `/providers/${profile.id}/showcase/placements/eligibility?cardId=${card.id}&showcasePackageId=${pkg.id}`,
      )
      .set('Cookie', cookie);

    // A dry run that could disagree with the endpoint would be a button that is
    // enabled and then refuses.
    expect(response.status).toBe(200);
    expect(response.body.eligible).toBe(false);
    expect(response.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');
  });

  it("still answers 404 for another provider's card", async () => {
    const { profile, cookie } = await scenario();
    const other = await scenario();

    const response = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/placements/eligibility?cardId=${other.card.id}`)
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
  });
});
