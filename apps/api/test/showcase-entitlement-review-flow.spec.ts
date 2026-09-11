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
 * The package-first flow end to end: a right opens a card, the clock stops
 * while an operator reads it, a refusal hands the time back, and the first
 * approval spends the right and puts the card on the air in one transaction.
 *
 * The status codes below are the routes' own: the existing provider and admin
 * actions answer 200 ("the same resource, changed"), and the new
 * `use-entitlement` action answers 201 because it can birth a placement.
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

const DAY = 24 * 60 * 60 * 1000;

async function scenario(options: { rights?: number } = {}) {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const pkg = await createShowcasePackage(ctx.prisma, { durationDays: 30 });
  const rights = [];
  for (let i = 0; i < (options.rights ?? 1); i += 1) {
    rights.push(
      await createShowcaseEntitlement(ctx, {
        providerId: profile.id,
        userId: user.id,
        packageId: pkg.id,
      }),
    );
  }
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return {
    category,
    user,
    profile,
    pkg,
    rights,
    /** The first right's id — every single-right case reads it, and `rights[0]` is possibly undefined to the checker. */
    rightId: rights[0]?.entitlement.id ?? '',
    cookie: await loginAs(ctx.prisma, user.id),
    adminCookie: await loginAs(ctx.prisma, admin.id),
  };
}

const api = () => request(ctx.server);
const createCard = (
  providerId: string,
  cookie: string,
  categoryId: string,
  extra: Record<string, unknown> = {},
) =>
  api()
    .post(`/providers/${providerId}/showcase/cards`)
    .set('Cookie', cookie)
    .send({ ...showcaseCardPayload(categoryId), ...extra });
const submit = (providerId: string, cardId: string, cookie: string) =>
  api()
    .post(`/providers/${providerId}/showcase/cards/${cardId}/submit`)
    .set('Cookie', cookie)
    .send({});
const useEntitlement = (
  providerId: string,
  cardId: string,
  cookie: string,
  body: Record<string, unknown> = {},
) =>
  api()
    .post(`/providers/${providerId}/showcase/cards/${cardId}/use-entitlement`)
    .set('Cookie', cookie)
    .send(body);
const approve = (versionId: string, cookie: string) =>
  api().post(`/admin/showcase/versions/${versionId}/approve`).set('Cookie', cookie).send({});
const reject = (versionId: string, cookie: string) =>
  api()
    .post(`/admin/showcase/versions/${versionId}/reject`)
    .set('Cookie', cookie)
    .send({ note: 'Başlık çok genel, düzeltin.' });

describe('a provider without a package', () => {
  it('cannot open a card', async () => {
    const { profile, cookie, category } = await scenario({ rights: 0 });
    const response = await createCard(profile.id, cookie, category.id);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_ENTITLEMENT_REQUIRED');
    expect(await ctx.prisma.showcaseCard.count()).toBe(0);
  });
});

describe('one right, one card', () => {
  it('reserves on creation, pauses in review, keeps the right through a rejection, consumes on first approval', async () => {
    const { profile, cookie, adminCookie, category, rightId } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    expect(created.status).toBe(201);
    const cardId = created.body.id as string;
    let right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({
      where: { id: rightId },
    });
    expect(right.status).toBe('RESERVED');
    expect(right.cardId).toBe(cardId);

    // Submit: no checkbox, the terms come from the right.
    const submitted = await submit(profile.id, cardId, cookie);
    expect(submitted.status).toBe(200);
    expect(submitted.body.draftVersion.priceTermsVersion).toBe('v1');
    right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: right.id } });
    expect(right.reviewPausedAt).not.toBeNull();
    const versionId = submitted.body.draftVersion.id as string;

    // Reject: right stays reserved, clock resumes, pause row closed.
    expect((await reject(versionId, adminCookie)).status).toBe(200);
    right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: right.id } });
    expect(right.status).toBe('RESERVED');
    expect(right.reviewPausedAt).toBeNull();
    expect(
      await ctx.prisma.showcaseEntitlementReviewPause.count({
        where: { entitlementId: right.id, endReason: 'REJECTED' },
      }),
    ).toBe(1);

    // Edit → new draft → resubmit → approve.
    const edited = await api()
      .patch(`/providers/${profile.id}/showcase/cards/${cardId}`)
      .set('Cookie', cookie)
      .send(showcaseUpdatePayload(category.id, { title: 'Klima bakımı, aynı gün' }));
    expect(edited.status).toBe(200);
    const resubmitted = await submit(profile.id, cardId, cookie);
    expect(resubmitted.status).toBe(200);
    const secondVersionId = resubmitted.body.draftVersion.id as string;
    expect(secondVersionId).not.toBe(versionId);

    const approved = await approve(secondVersionId, adminCookie);
    expect(approved.status).toBe(200);

    right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: right.id } });
    expect(right.status).toBe('CONSUMED');
    expect(right.placementId).not.toBeNull();
    const placement = await ctx.prisma.showcasePlacement.findUniqueOrThrow({
      where: { id: right.placementId! },
    });
    expect(placement.status).toBe('ACTIVE');
    expect(placement.cardId).toBe(cardId);
    expect(placement.pinnedVersionId).toBe(secondVersionId);
    expect(placement.endAt.getTime() - placement.startAt.getTime()).toBe(30 * DAY);
    expect(
      await ctx.prisma.showcaseEntitlementReviewPause.count({
        where: { entitlementId: right.id, endReason: 'CONSUMED' },
      }),
    ).toBe(1);

    // The card is on the public feed now, and only now.
    const card = await ctx.prisma.showcaseCard.findUniqueOrThrow({ where: { id: cardId } });
    expect(card.status).toBe('APPROVED');
    expect(card.liveVersionId).toBe(secondVersionId);
  });

  it('an approval with an expired right changes nothing; a paused right is never expired', async () => {
    const { profile, cookie, adminCookie, category, rightId } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    const cardId = created.body.id as string;
    // Right expired *before* submission (the provider sat on it). The window
    // CHECK insists `expiresAt > grantedAt`, so the grant moves back with it.
    await ctx.prisma.showcaseEntitlement.update({
      where: { id: rightId },
      data: { grantedAt: new Date(Date.now() - 2 * DAY), expiresAt: new Date(Date.now() - DAY) },
    });

    const refused = await submit(profile.id, cardId, cookie);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SHOWCASE_ENTITLEMENT_REQUIRED');

    // Restore the right, submit, then let the window pass *during* review.
    await ctx.prisma.showcaseEntitlement.update({
      where: { id: rightId },
      data: { expiresAt: new Date(Date.now() + DAY) },
    });
    const submitted = await submit(profile.id, cardId, cookie);
    expect(submitted.status).toBe(200);
    const versionId = submitted.body.draftVersion.id as string;

    // Rewind the whole story rather than only the deadline: the right was
    // granted three days ago and would have ended yesterday, and the card has
    // been with the operator for two days. The pause froze `expiresAt` when it
    // opened, so the ledger row's snapshot is moved with it.
    const pausedAt = new Date(Date.now() - 2 * DAY);
    const wouldHaveExpiredAt = new Date(Date.now() - DAY);
    await ctx.prisma.showcaseEntitlement.update({
      where: { id: rightId },
      data: {
        grantedAt: new Date(Date.now() - 3 * DAY),
        expiresAt: wouldHaveExpiredAt,
        reviewPausedAt: pausedAt,
      },
    });
    await ctx.prisma.showcaseEntitlementReviewPause.updateMany({
      where: { entitlementId: rightId, endedAt: null },
      data: { startedAt: pausedAt, expiresAtBefore: wouldHaveExpiredAt },
    });

    const approved = await approve(versionId, adminCookie);
    expect(approved.status).toBe(200);
    const consumed = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({
      where: { id: rightId },
    });
    expect(consumed.status).toBe('CONSUMED');
    // The two days under review were given back before the right was spent.
    expect(consumed.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(consumed.totalPausedSeconds).toBeGreaterThanOrEqual(2 * 24 * 60 * 60 - 5);
  });

  it('refuses to approve a first version whose card lost its right, and writes nothing', async () => {
    const { profile, cookie, adminCookie, category, rightId } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    const cardId = created.body.id as string;
    const submitted = await submit(profile.id, cardId, cookie);
    const versionId = submitted.body.draftVersion.id as string;
    // Simulate the right vanishing underneath the review (sweeper or data fault).
    await ctx.prisma.showcaseEntitlement.update({
      where: { id: rightId },
      data: { status: 'EXPIRED', cardId: null, reservedAt: null, reviewPausedAt: null },
    });

    const refused = await approve(versionId, adminCookie);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SHOWCASE_ENTITLEMENT_MISSING');
    const version = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(version.reviewStatus).toBe('PENDING');
    expect(await ctx.prisma.showcaseCardReview.count()).toBe(0);
    expect(await ctx.prisma.showcasePlacement.count()).toBe(0);
  });

  it('deleting the card before approval releases the right, even from inside review', async () => {
    const { profile, cookie, category, rightId } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    const cardId = created.body.id as string;
    await submit(profile.id, cardId, cookie);

    const archived = await api()
      .post(`/providers/${profile.id}/showcase/cards/${cardId}/archive`)
      .set('Cookie', cookie)
      .send({});
    expect(archived.status).toBe(200);

    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({
      where: { id: rightId },
    });
    expect(right.status).toBe('AVAILABLE');
    expect(right.cardId).toBeNull();
    expect(right.reviewPausedAt).toBeNull();
    expect(
      await ctx.prisma.showcaseEntitlementReviewPause.count({
        where: { entitlementId: right.id, endReason: 'RELEASED' },
      }),
    ).toBe(1);
    expect(await ctx.prisma.showcaseSubmissionWithdrawal.count({ where: { cardId } })).toBe(1);
    const version = await ctx.prisma.showcaseCardVersion.findFirstOrThrow({ where: { cardId } });
    expect(version.reviewStatus).toBe('DRAFT');

    // And the same right opens a new card.
    expect((await createCard(profile.id, cookie, category.id)).status).toBe(201);
  });
});

describe('several rights', () => {
  it('lets each right open its own card, and refuses a third card', async () => {
    const { profile, cookie, category } = await scenario({ rights: 2 });
    expect((await createCard(profile.id, cookie, category.id)).status).toBe(201);
    expect((await createCard(profile.id, cookie, category.id)).status).toBe(201);
    const third = await createCard(profile.id, cookie, category.id);
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('SHOWCASE_ENTITLEMENT_REQUIRED');
    expect(await ctx.prisma.showcaseEntitlement.count({ where: { status: 'RESERVED' } })).toBe(2);
    expect(await ctx.prisma.showcaseCard.count()).toBe(2);
  });

  it('lets the provider name which right a card should use', async () => {
    const { profile, cookie, category, rights } = await scenario({ rights: 2 });
    const chosen = rights[1]?.entitlement.id ?? '';
    const created = await createCard(profile.id, cookie, category.id, { entitlementId: chosen });
    expect(created.status).toBe(201);
    expect(
      (await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: chosen } })).cardId,
    ).toBe(created.body.id);
  });
});

describe('an already-approved card', () => {
  it('goes on the air immediately when a right is attached, and needs a new package once it expires', async () => {
    const { profile, cookie, category, user, pkg } = await scenario({ rights: 0 });
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: profile.id,
      categoryId: category.id,
    });

    const noRight = await useEntitlement(profile.id, card.id, cookie);
    expect(noRight.status).toBe(409);
    expect(noRight.body.code).toBe('SHOWCASE_ENTITLEMENT_REQUIRED');

    await createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id });
    const attached = await useEntitlement(profile.id, card.id, cookie);
    expect(attached.status).toBe(201);
    expect(attached.body.id).toBe(card.id);
    const placement = await ctx.prisma.showcasePlacement.findFirstOrThrow({
      where: { cardId: card.id },
    });
    expect(placement.status).toBe('ACTIVE');
    expect(placement.pinnedVersionId).toBe(version.id);
    expect(
      await ctx.prisma.showcaseEntitlement.count({ where: { status: 'CONSUMED', cardId: card.id } }),
    ).toBe(1);

    // While the run is on, a second right cannot be stacked onto the card.
    await createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id });
    const stacked = await useEntitlement(profile.id, card.id, cookie);
    expect(stacked.status).toBe(409);
    expect(stacked.body.code).toBe('SHOWCASE_CARD_ALREADY_PLACED');
    expect(await ctx.prisma.showcaseEntitlement.count({ where: { status: 'AVAILABLE' } })).toBe(1);

    // Expire the run; the waiting right republishes. (`endAt > startAt` is a
    // CHECK, so the whole window moves into the past.)
    await ctx.prisma.showcasePlacement.update({
      where: { id: placement.id },
      data: {
        status: 'EXPIRED',
        startAt: new Date(Date.now() - 2 * DAY),
        endAt: new Date(Date.now() - DAY),
      },
    });
    const again = await useEntitlement(profile.id, card.id, cookie);
    expect(again.status).toBe(201);
    expect(
      await ctx.prisma.showcasePlacement.count({ where: { cardId: card.id, status: 'ACTIVE' } }),
    ).toBe(1);
    expect(
      await ctx.prisma.showcaseEntitlement.count({ where: { status: 'CONSUMED', cardId: card.id } }),
    ).toBe(2);
  });

  it('attaching a right to a first version already in the queue pauses it, and the approval then spends it', async () => {
    const { profile, cookie, adminCookie, category, user, pkg, rightId } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    const cardId = created.body.id as string;
    const submitted = await submit(profile.id, cardId, cookie);
    const versionId = submitted.body.draftVersion.id as string;
    // The right vanishes underneath the review; the provider buys another.
    await ctx.prisma.showcaseEntitlement.update({
      where: { id: rightId },
      data: { status: 'EXPIRED', cardId: null, reservedAt: null, reviewPausedAt: null },
    });
    const { entitlement: second } = await createShowcaseEntitlement(ctx, {
      providerId: profile.id,
      userId: user.id,
      packageId: pkg.id,
    });

    const attached = await useEntitlement(profile.id, cardId, cookie, { entitlementId: second.id });
    expect(attached.status).toBe(201);
    // Not on the air: the version is still with the operator.
    expect(await ctx.prisma.showcasePlacement.count({ where: { cardId } })).toBe(0);
    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: second.id } });
    expect(right.status).toBe('RESERVED');
    expect(right.cardId).toBe(cardId);
    expect(right.reviewPausedAt).not.toBeNull();

    // A second attach while one right is reserved is refused.
    await createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id });
    const stacked = await useEntitlement(profile.id, cardId, cookie);
    expect(stacked.status).toBe(409);
    expect(stacked.body.code).toBe('SHOWCASE_ENTITLEMENT_UNAVAILABLE');

    expect((await approve(versionId, adminCookie)).status).toBe(200);
    expect(
      (await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: second.id } })).status,
    ).toBe('CONSUMED');
    expect(await ctx.prisma.showcasePlacement.count({ where: { cardId, status: 'ACTIVE' } })).toBe(1);
  });

  it('submits a revision without a right, carrying the consumed right’s terms', async () => {
    const { profile, cookie, adminCookie, category, rightId } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    const cardId = created.body.id as string;
    const first = await submit(profile.id, cardId, cookie);
    expect((await approve(first.body.draftVersion.id, adminCookie)).status).toBe(200);

    await api()
      .patch(`/providers/${profile.id}/showcase/cards/${cardId}`)
      .set('Cookie', cookie)
      .send(showcaseUpdatePayload(category.id, { title: 'Klima bakımı — güncellendi' }));
    const revision = await submit(profile.id, cardId, cookie);
    expect(revision.status).toBe(200);
    expect(revision.body.draftVersion.priceTermsVersion).toBe('v1');
    expect(await ctx.prisma.showcaseEntitlement.count({ where: { status: 'RESERVED' } })).toBe(0);
    expect(
      (
        await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({
          where: { id: rightId },
        })
      ).reviewPausedAt,
    ).toBeNull();

    // Approving the revision re-pins the existing run rather than opening another.
    expect((await approve(revision.body.draftVersion.id, adminCookie)).status).toBe(200);
    expect(await ctx.prisma.showcasePlacement.count({ where: { cardId } })).toBe(1);
    const placement = await ctx.prisma.showcasePlacement.findFirstOrThrow({ where: { cardId } });
    expect(placement.pinnedVersionId).toBe(revision.body.draftVersion.id);
  });

  it('refuses a revision on a legacy approved card that has never been on the air', async () => {
    const { profile, cookie, category } = await scenario({ rights: 0 });
    const { card } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: profile.id,
      categoryId: category.id,
    });
    await api()
      .patch(`/providers/${profile.id}/showcase/cards/${card.id}`)
      .set('Cookie', cookie)
      .send(showcaseUpdatePayload(category.id, { title: 'Yeni başlık' }));
    const refused = await submit(profile.id, card.id, cookie);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SHOWCASE_REVISION_NEEDS_PUBLICATION');
  });
});

describe('the operator’s view of a version', () => {
  it('shows the reserved right behind a first submission, and nothing for a revision', async () => {
    const { profile, cookie, adminCookie, category } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    const cardId = created.body.id as string;
    const submitted = await submit(profile.id, cardId, cookie);
    const versionId = submitted.body.draftVersion.id as string;

    const pending = await api()
      .get(`/admin/showcase/versions/${versionId}`)
      .set('Cookie', adminCookie);
    expect(pending.status).toBe(200);
    expect(pending.body.entitlement).toMatchObject({
      durationDays: 30,
      pausedForReview: true,
      valid: true,
    });
    expect(typeof pending.body.entitlement.packageName).toBe('string');
    expect(typeof pending.body.entitlement.expiresAt).toBe('string');

    await approve(versionId, adminCookie);
    const approved = await api()
      .get(`/admin/showcase/versions/${versionId}`)
      .set('Cookie', adminCookie);
    expect(approved.body.entitlement).toBeNull();
  });
});
