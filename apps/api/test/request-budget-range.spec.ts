import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createTestApp,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';

/**
 * What a budget may be, over HTTP with the production ValidationPipe in place.
 *
 * The public form now writes these two fields in lira and converts them itself,
 * so the numbers arriving here are minor units — kuruş — exactly as they always
 * were. That conversion is a browser's, and this endpoint is public, so every
 * rule about the amounts has to hold on its own: the unit, the floor of one
 * whole lira, the refusal of anything negative, and the order of the two ends.
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

describe('service request budget range', () => {
  it('stores the minor units it is sent, unscaled', async () => {
    const category = await createCategory(ctx.prisma, 'Bütçe birimi', { offerCreditCost: 1 });

    // What the form posts for a customer who typed "5.000,00" and "7.500,50".
    const response = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { budgetMin: 500000, budgetMax: 750050 }))
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUnique({
      where: { id: response.body.id },
      select: { budgetMin: true, budgetMax: true },
    });
    expect(stored).toEqual({ budgetMin: 500000, budgetMax: 750050 });
  });

  it('accepts a range whose ends are equal', async () => {
    const category = await createCategory(ctx.prisma, 'Tek rakam', { offerCreditCost: 1 });

    // A customer with an exact figure gives the same number twice; that is a
    // range, and refusing it would refuse the most confident answer there is.
    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { budgetMin: 500000, budgetMax: 500000 }))
      .expect(201);
  });

  it('refuses a minimum above the maximum', async () => {
    const category = await createCategory(ctx.prisma, 'Ters aralık', { offerCreditCost: 1 });

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { budgetMin: 750000, budgetMax: 500000 }))
      .expect(400);

    expect(String(response.body.message)).toContain('Budget minimum');
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('accepts either end on its own, in either direction', async () => {
    const category = await createCategory(ctx.prisma, 'Tek uç', { offerCreditCost: 1 });

    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { budgetMin: 500000 }))
      .expect(201);

    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { budgetMax: 500000 }))
      .expect(201);
  });

  it('keeps an unstated budget null rather than zero', async () => {
    const category = await createCategory(ctx.prisma, 'Bütçesiz', { offerCreditCost: 1 });

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUnique({
      where: { id: response.body.id },
      select: { budgetMin: true, budgetMax: true },
    });
    expect(stored).toEqual({ budgetMin: null, budgetMax: null });
  });

  it('refuses zero, an amount under one lira, and a negative amount', async () => {
    const category = await createCategory(ctx.prisma, 'Alt sınır', { offerCreditCost: 1 });

    for (const budgetMin of [0, 99, -500000]) {
      await request(ctx.server)
        .post('/service-requests')
        .send(serviceRequestPayload(category.slug, { budgetMin }))
        .expect(400);
    }

    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });
});
