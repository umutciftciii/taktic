import { ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ShowcaseEntitlementService } from '../src/modules/showcase/showcase-entitlement.service';
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
  type TestContext,
} from './harness';

/**
 * ADMIN-BACKEND-TRUTH-002 — a vitrin purchase with a refund reported against
 * it delivers nothing new.
 *
 * The product rule: once a reversal has flagged the purchase for manual review
 * (or it is no longer PAID), its unused right can be neither reserved by a card
 * nor spent on a run. A right already consumed and a run already on the air are
 * left exactly as they are; nothing is deleted, nothing is cancelled. The guard
 * sits on the two real writes — `reserveForCard` and `consumeForCard` — and
 * re-reads the purchase under a row lock inside the writing transaction.
 */

const CODE = 'SHOWCASE_ENTITLEMENT_PURCHASE_UNDER_REVIEW';
const MESSAGE = 'Bu satın alma iade incelemesinde olduğu için vitrin hakkı şu anda kullanılamaz.';

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
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  const grant = () => createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id });
  return {
    category,
    profile,
    grant,
    cookie: await loginAs(ctx.prisma, user.id),
    adminCookie: await loginAs(ctx.prisma, admin.id),
  };
}

/** Exactly what the reversal webhook writes on the purchase (payments-webhook.service.ts). */
async function reportRefund(purchaseId: string) {
  await ctx.prisma.packagePurchase.update({
    where: { id: purchaseId },
    data: { manualReviewReason: 'PAYMENT_REVERSAL_REPORTED', manualReviewAt: new Date() },
  });
}

const api = () => request(ctx.server);
const createCard = (providerId: string, cookie: string, categoryId: string, extra: Record<string, unknown> = {}) =>
  api()
    .post(`/providers/${providerId}/showcase/cards`)
    .set('Cookie', cookie)
    .send({ ...showcaseCardPayload(categoryId), ...extra });
const submit = (providerId: string, cardId: string, cookie: string) =>
  api().post(`/providers/${providerId}/showcase/cards/${cardId}/submit`).set('Cookie', cookie).send({});
const approve = (versionId: string, cookie: string) =>
  api().post(`/admin/showcase/versions/${versionId}/approve`).set('Cookie', cookie).send({});
const useEntitlement = (providerId: string, cardId: string, cookie: string, body: Record<string, unknown> = {}) =>
  api().post(`/providers/${providerId}/showcase/cards/${cardId}/use-entitlement`).set('Cookie', cookie).send(body);

function entitlement(id: string) {
  return ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id } });
}

describe('an AVAILABLE right', () => {
  it('is reserved as before when its purchase is a normal PAID one', async () => {
    const s = await scenario();
    const { entitlement: right } = await s.grant();
    const created = await createCard(s.profile.id, s.cookie, s.category.id).expect(201);
    expect(await entitlement(right.id)).toMatchObject({ status: 'RESERVED', cardId: created.body.id });
  });

  it('cannot be reserved once a refund is reported, and nothing is written', async () => {
    const s = await scenario();
    const { entitlement: right, purchase } = await s.grant();
    await reportRefund(purchase.id);
    const before = await entitlement(right.id);

    for (const extra of [{}, { entitlementId: right.id }]) {
      const refused = await createCard(s.profile.id, s.cookie, s.category.id, extra);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: CODE, message: MESSAGE });
    }
    expect(await entitlement(right.id)).toEqual(before);
    // The card is created in the same transaction as the reservation: rolled back too.
    expect(await ctx.prisma.showcaseCard.count()).toBe(0);
  });

  it('is skipped by an unnamed search when a clean right is there to take', async () => {
    const s = await scenario();
    const flagged = await s.grant();
    const clean = await s.grant();
    await reportRefund(flagged.purchase.id);
    const created = await createCard(s.profile.id, s.cookie, s.category.id).expect(201);
    expect(await entitlement(clean.entitlement.id)).toMatchObject({ status: 'RESERVED', cardId: created.body.id });
    expect(await entitlement(flagged.entitlement.id)).toMatchObject({ status: 'AVAILABLE', cardId: null });
  });

  it('cannot be spent straight onto an approved card through use-entitlement', async () => {
    const s = await scenario();
    const { card } = await createApprovedShowcaseCard(ctx.prisma, { providerId: s.profile.id, categoryId: s.category.id });
    const { entitlement: right, purchase } = await s.grant();
    await reportRefund(purchase.id);

    for (const body of [{}, { entitlementId: right.id }]) {
      const refused = await useEntitlement(s.profile.id, card.id, s.cookie, body);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe(CODE);
    }
    expect(await entitlement(right.id)).toMatchObject({ status: 'AVAILABLE', cardId: null, placementId: null });
    expect(await ctx.prisma.showcasePlacement.count()).toBe(0);
  });
});

describe('a RESERVED right', () => {
  async function submittedCard() {
    const s = await scenario();
    const granted = await s.grant();
    const created = await createCard(s.profile.id, s.cookie, s.category.id).expect(201);
    const submitted = await submit(s.profile.id, created.body.id, s.cookie).expect(200);
    return { ...s, ...granted, cardId: created.body.id as string, versionId: submitted.body.draftVersion.id as string };
  }

  it('is consumed on approval as before for a normal purchase', async () => {
    const s = await submittedCard();
    await approve(s.versionId, s.adminCookie).expect(200);
    expect(await entitlement(s.entitlement.id)).toMatchObject({ status: 'CONSUMED' });
    expect(await ctx.prisma.showcasePlacement.count({ where: { cardId: s.cardId, status: 'ACTIVE' } })).toBe(1);
  });

  it('cannot go live once a refund is reported, and the approval writes nothing', async () => {
    const s = await submittedCard();
    await reportRefund(s.purchase.id);
    const before = await entitlement(s.entitlement.id);

    // A retry answers the same and still writes nothing.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = await approve(s.versionId, s.adminCookie);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: CODE, message: MESSAGE });
    }
    expect(await entitlement(s.entitlement.id)).toEqual(before);
    expect(await ctx.prisma.showcasePlacement.count()).toBe(0);
    expect(await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({ where: { id: s.versionId } })).toMatchObject({
      reviewStatus: 'PENDING',
    });
    expect(await ctx.prisma.showcaseCardReview.count()).toBe(0);
  });
});

describe('what was already delivered', () => {
  it('leaves a CONSUMED right and its active run exactly as they are', async () => {
    const s = await scenario();
    const { entitlement: right, purchase } = await s.grant();
    const created = await createCard(s.profile.id, s.cookie, s.category.id).expect(201);
    const submitted = await submit(s.profile.id, created.body.id, s.cookie).expect(200);
    await approve(submitted.body.draftVersion.id, s.adminCookie).expect(200);
    const consumed = await entitlement(right.id);
    const placement = await ctx.prisma.showcasePlacement.findFirstOrThrow({ where: { cardId: created.body.id } });

    await reportRefund(purchase.id);

    expect(await entitlement(right.id)).toEqual(consumed);
    expect(await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placement.id } })).toEqual(placement);
    expect(placement.status).toBe('ACTIVE');
  });
});

describe('a refund reported between the read and the write', () => {
  it('blocks the reservation: the guard waits for the flag and sees it', async () => {
    const s = await scenario();
    const { entitlement: right, purchase } = await s.grant();
    const card = await createApprovedShowcaseCard(ctx.prisma, { providerId: s.profile.id, categoryId: s.category.id });
    const service = ctx.app.get(ShowcaseEntitlementService);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let flagged!: () => void;
    const flagWritten = new Promise<void>((resolve) => {
      flagged = resolve;
    });

    // The webhook's transaction: the flag is written and held uncommitted.
    const webhook = ctx.prisma.$transaction(
      async (tx) => {
        await tx.packagePurchase.update({
          where: { id: purchase.id },
          data: { manualReviewReason: 'PAYMENT_REVERSAL_REPORTED', manualReviewAt: new Date() },
        });
        flagged();
        await gate;
      },
      { timeout: 20_000 },
    );
    await flagWritten;

    // The reservation read its candidate before the flag committed (the flag
    // is not visible yet), then reaches the guard and must wait on the lock.
    let settled = false;
    const reservation = ctx.prisma
      .$transaction(
        (tx) =>
          service.reserveForCard(tx, {
            providerId: s.profile.id,
            cardId: card.card.id,
            kind: 'SERVICE',
            entitlementId: right.id,
            now: new Date(),
          }),
        { timeout: 20_000 },
      )
      .finally(() => {
        settled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    release();
    await webhook;

    await expect(reservation).rejects.toMatchObject({ response: { code: CODE } });
    expect(await entitlement(right.id)).toMatchObject({ status: 'AVAILABLE', cardId: null });
  });
});
