import { ProviderStatus } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProviderProfile, createTestApp, resetDatabase, type TestContext } from './harness';

/**
 * `GET /providers/public-directory` — what the web's sitemap lists businesses
 * from.
 *
 * It answers the one question a sitemap has — which profiles have a public
 * page — and nothing else: the ids of the approved profiles and when each row
 * last changed. Every other status is private moderation state, exactly as the
 * public profile endpoint treats it, and no business field travels here — a
 * name, a city, a contact detail — because the page itself is where those are
 * read from, under the public projection.
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

describe('GET /providers/public-directory', () => {
  it('lists approved profiles only, as id and updatedAt, in a stable order', async () => {
    const approvedA = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    const approvedB = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    for (const status of [
      ProviderStatus.DRAFT,
      ProviderStatus.PENDING_REVIEW,
      ProviderStatus.REJECTED,
      ProviderStatus.SUSPENDED,
    ]) {
      await createProviderProfile(ctx.prisma, { status });
    }

    const response = await request(ctx.app.getHttpServer()).get('/providers/public-directory').expect(200);

    const expected = [approvedA, approvedB]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((profile) => ({ id: profile.id, updatedAt: profile.updatedAt.toISOString() }));
    expect(response.body).toEqual({ providers: expected });
  });

  it('carries no business field at all', async () => {
    await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });

    const response = await request(ctx.app.getHttpServer()).get('/providers/public-directory').expect(200);

    expect(Object.keys(response.body.providers[0]).sort()).toEqual(['id', 'updatedAt']);
    expect(JSON.stringify(response.body)).not.toMatch(/İşletme|Yetkili|0555|example\.test|Kadıköy/);
  });

  it('is empty rather than an error when nothing is approved', async () => {
    await createProviderProfile(ctx.prisma, { status: ProviderStatus.PENDING_REVIEW });

    const response = await request(ctx.app.getHttpServer()).get('/providers/public-directory').expect(200);

    expect(response.body).toEqual({ providers: [] });
  });
});
