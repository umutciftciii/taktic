import { ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SHOWCASE_PRICE_TERMS_TEXT,
  SHOWCASE_PRICE_TERMS_VERSION,
  resolveShowcasePriceTerms,
} from '../src/modules/showcase/showcase.constants';
import {
  acceptShowcasePriceTerms,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcaseEntitlement,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * Bumping the price-responsibility terms gates the next sale, and nothing else.
 *
 * ## The product rule this file exists to hold
 *
 * A terms bump must be invisible to everything that has already been paid for.
 * A card that is approved stays approved, a run that is on the air stays on the
 * air until its own `endAt`, and no version is re-opened for review. The only
 * thing a bump changes is that the *next* checkout asks for a fresh acceptance
 * — and that gate, on the package-first sale, is proved in
 * `showcase-package-checkout.spec.ts`.
 *
 * ## How a bump is simulated here
 *
 * `SHOWCASE_PRICE_TERMS_VERSION` is a constant rather than configuration — a
 * deployment that could set its own legal text would be a deployment making a
 * promise this repository cannot see. So the suite never mutates it. It
 * produces the *state* a bump produces instead: a legacy run whose only
 * acceptance names an older version, which is exactly what a live card looks
 * like the moment the constant moves on.
 *
 * ## Two tables in the operator's ledger
 *
 * The card-bound acceptance rows stay — every legacy run was sold under one,
 * and its public card still shows that snapshot — but no route writes one any
 * more. The package-first sale writes a business-scoped row instead, and the
 * operator's list merges both, each labelled with its `scope`.
 */
let ctx: TestContext;

const OLD_TERMS_VERSION = 'v0';

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
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
    providerId: profile.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
  });
  const pkg = await createShowcasePackage(ctx.prisma);

  return {
    category,
    user,
    profile,
    card,
    version,
    pkg,
    cookie: await loginAs(ctx.prisma, user.id),
  };
}

// ────────────────────────────────────────────────────────────────────────────

describe('the configuration itself', () => {
  /**
   * Fail-closed. A blank version names no terms, and a checkout compared
   * against it would either match nothing or — worse — match an equally blank
   * stored value and sell a placement on no terms at all.
   */
  it('refuses to resolve a blank version', () => {
    // The code is asserted rather than "it threw": a missing export throws a
    // TypeError, and a test satisfied by that would pass before the guard
    // exists.
    expect(() => resolveShowcasePriceTerms('', SHOWCASE_PRICE_TERMS_TEXT)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'SHOWCASE_PRICE_TERMS_UNAVAILABLE' }),
      }),
    );
    expect(() => resolveShowcasePriceTerms('   ', SHOWCASE_PRICE_TERMS_TEXT)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'SHOWCASE_PRICE_TERMS_UNAVAILABLE' }),
      }),
    );
  });

  it('refuses to resolve a blank text', () => {
    expect(() => resolveShowcasePriceTerms(SHOWCASE_PRICE_TERMS_VERSION, '')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'SHOWCASE_PRICE_TERMS_UNAVAILABLE' }),
      }),
    );
  });

  it('resolves the configured terms', () => {
    expect(resolveShowcasePriceTerms()).toEqual({
      version: SHOWCASE_PRICE_TERMS_VERSION,
      text: SHOWCASE_PRICE_TERMS_TEXT,
    });
  });
});

describe('what a bump must never touch', () => {
  /**
   * The contract in one test. A run bought under superseded terms stays on the
   * air, keeps its own `endAt`, is not suspended, and its card is still served
   * to the public — the placement's acceptance is a fact about the sale, never
   * a live condition re-checked on every read.
   */
  it('leaves a live placement bought under older terms on the air', async () => {
    const { profile, card, version, pkg, user } = await scenario();
    const acceptance = await acceptShowcasePriceTerms(ctx.prisma, {
      providerId: profile.id,
      cardId: card.id,
      userId: user.id,
      termsVersion: OLD_TERMS_VERSION,
    });
    const { placement } = await createLiveShowcasePlacement(ctx, {
      providerId: profile.id,
      cardId: card.id,
      versionId: version.id,
      packageId: pkg.id,
      acceptanceId: acceptance.id,
    });

    const stored = await ctx.prisma.showcasePlacement.findUniqueOrThrow({
      where: { id: placement.id },
    });
    expect(stored.status).toBe('ACTIVE');
    expect(stored.suspendedAt).toBeNull();
    expect(stored.suspendReason).toBeNull();
    expect(stored.endAt.toISOString()).toBe(placement.endAt.toISOString());

    const feed = await request(ctx.server).get('/showcase/feed?city=İstanbul&district=Kadıköy');
    expect(feed.status).toBe(200);
    expect(feed.body.cards.map((entry: { cardId: string }) => entry.cardId)).toContain(card.id);

    const publicCard = await request(ctx.server).get(`/showcase/cards/${card.id}`);
    expect(publicCard.status).toBe(200);

    const storedCard = await ctx.prisma.showcaseCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(storedCard.status).toBe('APPROVED');
    expect(storedCard.liveVersionId).toBe(version.id);
    expect(
      await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({ where: { id: version.id } }),
    ).toMatchObject({ reviewStatus: 'APPROVED' });
  });

  /**
   * Item 8 of the contract: what the customer is shown about who is responsible
   * for the price is the sentence the *run* was sold under, not whatever the
   * platform's constant says today.
   */
  it("serves the placement's own terms snapshot on the public card", async () => {
    const { profile, card, version, pkg, user } = await scenario();
    const acceptance = await acceptShowcasePriceTerms(ctx.prisma, {
      providerId: profile.id,
      cardId: card.id,
      userId: user.id,
      termsVersion: OLD_TERMS_VERSION,
      termsText: 'Eski sürüm metni.',
    });
    await createLiveShowcasePlacement(ctx, {
      providerId: profile.id,
      cardId: card.id,
      versionId: version.id,
      packageId: pkg.id,
      acceptanceId: acceptance.id,
    });

    const publicCard = await request(ctx.server).get(`/showcase/cards/${card.id}`);

    expect(publicCard.status).toBe(200);
    expect(publicCard.body.priceTerms).toEqual({
      version: OLD_TERMS_VERSION,
      text: 'Eski sürüm metni.',
    });
  });
});

describe("the operator's read-only view", () => {
  it('lists both kinds of acceptance for a SUPER_ADMIN, each with its scope', async () => {
    const { profile, card, pkg, user } = await scenario();
    // A legacy, card-bound acceptance — written directly, since no route does.
    await acceptShowcasePriceTerms(ctx.prisma, {
      providerId: profile.id,
      cardId: card.id,
      userId: user.id,
      acceptedAt: new Date(Date.now() - 60_000),
    });
    // And the package-first one, as a settled purchase writes it.
    await createShowcaseEntitlement(ctx, {
      providerId: profile.id,
      userId: user.id,
      packageId: pkg.id,
    });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    const response = await request(ctx.server)
      .get('/admin/showcase/price-terms-acceptances')
      .set('Cookie', await loginAs(ctx.prisma, admin.id));

    expect(response.status).toBe(200);
    expect(response.body.acceptances).toHaveLength(2);
    // Newest first, across both tables.
    expect(response.body.acceptances[0]).toMatchObject({
      scope: 'PACKAGE',
      cardId: null,
      card: null,
      providerId: profile.id,
      termsVersion: SHOWCASE_PRICE_TERMS_VERSION,
      termsTextSnapshot: SHOWCASE_PRICE_TERMS_TEXT,
      provider: { id: profile.id },
      acceptedByUser: { id: user.id },
    });
    expect(response.body.acceptances[1]).toMatchObject({
      scope: 'CARD',
      cardId: card.id,
      card: { id: card.id },
      termsVersion: SHOWCASE_PRICE_TERMS_VERSION,
    });
  });

  it('narrows by terms version', async () => {
    const { profile, card, pkg, user } = await scenario();
    await createShowcaseEntitlement(ctx, {
      providerId: profile.id,
      userId: user.id,
      packageId: pkg.id,
    });
    await acceptShowcasePriceTerms(ctx.prisma, {
      providerId: profile.id,
      cardId: card.id,
      userId: user.id,
      termsVersion: OLD_TERMS_VERSION,
    });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    const response = await request(ctx.server)
      .get(`/admin/showcase/price-terms-acceptances?termsVersion=${OLD_TERMS_VERSION}`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id));

    expect(response.body.acceptances).toHaveLength(1);
    expect(response.body.acceptances[0]).toMatchObject({
      scope: 'CARD',
      termsVersion: OLD_TERMS_VERSION,
    });
  });

  it('narrows by card, which is by definition the card-bound rows', async () => {
    const { profile, card, pkg, user } = await scenario();
    await createShowcaseEntitlement(ctx, {
      providerId: profile.id,
      userId: user.id,
      packageId: pkg.id,
    });
    await acceptShowcasePriceTerms(ctx.prisma, {
      providerId: profile.id,
      cardId: card.id,
      userId: user.id,
    });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    const response = await request(ctx.server)
      .get(`/admin/showcase/price-terms-acceptances?cardId=${card.id}`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id));

    expect(response.body.acceptances).toHaveLength(1);
    expect(response.body.acceptances[0]).toMatchObject({ scope: 'CARD', cardId: card.id });
  });

  it('refuses a provider', async () => {
    const { cookie } = await scenario();

    const response = await request(ctx.server)
      .get('/admin/showcase/price-terms-acceptances')
      .set('Cookie', cookie);

    expect(response.status).toBe(403);
  });

  /** Read-only: there is no operator route that writes or clears an acceptance. */
  it('offers no write route', async () => {
    const { profile, pkg, user } = await scenario();
    await createShowcaseEntitlement(ctx, {
      providerId: profile.id,
      userId: user.id,
      packageId: pkg.id,
    });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    const row = await ctx.prisma.showcasePackageTermsAcceptance.findFirstOrThrow();

    const post = await request(ctx.server)
      .post('/admin/showcase/price-terms-acceptances')
      .set('Cookie', adminCookie)
      .send({ providerId: profile.id });
    const remove = await request(ctx.server)
      .delete(`/admin/showcase/price-terms-acceptances/${row.id}`)
      .set('Cookie', adminCookie);

    expect(post.status).toBe(404);
    expect(remove.status).toBe(404);
    expect(await ctx.prisma.showcasePackageTermsAcceptance.count()).toBe(1);
  });
});
