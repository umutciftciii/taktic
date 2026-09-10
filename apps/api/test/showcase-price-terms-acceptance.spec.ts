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
 * thing a bump changes is that the *next* checkout asks for a fresh acceptance.
 *
 * ## How a bump is simulated here
 *
 * `SHOWCASE_PRICE_TERMS_VERSION` is a constant rather than configuration — a
 * deployment that could set its own legal text would be a deployment making a
 * promise this repository cannot see. So the suite never mutates it. It
 * produces the *state* a bump produces instead: a card whose only acceptance
 * names an older version, which is exactly what a live card looks like the
 * moment the constant moves on. The predicate under test is "is there an
 * acceptance for the version in force", and this exercises it from the failing
 * side without putting a seam in production code.
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

function checkout(providerId: string, cookie: string, body: Record<string, unknown>) {
  return request(ctx.server)
    .post(`/providers/${providerId}/showcase/placements/checkout`)
    .set('Cookie', cookie)
    .send(body);
}

function accept(
  providerId: string,
  cardId: string,
  cookie: string,
  body: Record<string, unknown> = {
    priceTermsAccepted: true,
    priceTermsVersion: SHOWCASE_PRICE_TERMS_VERSION,
  },
) {
  return request(ctx.server)
    .post(`/providers/${providerId}/showcase/cards/${cardId}/price-terms-acceptances`)
    .set('Cookie', cookie)
    .send(body);
}

function readTerms(providerId: string, cardId: string, cookie: string) {
  return request(ctx.server)
    .get(`/providers/${providerId}/showcase/cards/${cardId}/price-terms`)
    .set('Cookie', cookie);
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

describe('accepting the terms', () => {
  it('records the version, the sentence and who agreed to it', async () => {
    const { profile, card, cookie, user } = await scenario();

    const response = await accept(profile.id, card.id, cookie);

    expect(response.status).toBe(200);
    expect(response.body.acceptance.termsVersion).toBe(SHOWCASE_PRICE_TERMS_VERSION);

    const rows = await ctx.prisma.showcaseCardPriceTermsAcceptance.findMany({
      where: { cardId: card.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: profile.id,
      cardId: card.id,
      termsVersion: SHOWCASE_PRICE_TERMS_VERSION,
      termsTextSnapshot: SHOWCASE_PRICE_TERMS_TEXT,
      acceptedByUserId: user.id,
    });
  });

  /**
   * Idempotent, and the second call must not leave a second row. The unique
   * index is the real guarantee; this asserts the endpoint agrees with it
   * rather than failing on it.
   */
  it('accepting the same version twice leaves exactly one record', async () => {
    const { profile, card, cookie } = await scenario();

    const first = await accept(profile.id, card.id, cookie);
    const second = await accept(profile.id, card.id, cookie);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.acceptance.id).toBe(first.body.acceptance.id);
    expect(second.body.acceptance.acceptedAt).toBe(first.body.acceptance.acceptedAt);

    const count = await ctx.prisma.showcaseCardPriceTermsAcceptance.count({
      where: { cardId: card.id },
    });
    expect(count).toBe(1);
  });

  /**
   * The whole point of a separate table: agreeing to a sentence is a legal act
   * and must not touch one thing a customer or an operator sees.
   */
  it('changes no card, version, review or placement row', async () => {
    const { profile, card, version, pkg, cookie, user } = await scenario();
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

    const cardBefore = await ctx.prisma.showcaseCard.findUniqueOrThrow({ where: { id: card.id } });
    const versionBefore = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    const placementBefore = await ctx.prisma.showcasePlacement.findUniqueOrThrow({
      where: { id: placement.id },
    });

    const response = await accept(profile.id, card.id, cookie);
    expect(response.status).toBe(200);

    expect(await ctx.prisma.showcaseCard.findUniqueOrThrow({ where: { id: card.id } })).toEqual(
      cardBefore,
    );
    expect(
      await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({ where: { id: version.id } }),
    ).toEqual(versionBefore);
    expect(
      await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placement.id } }),
    ).toEqual(placementBefore);
    expect(await ctx.prisma.showcaseCardReview.count()).toBe(0);
  });

  it('refuses a version that is not the one in force', async () => {
    const { profile, card, cookie } = await scenario();

    const response = await accept(profile.id, card.id, cookie, {
      priceTermsAccepted: true,
      priceTermsVersion: OLD_TERMS_VERSION,
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('SHOWCASE_PRICE_TERMS_REQUIRED');
    expect(await ctx.prisma.showcaseCardPriceTermsAcceptance.count()).toBe(0);
  });

  it('refuses a body that does not actually accept', async () => {
    const { profile, card, cookie } = await scenario();

    const response = await accept(profile.id, card.id, cookie, {
      priceTermsAccepted: false,
      priceTermsVersion: SHOWCASE_PRICE_TERMS_VERSION,
    });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.showcaseCardPriceTermsAcceptance.count()).toBe(0);
  });
});

describe('who may accept', () => {
  it('refuses an anonymous caller', async () => {
    const { profile, card } = await scenario();

    const response = await request(ctx.server)
      .post(`/providers/${profile.id}/showcase/cards/${card.id}/price-terms-acceptances`)
      .send({ priceTermsAccepted: true, priceTermsVersion: SHOWCASE_PRICE_TERMS_VERSION });

    expect(response.status).toBe(401);
    expect(await ctx.prisma.showcaseCardPriceTermsAcceptance.count()).toBe(0);
  });

  it('refuses a customer', async () => {
    const { profile, card } = await scenario();
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });

    const response = await accept(profile.id, card.id, await loginAs(ctx.prisma, customer.id));

    expect(response.status).toBe(403);
    expect(await ctx.prisma.showcaseCardPriceTermsAcceptance.count()).toBe(0);
  });

  /**
   * The identical rule the checkout applies: an operator may read every one of
   * these screens and may suspend a run, but may not agree to terms on a
   * business's behalf. Consent given by somebody else is not consent.
   */
  it('refuses a SUPER_ADMIN acting on the provider path', async () => {
    const { profile, card } = await scenario();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    const response = await accept(profile.id, card.id, await loginAs(ctx.prisma, admin.id));

    expect(response.status).toBe(403);
    expect(await ctx.prisma.showcaseCardPriceTermsAcceptance.count()).toBe(0);
  });

  it("refuses one provider addressing another provider's panel", async () => {
    const first = await scenario();
    const second = await scenario();

    const response = await accept(second.profile.id, second.card.id, first.cookie);

    expect(response.status).toBe(403);
    expect(await ctx.prisma.showcaseCardPriceTermsAcceptance.count()).toBe(0);
  });

  /**
   * Another business's card inside a panel the caller does own answers 404 with
   * the same body an id that names nothing does — the discipline every other
   * card route follows, so the id space cannot be walked to learn who is about
   * to advertise what.
   */
  it("answers 404 for another provider's card and discloses nothing", async () => {
    const first = await scenario();
    const second = await scenario();

    const response = await accept(first.profile.id, second.card.id, first.cookie);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('SHOWCASE_CARD_NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain(second.profile.id);
    expect(JSON.stringify(response.body)).not.toContain(second.card.id);
    expect(await ctx.prisma.showcaseCardPriceTermsAcceptance.count()).toBe(0);
  });

  it("answers 404 when reading another provider's card terms", async () => {
    const first = await scenario();
    const second = await scenario();

    const response = await readTerms(first.profile.id, second.card.id, first.cookie);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('SHOWCASE_CARD_NOT_FOUND');
  });
});

describe('the terms a card is looking at', () => {
  it('reports the version in force and no acceptance yet', async () => {
    const { profile, card, cookie } = await scenario();

    const response = await readTerms(profile.id, card.id, cookie);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      version: SHOWCASE_PRICE_TERMS_VERSION,
      text: SHOWCASE_PRICE_TERMS_TEXT,
      accepted: false,
      acceptance: null,
    });
  });

  it('reports an acceptance once it exists', async () => {
    const { profile, card, cookie } = await scenario();
    await accept(profile.id, card.id, cookie);

    const response = await readTerms(profile.id, card.id, cookie);

    expect(response.body.accepted).toBe(true);
    expect(response.body.acceptance.termsVersion).toBe(SHOWCASE_PRICE_TERMS_VERSION);
  });

  /**
   * An acceptance of superseded terms is not an acceptance for this purpose,
   * and the screen has to be able to say so — otherwise the provider meets the
   * refusal at the checkout with no way to clear it.
   */
  it('reports an older acceptance as insufficient', async () => {
    const { profile, card, cookie, user } = await scenario();
    await acceptShowcasePriceTerms(ctx.prisma, {
      providerId: profile.id,
      cardId: card.id,
      userId: user.id,
      termsVersion: OLD_TERMS_VERSION,
    });

    const response = await readTerms(profile.id, card.id, cookie);

    expect(response.body.accepted).toBe(false);
    expect(response.body.acceptance).toBeNull();
  });
});

describe('the checkout gate', () => {
  /**
   * The main regression. An acceptance of superseded terms refuses the sale,
   * and refuses it *before* anything exists: no purchase row means no hosted
   * session either, because the session is opened from the row.
   */
  it('refuses a checkout when the only acceptance names older terms', async () => {
    const { profile, card, pkg, cookie, user } = await scenario();
    await acceptShowcasePriceTerms(ctx.prisma, {
      providerId: profile.id,
      cardId: card.id,
      userId: user.id,
      termsVersion: OLD_TERMS_VERSION,
    });

    const response = await checkout(profile.id, cookie, {
      cardId: card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED');
    expect(response.body.requiredVersion).toBe(SHOWCASE_PRICE_TERMS_VERSION);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
    expect(await ctx.prisma.showcasePlacement.count()).toBe(0);
  });

  it('refuses a checkout when nothing has ever been accepted for the card', async () => {
    const { profile, card, pkg, cookie } = await scenario();

    const response = await checkout(profile.id, cookie, {
      cardId: card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED');
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });

  /**
   * An acceptance belongs to one card. A provider who accepted the current
   * terms on their first card has not accepted them for the second — the record
   * says what was agreed and about what, and widening it to the business would
   * make the card column decorative.
   */
  it("does not let one card's acceptance open another card's checkout", async () => {
    const { profile, card, pkg, cookie, category } = await scenario();
    const other = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: profile.id,
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: 'Üsküdar' }],
    });
    await accept(profile.id, card.id, cookie);

    const response = await checkout(profile.id, cookie, {
      cardId: other.card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED');
  });

  it('opens the checkout once the current terms are accepted', async () => {
    const { profile, card, pkg, cookie } = await scenario();
    await accept(profile.id, card.id, cookie);

    const response = await checkout(profile.id, cookie, {
      cardId: card.id,
      showcasePackageId: pkg.id,
    });

    expect(response.status).toBe(201);

    const purchase = await ctx.prisma.packagePurchase.findFirstOrThrow({
      where: { showcaseCardId: card.id },
      include: { showcasePriceTermsAcceptance: true },
    });
    expect(purchase.showcasePriceTermsAcceptance?.termsVersion).toBe(SHOWCASE_PRICE_TERMS_VERSION);
  });

  /** The dry run behind the buy button must give the same answer the sale does. */
  it('reports the same refusal from the eligibility check', async () => {
    const { profile, card, pkg, cookie } = await scenario();

    const response = await request(ctx.server)
      .get(
        `/providers/${profile.id}/showcase/placements/eligibility?cardId=${card.id}&showcasePackageId=${pkg.id}`,
      )
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.eligible).toBe(false);
    expect(response.body.code).toBe('SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED');
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
  it('lists acceptances for a SUPER_ADMIN', async () => {
    const { profile, card, cookie } = await scenario();
    await accept(profile.id, card.id, cookie);
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    const response = await request(ctx.server)
      .get('/admin/showcase/price-terms-acceptances')
      .set('Cookie', await loginAs(ctx.prisma, admin.id));

    expect(response.status).toBe(200);
    expect(response.body.acceptances).toHaveLength(1);
    expect(response.body.acceptances[0]).toMatchObject({
      cardId: card.id,
      termsVersion: SHOWCASE_PRICE_TERMS_VERSION,
    });
  });

  it('narrows by terms version', async () => {
    const { profile, card, cookie, user } = await scenario();
    await accept(profile.id, card.id, cookie);
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
    expect(response.body.acceptances[0].termsVersion).toBe(OLD_TERMS_VERSION);
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
    const { profile, card, cookie } = await scenario();
    await accept(profile.id, card.id, cookie);
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    const row = await ctx.prisma.showcaseCardPriceTermsAcceptance.findFirstOrThrow();

    const post = await request(ctx.server)
      .post('/admin/showcase/price-terms-acceptances')
      .set('Cookie', adminCookie)
      .send({ cardId: card.id });
    const remove = await request(ctx.server)
      .delete(`/admin/showcase/price-terms-acceptances/${row.id}`)
      .set('Cookie', adminCookie);

    expect(post.status).toBe(404);
    expect(remove.status).toBe(404);
    expect(await ctx.prisma.showcaseCardPriceTermsAcceptance.count()).toBe(1);
  });
});
