import { ServiceCategoryKind, UserRole } from '@prisma/client';
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
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * Where a card stands, resolved once on the server.
 *
 * ## The defect this endpoint exists to end
 *
 * The provider's panel used to answer "where does this card stand" by
 * assembling four independent reads on the screen: the card's `status`, the
 * pair of versions and their `reviewStatus`, the placement list filtered by
 * three enum members, and an eligibility dry run whose *refusal code* decided
 * which of three mutually exclusive panels to render.
 *
 * The four could disagree, and on the commonest moment in the whole feature
 * they did. A card's submission records its acceptance of the
 * price-responsibility text on the **version**; the sale reads a **separate
 * ledger**. So every freshly approved card had the first and not the second,
 * the eligibility check answered `SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED`, and
 * the buying panel replaced the package table with a notice claiming the terms
 * had been *updated* — to a provider who had accepted them ten minutes earlier
 * and had nothing to compare it against. The packages, and every payment
 * control with them, were never rendered at all.
 *
 * The first case below is that exact sequence, asserted as a state a person can
 * act on rather than as a refusal code.
 *
 * ## What the response may not carry
 *
 * Placement ids, version ids, purchase ids, raw enum members, the terms ledger
 * row. The last case holds that line: none of them is something a provider acts
 * on, and every one of them is something that turns into a support conversation
 * the moment it reaches a screen.
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

async function business() {
  const category = await createCategory(ctx.prisma, 'Klima', {
    kind: ServiceCategoryKind.LEAF,
  });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });

  return { category, user, profile, cookie: await loginAs(ctx.prisma, user.id) };
}

function publication(providerId: string, cookie: string) {
  return request(ctx.server)
    .get(`/providers/${providerId}/showcase/publication`)
    .set('Cookie', cookie);
}

describe('the state one card is in', () => {
  it('reads as "the sale terms are outstanding", not as "the terms have changed"', async () => {
    const { category, profile, cookie } = await business();
    const { card } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: profile.id,
      categoryId: category.id,
    });

    const response = await publication(profile.id, cookie);

    expect(response.status).toBe(200);
    expect(response.body.cards).toHaveLength(1);
    expect(response.body.cards[0]).toMatchObject({
      cardId: card.id,
      state: 'TERMS_REQUIRED',
      endAt: null,
      checkoutUrl: null,
    });
  });

  it('reads as ready to publish once the terms in force are accepted', async () => {
    const { category, profile, user, cookie } = await business();
    const { card } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: profile.id,
      categoryId: category.id,
    });
    await acceptShowcasePriceTerms(ctx.prisma, {
      providerId: profile.id,
      cardId: card.id,
      userId: user.id,
    });

    const response = await publication(profile.id, cookie);

    expect(response.body.cards[0].state).toBe('READY_TO_PUBLISH');
    // Nothing has been bought, so nothing claims a business has published.
    expect(response.body.hasPublicationHistory).toBe(false);
  });

  it('reads as live, with the date the provider actually needs', async () => {
    const { category, profile, cookie } = await business();
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: profile.id,
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    });
    await createLiveShowcasePlacement(ctx, {
      providerId: profile.id,
      cardId: card.id,
      versionId: version.id,
      packageId: (await createShowcasePackage(ctx.prisma)).id,
    });

    const response = await publication(profile.id, cookie);
    const entry = response.body.cards[0];

    expect(entry.state).toBe('LIVE');
    expect(typeof entry.endAt).toBe('string');
    // Worded on the server, because how a card states its promise is a product
    // decision and two renderers of it would eventually disagree.
    expect(entry.areaLabels).toEqual(['Kadıköy, İstanbul']);
    expect(response.body.hasPublicationHistory).toBe(true);
  });

  it('reads as a plain draft before anything has been submitted', async () => {
    const { category, profile, cookie } = await business();
    await ctx.prisma.showcaseCard.create({
      data: { providerId: profile.id, kind: 'SERVICE', categoryId: category.id, status: 'DRAFT' },
    });

    const response = await publication(profile.id, cookie);

    expect(response.body.cards[0].state).toBe('DRAFT');
  });

  it('carries nothing a provider cannot act on', async () => {
    const { category, profile, cookie } = await business();
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: profile.id,
      categoryId: category.id,
    });
    await createLiveShowcasePlacement(ctx, {
      providerId: profile.id,
      cardId: card.id,
      versionId: version.id,
      packageId: (await createShowcasePackage(ctx.prisma)).id,
    });

    const entry = (await publication(profile.id, cookie)).body.cards[0];

    expect(Object.keys(entry).sort()).toEqual(
      [
        'areaLabels',
        'cardId',
        'checkoutUrl',
        'endAt',
        'hasPendingRevision',
        'leadCount',
        'packageName',
        'purchaseId',
        'state',
      ].sort(),
    );
  });

  it('refuses another business’s panel', async () => {
    const mine = await business();
    const theirs = await business();

    const response = await publication(theirs.profile.id, mine.cookie);

    expect(response.status).toBe(403);
  });
});
