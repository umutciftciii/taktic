import { ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createShowcaseEntitlement,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  showcaseCardPayload,
  showcaseUpdatePayload,
  type TestContext,
} from './harness';

/**
 * Where a card stands, resolved once on the server — now against the
 * package-first flow: a right, not a checkout, is what a provider holds.
 *
 * ## The defect this endpoint exists to end
 *
 * The provider's panel used to answer "where does this card stand" by
 * assembling four independent reads on the screen: the card's `status`, the
 * pair of versions and their `reviewStatus`, the placement list filtered by
 * three enum members, and an eligibility dry run whose *refusal code* decided
 * which of three mutually exclusive panels to render.
 *
 * Phase two replaces "money in flight" with "a right reserved or on the
 * shelf" as the thing this resolves against. There is exactly one state per
 * card, exactly one thing to do about it, and the reserved right — not a
 * pending purchase — travels beside it so the screen can say what it is
 * worth and whether review time is being charged against it.
 *
 * ## What the response may not carry
 *
 * Placement ids, version ids, purchase ids, the right's own id, raw enum
 * members. None of them is something a provider acts on, and every one of
 * them is something that turns into a support conversation the moment it
 * reaches a screen.
 */
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

async function scenario() {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const pkg = await createShowcasePackage(ctx.prisma, { durationDays: 30 });
  await createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id });
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

  return {
    category,
    user,
    profile,
    pkg,
    cookie: await loginAs(ctx.prisma, user.id),
    adminCookie: await loginAs(ctx.prisma, admin.id),
  };
}

function publication(providerId: string, cookie: string) {
  return request(ctx.server)
    .get(`/providers/${providerId}/showcase/publication`)
    .set('Cookie', cookie)
    .then((response) => response.body);
}

describe('the state one card is in', () => {
  it('reads as a draft holding a right, then in review, then rejected — never losing the note', async () => {
    const s = await scenario();
    const created = await request(ctx.server)
      .post(`/providers/${s.profile.id}/showcase/cards`)
      .set('Cookie', s.cookie)
      .send(showcaseCardPayload(s.category.id));
    const cardId = created.body.id as string;

    let list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({ cardId, state: 'DRAFT', needsPackage: false });
    expect(list.cards[0].entitlement).toMatchObject({ durationDays: 30, pausedForReview: false });
    expect(list.availableEntitlements).toHaveLength(0);

    const submitted = await request(ctx.server)
      .post(`/providers/${s.profile.id}/showcase/cards/${cardId}/submit`)
      .set('Cookie', s.cookie)
      .send({});
    list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({ state: 'IN_REVIEW' });
    expect(list.cards[0].entitlement?.pausedForReview).toBe(true);

    await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.body.draftVersion.id}/reject`)
      .set('Cookie', s.adminCookie)
      .send({ note: 'Başlık çok genel, düzeltin.' });
    list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({ state: 'REJECTED', needsPackage: false });

    // The right expires underneath the rejected card: still REJECTED, now flagged.
    await ctx.prisma.showcaseEntitlement.updateMany({
      where: { cardId },
      data: {
        grantedAt: new Date(Date.now() - 2 * DAY),
        expiresAt: new Date(Date.now() - DAY),
      },
    });
    list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({ state: 'REJECTED', needsPackage: true, entitlement: null });
  });

  it('reads a draft without a right as needing a package, and lists the rights on the shelf', async () => {
    const s = await scenario();
    const created = await request(ctx.server)
      .post(`/providers/${s.profile.id}/showcase/cards`)
      .set('Cookie', s.cookie)
      .send(showcaseCardPayload(s.category.id));
    await request(ctx.server)
      .post(`/providers/${s.profile.id}/showcase/cards/${created.body.id}/archive`)
      .set('Cookie', s.cookie)
      .send({});
    // Archived-never-published cards are hidden; the released right is back.
    let list = await publication(s.profile.id, s.cookie);
    expect(list.cards).toHaveLength(0);
    expect(list.availableEntitlements).toHaveLength(1);

    await request(ctx.server)
      .post(`/providers/${s.profile.id}/showcase/cards/${created.body.id}/unarchive`)
      .set('Cookie', s.cookie)
      .send({});
    list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({ state: 'NEEDS_PACKAGE', needsPackage: true, hasRunBefore: false });
  });

  it('reads as live with the end date, then as expired needing a package', async () => {
    const s = await scenario();
    const created = await request(ctx.server)
      .post(`/providers/${s.profile.id}/showcase/cards`)
      .set('Cookie', s.cookie)
      .send(showcaseCardPayload(s.category.id));
    const submitted = await request(ctx.server)
      .post(`/providers/${s.profile.id}/showcase/cards/${created.body.id}/submit`)
      .set('Cookie', s.cookie)
      .send({});
    await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.body.draftVersion.id}/approve`)
      .set('Cookie', s.adminCookie)
      .send({});

    let list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0].state).toBe('LIVE');
    expect(list.cards[0].endAt).not.toBeNull();
    expect(list.hasPublicationHistory).toBe(true);

    await ctx.prisma.showcasePlacement.updateMany({
      where: { cardId: created.body.id },
      data: { status: 'EXPIRED' },
    });
    list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({ state: 'EXPIRED', hasRunBefore: true, needsPackage: true });
  });

  it('stays LIVE with a pending revision flagged, then EXPIRED with the flag and the package need both true', async () => {
    const s = await scenario();
    const created = await request(ctx.server)
      .post(`/providers/${s.profile.id}/showcase/cards`)
      .set('Cookie', s.cookie)
      .send(showcaseCardPayload(s.category.id));
    const cardId = created.body.id as string;
    const submitted = await request(ctx.server)
      .post(`/providers/${s.profile.id}/showcase/cards/${cardId}/submit`)
      .set('Cookie', s.cookie)
      .send({});
    await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.body.draftVersion.id}/approve`)
      .set('Cookie', s.adminCookie)
      .send({});

    // A revision needs no right of its own — it is text on a card already on
    // the air, not a new publication.
    await request(ctx.server)
      .patch(`/providers/${s.profile.id}/showcase/cards/${cardId}`)
      .set('Cookie', s.cookie)
      .send(showcaseUpdatePayload(s.category.id, { title: 'Klima bakımı, aynı gün' }));
    await request(ctx.server)
      .post(`/providers/${s.profile.id}/showcase/cards/${cardId}/submit`)
      .set('Cookie', s.cookie)
      .send({});

    let list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({ state: 'LIVE', hasPendingRevision: true });

    await ctx.prisma.showcasePlacement.updateMany({
      where: { cardId },
      data: { status: 'EXPIRED' },
    });
    list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({
      state: 'EXPIRED',
      hasPendingRevision: true,
      needsPackage: true,
    });
  });

  it('reads a run bought before rights existed as expired needing a package', async () => {
    const s = await scenario();
    const { card } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: s.profile.id,
      categoryId: s.category.id,
    });

    const list = await publication(s.profile.id, s.cookie);
    expect(list.cards.find((entry: { cardId: string }) => entry.cardId === card.id)).toMatchObject({
      state: 'EXPIRED',
      hasRunBefore: false,
      needsPackage: true,
    });
  });

  it('carries nothing a provider cannot act on', async () => {
    const s = await scenario();
    const created = await request(ctx.server)
      .post(`/providers/${s.profile.id}/showcase/cards`)
      .set('Cookie', s.cookie)
      .send(showcaseCardPayload(s.category.id));
    const submitted = await request(ctx.server)
      .post(`/providers/${s.profile.id}/showcase/cards/${created.body.id}/submit`)
      .set('Cookie', s.cookie)
      .send({});
    await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.body.draftVersion.id}/approve`)
      .set('Cookie', s.adminCookie)
      .send({});
    // A second, unspent right so `availableEntitlements` is exercised too —
    // the first was already consumed by the approval above.
    await createShowcaseEntitlement(ctx, {
      providerId: s.profile.id,
      userId: s.user.id,
      packageId: s.pkg.id,
    });

    const list = await publication(s.profile.id, s.cookie);
    const entry = list.cards[0];

    // An exact key set, not a substring search: a raw id sitting under a
    // different key name (`liveVersionId`, `entitlementId`, a nested `{ id }`)
    // would slip straight through a `not.toContain('placementId')` check.
    expect(Object.keys(entry).sort()).toEqual(
      [
        'areaLabels',
        'cardId',
        'endAt',
        'entitlement',
        'hasPendingRevision',
        'hasRunBefore',
        'leadCount',
        'needsPackage',
        'packageName',
        'state',
      ].sort(),
    );
    if (entry.entitlement !== null) {
      expect(Object.keys(entry.entitlement).sort()).toEqual(
        ['durationDays', 'expiresAt', 'packageName', 'pausedForReview'].sort(),
      );
    }
    expect(Object.keys(list).sort()).toEqual(
      ['availableEntitlements', 'cards', 'hasPublicationHistory'].sort(),
    );
    expect(list.availableEntitlements).toHaveLength(1);
    for (const available of list.availableEntitlements) {
      expect(Object.keys(available).sort()).toEqual(
        ['allowedCardKind', 'durationDays', 'expiresAt', 'id', 'packageName'].sort(),
      );
    }
  });

  it('refuses another business’s panel', async () => {
    const mine = await scenario();
    const theirs = await scenario();

    const response = await request(ctx.server)
      .get(`/providers/${theirs.profile.id}/showcase/publication`)
      .set('Cookie', mine.cookie);

    expect(response.status).toBe(403);
  });
});
