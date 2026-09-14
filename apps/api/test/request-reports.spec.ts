import { ProviderStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest, createCategory, createDiscoverableProvider, createProviderProfile,
  createTestApp, createUser, loginAs, resetDatabase, type TestContext,
} from './harness';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.app.close(); });
beforeEach(async () => { await resetDatabase(ctx.prisma); });

async function approvedProvider(categoryId: string) {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { categoryId, userId: user.id });
  return { provider, cookie: await loginAs(ctx.prisma, user.id) };
}
const reportUrl = (p: string, r: string) => `/providers/${p}/requests/${r}/reports`;

describe('provider request reports', () => {
  it('creates once, then 409; the detail shows only my own report', async () => {
    const category = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const { provider, cookie } = await approvedProvider(category.id);

    await request(ctx.server).post(reportUrl(provider.id, req.id)).set('Cookie', cookie)
      .send({ reason: 'SPAM', note: 'Aynı metin üç kez açıldı' }).expect(201);
    const dup = await request(ctx.server).post(reportUrl(provider.id, req.id)).set('Cookie', cookie)
      .send({ reason: 'OTHER' }).expect(409);
    expect(dup.body.code).toBe('REPORT_ALREADY_EXISTS');

    const detail = await request(ctx.server).get(`/providers/${provider.id}/requests/${req.id}`).set('Cookie', cookie).expect(200);
    expect(detail.body.myReport).toMatchObject({ reason: 'SPAM' });
    expect(detail.body).not.toHaveProperty('reports');
    expect(detail.body).not.toHaveProperty('reportCount');

    const other = await approvedProvider(category.id);
    const otherDetail = await request(ctx.server).get(`/providers/${other.provider.id}/requests/${req.id}`).set('Cookie', other.cookie).expect(200);
    expect(otherDetail.body.myReport).toBeNull();
  });

  it('does not hide the request: it stays listed and offerable after a report', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 });
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const { provider, cookie } = await approvedProvider(category.id);
    await request(ctx.server).post(reportUrl(provider.id, req.id)).set('Cookie', cookie).send({ reason: 'SPAM' }).expect(201);
    const list = await request(ctx.server).get(`/providers/${provider.id}/requests`).set('Cookie', cookie).expect(200);
    expect(list.body.map((r: { id: string }) => r.id)).toContain(req.id);
  });

  it('refuses a request the provider cannot see with 404, and a non-approved provider with 403', async () => {
    const category = await createCategory(ctx.prisma);
    const elsewhere = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, { categoryId: elsewhere.id });
    const { provider, cookie } = await approvedProvider(category.id);
    await request(ctx.server).post(reportUrl(provider.id, req.id)).set('Cookie', cookie).send({ reason: 'SPAM' }).expect(404);

    const pendingUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const pending = await createProviderProfile(ctx.prisma, { userId: pendingUser.id, status: ProviderStatus.PENDING_REVIEW });
    const pendingCookie = await loginAs(ctx.prisma, pendingUser.id);
    await request(ctx.server).post(reportUrl(pending.id, req.id)).set('Cookie', pendingCookie).send({ reason: 'SPAM' }).expect(403);
  });

  it('caps a provider at 20 reports per day', async () => {
    const category = await createCategory(ctx.prisma);
    const { provider, cookie } = await approvedProvider(category.id);
    for (let i = 0; i < 20; i += 1) {
      const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
      await request(ctx.server).post(reportUrl(provider.id, req.id)).set('Cookie', cookie).send({ reason: 'SPAM' }).expect(201);
    }
    const extra = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const res = await request(ctx.server).post(reportUrl(provider.id, extra.id)).set('Cookie', cookie).send({ reason: 'SPAM' }).expect(429);
    expect(res.body.code).toBe('REPORT_RATE_LIMITED');
  });

  it('rejects a note over 500 code units', async () => {
    const category = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const { provider, cookie } = await approvedProvider(category.id);
    await request(ctx.server).post(reportUrl(provider.id, req.id)).set('Cookie', cookie)
      .send({ reason: 'OTHER', note: 'x'.repeat(501) }).expect(400);
  });
});
