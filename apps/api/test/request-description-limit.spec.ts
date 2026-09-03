import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createTestApp,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';
import { SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH } from '../src/common/service-request-limits';

/**
 * The description length rule, over HTTP with the production ValidationPipe in
 * place — because the claim is about what a client may post, not about what a
 * DTO class says when inspected.
 *
 * The public form stops the customer at the same number, but that stop is a
 * courtesy: anything can post to this endpoint, so the limit has to hold here
 * on its own.
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

describe('service request description limit', () => {
  it('is the number the shared limits file carries', () => {
    // The counter on the public form reads the very same file. If this drifts,
    // the form would promise room the API refuses.
    expect(SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH).toBe(5000);
  });

  it('accepts a description of exactly the limit', async () => {
    const category = await createCategory(ctx.prisma, 'Sınır kabul', { offerCreditCost: 1 });
    const description = 'a'.repeat(SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH);

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { description }))
      .expect(201);

    // Stored whole: the limit is a bound, not a truncation.
    const stored = await ctx.prisma.serviceRequest.findUnique({
      where: { id: response.body.id },
      select: { description: true },
    });
    expect(stored?.description).toHaveLength(SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH);
  });

  it('refuses one character over the limit', async () => {
    const category = await createCategory(ctx.prisma, 'Sınır aşımı', { offerCreditCost: 1 });
    const description = 'a'.repeat(SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH + 1);

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { description }))
      .expect(400);

    expect(JSON.stringify(response.body)).toContain('description');

    // Refused outright, not saved and trimmed down.
    await expect(ctx.prisma.serviceRequest.count()).resolves.toBe(0);
  });

  it('counts UTF-16 code units, the same unit the browser counts', async () => {
    const category = await createCategory(ctx.prisma, 'Emoji sınırı', { offerCreditCost: 1 });

    // An emoji outside the BMP is two code units, so 2500 of them are exactly
    // the limit — and one more emoji is two over it.
    const atLimit = '😀'.repeat(SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH / 2);
    expect(atLimit.length).toBe(SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH);

    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { description: atLimit }))
      .expect(201);

    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { description: `${atLimit}😀` }))
      .expect(400);
  });

  it("leaves the quality score's 20-character floor alone", async () => {
    const category = await createCategory(ctx.prisma, 'Kalite tabanı', { offerCreditCost: 1 });

    const short = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { description: 'Kısa.' }))
      .expect(201);

    const detailed = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { description: 'a'.repeat(20) }))
      .expect(201);

    expect(short.body.qualityScoreBreakdown.descriptionDetailed.passed).toBe(false);
    expect(detailed.body.qualityScoreBreakdown.descriptionDetailed.passed).toBe(true);
  });
});
