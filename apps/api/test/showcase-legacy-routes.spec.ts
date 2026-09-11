import { ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

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

/**
 * The card-bound sale is gone. These routes had exactly one consumer — the web
 * application — and it no longer calls them; the only sale is
 * `POST /showcase/packages/checkout`. A 404 here is the contract.
 */
describe('the removed card-bound routes', () => {
  it('answer 404 for the owner', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const profile = await createDiscoverableProvider(ctx.prisma, {
      userId: user.id,
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: null }],
    });
    const { card } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: profile.id,
      categoryId: category.id,
    });
    const cookie = await loginAs(ctx.prisma, user.id);
    const base = `/providers/${profile.id}/showcase`;

    expect(
      (
        await request(ctx.server)
          .post(`${base}/placements/checkout`)
          .set('Cookie', cookie)
          .send({ cardId: card.id, showcasePackageId: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(ctx.server)
          .get(`${base}/placements/eligibility?cardId=${card.id}`)
          .set('Cookie', cookie)
      ).status,
    ).toBe(404);
    expect(
      (await request(ctx.server).get(`${base}/cards/${card.id}/price-terms`).set('Cookie', cookie))
        .status,
    ).toBe(404);
    expect(
      (
        await request(ctx.server)
          .post(`${base}/cards/${card.id}/price-terms-acceptances`)
          .set('Cookie', cookie)
          .send({ priceTermsAccepted: true, priceTermsVersion: 'v1' })
      ).status,
    ).toBe(404);
  });
});
