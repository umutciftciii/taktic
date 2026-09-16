import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * `GET /service-requests/my/:id` — one request, read by its owner.
 *
 * The success screen renders the request's real state from this call rather
 * than from a URL flag, so the endpoint has to be safe to point an id at: a
 * request that is not this customer's answers exactly like one that does not
 * exist, and every other caller is stopped by the guards before any lookup.
 * The row is the same projection the customer's own list returns — the two
 * screens must never disagree about a status, a reference or a vitrin lead.
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

describe('GET /service-requests/my/:id', () => {
  it('returns the owner their request, shaped exactly like the list row', async () => {
    const category = await createCategory(ctx.prisma, 'Sahip', { offerCreditCost: 1 });
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const created = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: owner.id,
    });
    await ctx.prisma.serviceRequest.update({
      where: { id: created.id },
      data: {
        preferredDate: new Date('2026-09-15T00:00:00.000Z'),
        preferredDateEnd: new Date('2026-09-20T00:00:00.000Z'),
      },
    });
    const cookie = await loginAs(ctx.prisma, owner.id);

    const detail = await request(ctx.server)
      .get(`/service-requests/my/${created.id}`)
      .set('Cookie', cookie)
      .expect(200);
    const list = await request(ctx.server)
      .get('/service-requests/my')
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.id).toBe(created.id);
    expect(detail.body.status).toBe('APPROVED');
    expect(detail.body.requestNumber).toBe(created.requestNumber);
    expect(detail.body.preferredDate).toBe('2026-09-15T00:00:00.000Z');
    expect(detail.body.preferredDateEnd).toBe('2026-09-20T00:00:00.000Z');
    expect(detail.body.showcaseLead).toBeNull();
    expect(detail.body).toEqual(list.body[0]);
  });

  it('answers 404 for another customer\'s request, exactly like an unknown id', async () => {
    const category = await createCategory(ctx.prisma, 'Başkası', { offerCreditCost: 1 });
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const other = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const created = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: owner.id,
    });
    const cookie = await loginAs(ctx.prisma, other.id);

    const foreign = await request(ctx.server)
      .get(`/service-requests/my/${created.id}`)
      .set('Cookie', cookie)
      .expect(404);
    const unknown = await request(ctx.server)
      .get('/service-requests/my/clzzzzzzzzzzzzzzzzzzzzzzz')
      .set('Cookie', cookie)
      .expect(404);

    // The same body for both: nothing in the answer says which case it was.
    expect(foreign.body).toEqual(unknown.body);
  });

  it('is closed to providers, admins and anonymous callers', async () => {
    const category = await createCategory(ctx.prisma, 'Roller', { offerCreditCost: 1 });
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const created = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: owner.id,
    });
    const provider = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    await request(ctx.server)
      .get(`/service-requests/my/${created.id}`)
      .set('Cookie', await loginAs(ctx.prisma, provider.id))
      .expect(403);
    await request(ctx.server)
      .get(`/service-requests/my/${created.id}`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(403);
    await request(ctx.server).get(`/service-requests/my/${created.id}`).expect(401);
  });
});
