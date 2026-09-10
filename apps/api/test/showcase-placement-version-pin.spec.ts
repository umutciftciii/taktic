import { ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  showcaseUpdatePayload,
  SHOWCASE_SUBMIT_BODY,
  type TestContext,
} from './harness';

/**
 * A paid run follows its card's live version.
 *
 * ## Why it follows at all
 *
 * The alternative is a run publishing last week's text after somebody decided
 * this week's should be live — which would mean the home page and the card's own
 * page saying different things about the same business, and the home page
 * showing words nobody currently stands behind.
 *
 * Both paths that make a version live re-pin, in the same transaction as the
 * publication: an operator's approval, and the narrowing rule's auto-publish.
 * A version that is merely *submitted* changes nothing, which is the second
 * case here — an edit under review must not reach the public before the
 * reviewer does.
 *
 * ## What re-pinning does not do
 *
 * It never touches `endAt`. Re-pinning is a change to what is shown, not to
 * what was bought, and a widening approval that also extended the run would be
 * a way to buy time by editing text.
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
  const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: providerUser.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
    providerId: profile.id,
    categoryId: category.id,
    areas: [
      { city: 'İstanbul', district: 'Kadıköy' },
      { city: 'İstanbul', district: 'Üsküdar' },
    ],
  });
  const pkg = await createShowcasePackage(ctx.prisma);
  const { placement } = await createLiveShowcasePlacement(ctx, {
    providerId: profile.id,
    cardId: card.id,
    versionId: version.id,
    packageId: pkg.id,
  });
  const adminUser = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

  return {
    category,
    profile,
    card,
    version,
    placement,
    providerCookie: await loginAs(ctx.prisma, providerUser.id),
    adminCookie: await loginAs(ctx.prisma, adminUser.id),
  };
}

/** The live version's content, in the shape the edit endpoint takes. */
async function liveContent(cardId: string) {
  const card = await ctx.prisma.showcaseCard.findUniqueOrThrow({
    where: { id: cardId },
    include: { liveVersion: true },
  });
  const version = card.liveVersion!;

  return {
    title: version.title,
    summary: version.summary,
    scopeIncluded: version.scopeIncluded,
    scopeExcluded: version.scopeExcluded,
    listedServicePriceAmount: version.listedServicePriceAmount,
    responseSlaUrgentHours: version.responseSlaUrgentHours,
    responseSlaNormalHours: version.responseSlaNormalHours,
  };
}

function shelfKeys(placementId: string) {
  return ctx.prisma.showcasePlacementShelf
    .findMany({ where: { placementId }, orderBy: { areaKey: 'asc' } })
    .then((rows) => rows.map((row) => row.areaKey));
}

describe('an operator approving a new version', () => {
  it('moves the run onto it, refreshes the shelves and records the move', async () => {
    const { card, category, profile, placement, version, providerCookie, adminCookie } =
      await scenario();

    const edited = await request(ctx.server)
      .patch(`/providers/${profile.id}/showcase/cards/${card.id}`)
      .set('Cookie', providerCookie)
      .send(
        showcaseUpdatePayload(category.id, {
          title: 'Yenilenen başlık',
          areas: [
            { city: 'İstanbul', district: 'Kadıköy' },
            { city: 'İstanbul', district: 'Üsküdar' },
            { city: 'İstanbul', district: 'Ataşehir' },
          ],
        }),
      );
    expect(edited.status).toBe(200);

    const draft = await ctx.prisma.showcaseCardVersion.findFirstOrThrow({
      where: { cardId: card.id, reviewStatus: 'DRAFT' },
    });

    await request(ctx.server)
      .post(`/providers/${profile.id}/showcase/cards/${card.id}/submit`)
      .set('Cookie', providerCookie)
      .send(SHOWCASE_SUBMIT_BODY);

    const endBefore = placement.endAt;

    const approved = await request(ctx.server)
      .post(`/admin/showcase/versions/${draft.id}/approve`)
      .set('Cookie', adminCookie)
      .send({});
    expect(approved.status).toBe(200);

    const after = await ctx.prisma.showcasePlacement.findUniqueOrThrow({
      where: { id: placement.id },
    });
    expect(after.pinnedVersionId).toBe(draft.id);
    // Re-pinning is a change to what is shown, never to what was bought.
    expect(after.endAt.getTime()).toBe(endBefore.getTime());

    // Widening is allowed and simply grows the shelves — an earlier design
    // refused an overlapping shelf, and that refusal is what made a second card
    // unsellable.
    expect(await shelfKeys(placement.id)).toHaveLength(3);

    const change = await ctx.prisma.showcasePlacementVersionChange.findFirstOrThrow({
      where: { placementId: placement.id },
    });
    expect(change.fromVersionId).toBe(version.id);
    expect(change.toVersionId).toBe(draft.id);
    expect(change.trigger).toBe('ADMIN_APPROVAL');
  });

  it('leaves the run on the old text while the new one is only submitted', async () => {
    const { card, category, profile, placement, version, providerCookie } = await scenario();

    await request(ctx.server)
      .patch(`/providers/${profile.id}/showcase/cards/${card.id}`)
      .set('Cookie', providerCookie)
      .send(showcaseUpdatePayload(category.id, { title: 'Beklemede' }));

    await request(ctx.server)
      .post(`/providers/${profile.id}/showcase/cards/${card.id}/submit`)
      .set('Cookie', providerCookie)
      .send(SHOWCASE_SUBMIT_BODY);

    const after = await ctx.prisma.showcasePlacement.findUniqueOrThrow({
      where: { id: placement.id },
    });
    // An edit under review must not reach the public before the reviewer does.
    expect(after.pinnedVersionId).toBe(version.id);
    expect(await ctx.prisma.showcasePlacementVersionChange.count()).toBe(0);
  });

  it('leaves the run alone when the new version is refused', async () => {
    const { card, category, profile, placement, version, providerCookie, adminCookie } =
      await scenario();

    await request(ctx.server)
      .patch(`/providers/${profile.id}/showcase/cards/${card.id}`)
      .set('Cookie', providerCookie)
      .send(showcaseUpdatePayload(category.id, { title: 'Reddedilecek' }));

    const draft = await ctx.prisma.showcaseCardVersion.findFirstOrThrow({
      where: { cardId: card.id, reviewStatus: 'DRAFT' },
    });

    await request(ctx.server)
      .post(`/providers/${profile.id}/showcase/cards/${card.id}/submit`)
      .set('Cookie', providerCookie)
      .send(SHOWCASE_SUBMIT_BODY);

    await request(ctx.server)
      .post(`/admin/showcase/versions/${draft.id}/reject`)
      .set('Cookie', adminCookie)
      .send({ note: 'Başlık yeterince açık değil.' });

    const after = await ctx.prisma.showcasePlacement.findUniqueOrThrow({
      where: { id: placement.id },
    });
    // Refusing a replacement never takes a working card off the air.
    expect(after.pinnedVersionId).toBe(version.id);
  });
});

describe('the narrowing rule', () => {
  it('publishes without an operator, shrinks the shelves, and leaves the clock alone', async () => {
    const { card, profile, placement, version, providerCookie } = await scenario();
    const endBefore = placement.endAt;

    /*
     * Removing areas and changing **nothing else** publishes itself — narrowing
     * your own reach needs nobody's permission.
     *
     * The body is rebuilt from the live version's own fields rather than from
     * the payload helper, because the rule is a whole-content comparison: a
     * single different character in the title makes this an ordinary edit that
     * goes to review, which is correct and is what the case above covers.
     */
    const narrowed = await request(ctx.server)
      .patch(`/providers/${profile.id}/showcase/cards/${card.id}`)
      .set('Cookie', providerCookie)
      .send({
        ...(await liveContent(card.id)),
        areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
      });
    expect(narrowed.status).toBe(200);

    const after = await ctx.prisma.showcasePlacement.findUniqueOrThrow({
      where: { id: placement.id },
    });
    expect(after.pinnedVersionId).not.toBe(version.id);
    expect(await shelfKeys(placement.id)).toHaveLength(1);
    // Narrowing is the provider's own choice; giving time back for it would let
    // a run be shrunk on Monday and restored on Friday with the clock stopped.
    expect(after.endAt.getTime()).toBe(endBefore.getTime());

    const change = await ctx.prisma.showcasePlacementVersionChange.findFirstOrThrow({
      where: { placementId: placement.id },
    });
    expect(change.trigger).toBe('AREA_NARROWING');
  });
});

describe('the re-pin audit', () => {
  it('records one move per destination version', async () => {
    const { placement, version } = await scenario();

    await expect(
      ctx.prisma.showcasePlacementVersionChange.create({
        data: {
          placementId: placement.id,
          fromVersionId: version.id,
          toVersionId: version.id,
          trigger: 'ADMIN_APPROVAL',
        },
      }),
      // `ShowcasePlacementVersionChange_moves`: a re-pin moves somewhere else.
    ).rejects.toThrow();
  });
});
