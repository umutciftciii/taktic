import { CreditTransactionType, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  currentCreditBalance,
  grantCredits,
  loginAs,
  offerPayload,
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

function offerUrl(providerId: string, requestId: string) {
  return `/providers/${providerId}/requests/${requestId}/offers`;
}

/**
 * A provider approved for `categories`, with a matching service area, plus one
 * approved request per category.
 */
async function multiCategoryFixture(
  categorySpecs: Array<{ cost: number | null; isActive?: boolean }>,
  credits = 0,
) {
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const categories = [];
  for (const spec of categorySpecs) {
    categories.push(
      await createCategory(ctx.prisma, 'Kategori', {
        offerCreditCost: spec.cost,
        isActive: spec.isActive ?? true,
      }),
    );
  }

  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId: categories[0]!.id,
  });

  // The provider must cover every category under test.
  for (const category of categories.slice(1)) {
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: category.id },
    });
  }

  const requests = [];
  for (const category of categories) {
    requests.push(await createApprovedRequest(ctx.prisma, { categoryId: category.id }));
  }

  if (credits) {
    await grantCredits(ctx.prisma, provider.id, credits);
  }

  const cookie = await loginAs(ctx.prisma, ownerUser.id);
  return { ownerUser, provider, categories, requests, cookie };
}

describe('two categories with different costs', () => {
  it('snapshots each category’s own cost onto the offer and the ledger', async () => {
    const CHEAP = 2;
    const PRICEY = 5;
    const CREDITS = 20;
    const { provider, requests, cookie } = await multiCategoryFixture(
      [{ cost: CHEAP }, { cost: PRICEY }],
      CREDITS,
    );

    const cheapOffer = await request(ctx.server)
      .post(offerUrl(provider.id, requests[0]!.id))
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);

    const priceyOffer = await request(ctx.server)
      .post(offerUrl(provider.id, requests[1]!.id))
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);

    expect(cheapOffer.body.creditCost).toBe(CHEAP);
    expect(priceyOffer.body.creditCost).toBe(PRICEY);

    const spends = await ctx.prisma.providerCreditTransaction.findMany({
      where: { providerId: provider.id, type: CreditTransactionType.OFFER_SPEND },
      orderBy: { createdAt: 'asc' },
    });
    expect(spends.map((spend) => spend.amount).sort((a, b) => a - b)).toEqual(
      [-PRICEY, -CHEAP].sort((a, b) => a - b),
    );

    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(CREDITS - CHEAP - PRICEY);
  });
});

describe('balance is judged against the category cost', () => {
  it('rejects a 5-credit category on a 3-credit balance but allows a 2-credit one', async () => {
    const { provider, requests, cookie } = await multiCategoryFixture(
      [{ cost: 5 }, { cost: 2 }],
      3,
    );

    await request(ctx.server)
      .post(offerUrl(provider.id, requests[0]!.id))
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(402);

    expect(await ctx.prisma.offer.count({ where: { providerId: provider.id } })).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(3);

    await request(ctx.server)
      .post(offerUrl(provider.id, requests[1]!.id))
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);

    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(1);
  });
});

describe('unpriced category', () => {
  it('answers 409 CATEGORY_PRICE_UNSET and changes nothing', async () => {
    const { provider, requests, cookie } = await multiCategoryFixture([{ cost: null }], 10);

    const response = await request(ctx.server)
      .post(offerUrl(provider.id, requests[0]!.id))
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(409);

    expect(response.body.code).toBe('CATEGORY_PRICE_UNSET');
    expect(await ctx.prisma.offer.count({ where: { providerId: provider.id } })).toBe(0);
    expect(
      await ctx.prisma.providerCreditTransaction.count({
        where: { providerId: provider.id, type: CreditTransactionType.OFFER_SPEND },
      }),
    ).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(10);
  });

  it('marks the request as un-offerable in the discovery list and detail', async () => {
    const { provider, requests, cookie } = await multiCategoryFixture([{ cost: null }], 10);

    const list = await request(ctx.server)
      .get(`/providers/${provider.id}/requests`)
      .set('Cookie', cookie)
      .expect(200);

    const listed = list.body.find((item: { id: string }) => item.id === requests[0]!.id);
    expect(listed.canOffer).toBe(false);
    expect(listed.offerCreditCost).toBeNull();
    expect(listed.offerBlockedReason).toBe('CATEGORY_PRICE_UNSET');

    const detail = await request(ctx.server)
      .get(`/providers/${provider.id}/requests/${requests[0]!.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.canOffer).toBe(false);
    expect(detail.body.offerBlockedReason).toBe('CATEGORY_PRICE_UNSET');
  });
});

describe('database CHECK constraint on offerCreditCost', () => {
  it('refuses zero', async () => {
    await expect(
      createCategory(ctx.prisma, 'Sifir', { offerCreditCost: 0 }),
    ).rejects.toThrowError();
  });

  it('refuses a negative cost', async () => {
    await expect(
      createCategory(ctx.prisma, 'Negatif', { offerCreditCost: -3 }),
    ).rejects.toThrowError();
  });

  it('refuses updating an existing category to zero', async () => {
    const category = await createCategory(ctx.prisma, 'Gecerli', { offerCreditCost: 3 });

    await expect(
      ctx.prisma.serviceCategory.update({
        where: { id: category.id },
        data: { offerCreditCost: 0 },
      }),
    ).rejects.toThrowError();

    const unchanged = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: category.id },
    });
    expect(unchanged.offerCreditCost).toBe(3);
  });

  it('allows null (price not set)', async () => {
    const category = await createCategory(ctx.prisma, 'Fiyatsiz', { offerCreditCost: null });
    expect(category.offerCreditCost).toBeNull();
  });
});

describe('refund after a category price change', () => {
  it('refunds the offer’s own snapshot, not the new category price', async () => {
    const ORIGINAL_COST = 3;
    const NEW_COST = 9;
    const CREDITS = 10;
    const { provider, categories, requests, cookie } = await multiCategoryFixture(
      [{ cost: ORIGINAL_COST }],
      CREDITS,
    );
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    const created = await request(ctx.server)
      .post(offerUrl(provider.id, requests[0]!.id))
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);
    const offerId = created.body.id as string;

    expect(created.body.creditCost).toBe(ORIGINAL_COST);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(CREDITS - ORIGINAL_COST);

    // The admin triples the price after the offer was submitted.
    await request(ctx.server)
      .patch(`/categories/${categories[0]!.id}`)
      .set('Cookie', adminCookie)
      .send({ offerCreditCost: NEW_COST })
      .expect(200);

    // Make the offer refund-eligible under the not-viewed policy.
    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: { submittedAt: new Date(Date.now() - 72 * 60 * 60 * 1000) },
    });

    const refund = await request(ctx.server)
      .post(`/offers/${offerId}/refund-credit`)
      .set('Cookie', adminCookie)
      .send({ reasonCode: 'NOT_VIEWED_48H' })
      .expect(201);

    // The refund uses the snapshot: balance returns exactly to where it started.
    expect(refund.body.balance).toBe(CREDITS);
    const refundRows = await ctx.prisma.providerCreditTransaction.findMany({
      where: { providerId: provider.id, type: CreditTransactionType.OFFER_REFUND },
    });
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]?.amount).toBe(ORIGINAL_COST);

    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.creditCost).toBe(ORIGINAL_COST);
  });
});

describe('concurrent offers under a category price', () => {
  it('lets exactly one through and never goes negative', async () => {
    const COST = 4;
    const { provider, categories, cookie } = await multiCategoryFixture([{ cost: COST }], COST);

    const first = await createApprovedRequest(ctx.prisma, { categoryId: categories[0]!.id });
    const second = await createApprovedRequest(ctx.prisma, { categoryId: categories[0]!.id });

    const results = await Promise.all([
      request(ctx.server)
        .post(offerUrl(provider.id, first.id))
        .set('Cookie', cookie)
        .send(offerPayload()),
      request(ctx.server)
        .post(offerUrl(provider.id, second.id))
        .set('Cookie', cookie)
        .send(offerPayload()),
    ]);

    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.find((result) => result.status !== 201)?.status).toBe(402);

    const balance = await currentCreditBalance(ctx.prisma, provider.id);
    expect(balance).toBe(0);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(await ctx.prisma.offer.count({ where: { providerId: provider.id } })).toBe(1);
  });
});

describe('who may change a category cost', () => {
  it('only SUPER_ADMIN can, and rejected calls leave the value untouched', async () => {
    const category = await createCategory(ctx.prisma, 'Yetki', { offerCreditCost: 3 });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });

    // Anonymous
    await request(ctx.server)
      .patch(`/categories/${category.id}`)
      .send({ offerCreditCost: 99 })
      .expect(401);

    // Customer
    await request(ctx.server)
      .patch(`/categories/${category.id}`)
      .set('Cookie', await loginAs(ctx.prisma, customer.id))
      .send({ offerCreditCost: 99 })
      .expect(403);

    // Provider
    await request(ctx.server)
      .patch(`/categories/${category.id}`)
      .set('Cookie', await loginAs(ctx.prisma, providerUser.id))
      .send({ offerCreditCost: 99 })
      .expect(403);

    const untouched = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: category.id },
    });
    expect(untouched.offerCreditCost).toBe(3);

    // Admin
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await request(ctx.server)
      .patch(`/categories/${category.id}`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .send({ offerCreditCost: 7 })
      .expect(200);

    const updated = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: category.id },
    });
    expect(updated.offerCreditCost).toBe(7);
  });

  it('rejects zero, negative, fractional and non-numeric costs', async () => {
    const category = await createCategory(ctx.prisma, 'Dogrulama', { offerCreditCost: 3 });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    for (const invalid of [0, -1, 1.5, 'bes', null]) {
      await request(ctx.server)
        .patch(`/categories/${category.id}`)
        .set('Cookie', adminCookie)
        .send({ offerCreditCost: invalid })
        .expect(400);
    }

    const unchanged = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: category.id },
    });
    expect(unchanged.offerCreditCost).toBe(3);
  });

  it('requires offerCreditCost when creating a category', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    await request(ctx.server)
      .post('/categories')
      .set('Cookie', adminCookie)
      .send({ name: 'Fiyatsiz Kategori', slug: 'fiyatsiz-kategori' })
      .expect(400);

    expect(
      await ctx.prisma.serviceCategory.count({ where: { slug: 'fiyatsiz-kategori' } }),
    ).toBe(0);

    const created = await request(ctx.server)
      .post('/categories')
      .set('Cookie', adminCookie)
      .send({ name: 'Fiyatli Kategori', slug: 'fiyatli-kategori', offerCreditCost: 6 })
      .expect(201);

    expect(created.body.offerCreditCost).toBe(6);
  });
});

describe('inactive category', () => {
  it('blocks new offers on requests that were already open', async () => {
    const COST = 2;
    const { provider, categories, requests, cookie } = await multiCategoryFixture(
      [{ cost: COST }],
      10,
    );

    // The request was created while the category was live; the category is
    // deactivated afterwards.
    await ctx.prisma.serviceCategory.update({
      where: { id: categories[0]!.id },
      data: { isActive: false },
    });

    const response = await request(ctx.server)
      .post(offerUrl(provider.id, requests[0]!.id))
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(409);

    expect(response.body.code).toBe('CATEGORY_INACTIVE');
    expect(await ctx.prisma.offer.count({ where: { providerId: provider.id } })).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(10);

    const detail = await request(ctx.server)
      .get(`/providers/${provider.id}/requests/${requests[0]!.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.canOffer).toBe(false);
    expect(detail.body.offerBlockedReason).toBe('CATEGORY_INACTIVE');
  });
});

describe('price race — expectedCreditCost', () => {
  it('refuses the submit with 409 CREDIT_COST_CHANGED and bills nothing', async () => {
    const SHOWN_COST = 2;
    const NEW_COST = 4;
    const CREDITS = 10;
    const { provider, categories, requests, cookie } = await multiCategoryFixture(
      [{ cost: SHOWN_COST }],
      CREDITS,
    );
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    // The provider loaded the form while the cost was SHOWN_COST.
    const detail = await request(ctx.server)
      .get(`/providers/${provider.id}/requests/${requests[0]!.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.offerCreditCost).toBe(SHOWN_COST);

    // The admin raises the price before the form is submitted.
    await request(ctx.server)
      .patch(`/categories/${categories[0]!.id}`)
      .set('Cookie', adminCookie)
      .send({ offerCreditCost: NEW_COST })
      .expect(200);

    const response = await request(ctx.server)
      .post(offerUrl(provider.id, requests[0]!.id))
      .set('Cookie', cookie)
      .send(offerPayload({ expectedCreditCost: SHOWN_COST }))
      .expect(409);

    expect(response.body.code).toBe('CREDIT_COST_CHANGED');
    expect(response.body.expectedCreditCost).toBe(SHOWN_COST);
    expect(response.body.actualCreditCost).toBe(NEW_COST);

    expect(await ctx.prisma.offer.count({ where: { providerId: provider.id } })).toBe(0);
    expect(
      await ctx.prisma.providerCreditTransaction.count({
        where: { providerId: provider.id, type: CreditTransactionType.OFFER_SPEND },
      }),
    ).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(CREDITS);
  });

  it('accepts a matching expectedCreditCost and charges the live price', async () => {
    const COST = 3;
    const { provider, requests, cookie } = await multiCategoryFixture([{ cost: COST }], 10);

    const created = await request(ctx.server)
      .post(offerUrl(provider.id, requests[0]!.id))
      .set('Cookie', cookie)
      .send(offerPayload({ expectedCreditCost: COST }))
      .expect(201);

    expect(created.body.creditCost).toBe(COST);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(10 - COST);
  });

  it('never lets expectedCreditCost decide the amount charged', async () => {
    const REAL_COST = 4;
    const { provider, requests, cookie } = await multiCategoryFixture([{ cost: REAL_COST }], 10);

    // A tampered payload claiming the cost is 1 must be rejected, not honoured.
    const response = await request(ctx.server)
      .post(offerUrl(provider.id, requests[0]!.id))
      .set('Cookie', cookie)
      .send(offerPayload({ expectedCreditCost: 1 }))
      .expect(409);

    expect(response.body.code).toBe('CREDIT_COST_CHANGED');
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(10);

    // Without the field the live price applies — 4, never 1.
    const created = await request(ctx.server)
      .post(offerUrl(provider.id, requests[0]!.id))
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);

    expect(created.body.creditCost).toBe(REAL_COST);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(10 - REAL_COST);
  });
});
