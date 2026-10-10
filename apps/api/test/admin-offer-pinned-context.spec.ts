import { AdminPermission, PrismaClient, ProviderStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OffersService } from '../src/modules/offers/offers.service';
import { SEARCH_PROJECTION_OMIT, type PrismaService } from '../src/prisma/prisma.service';
import {
  createAdminWithPermissions,
  createApprovedRequest,
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  type TestContext,
} from './harness';
import { resolveTestDatabaseUrl } from './test-database';

/**
 * ADMIN-PINNED-LABEL-001: `GET /offers` names the pinned provider and request
 * in `context`, whatever the page holds.
 *
 * The screen used to take the names from a row of the page, so a pinned list
 * whose page was empty — a refund filter that matched nothing, a page past the
 * last — showed the raw id. What is asserted: the names come back on a full
 * page, an empty filter and a page out of range alike; an unknown id, or one
 * with no offer behind it, answers null; the context carries the identity
 * fields only, for every reader; and it is one bounded read per pin.
 */

let ctx: TestContext;
let logged: PrismaClient<{ omit: typeof SEARCH_PROJECTION_OMIT; log: [{ emit: 'event'; level: 'query' }] }>;
let statements: Array<{ query: string; params: string }> = [];

beforeAll(async () => {
  ctx = await createTestApp();
  logged = new PrismaClient({
    datasources: { db: { url: resolveTestDatabaseUrl() } },
    omit: SEARCH_PROJECTION_OMIT,
    log: [{ emit: 'event', level: 'query' }],
  });
  logged.$on('query', (event) => statements.push({ query: event.query, params: event.params }));
});

afterAll(async () => {
  await logged.$disconnect();
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetAuthThrottle(ctx.app);
  statements = [];
});

async function superAdmin() {
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, user.id);
}

async function sessionWith(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return loginAs(ctx.prisma, admin.id);
}

async function get(path: string, cookie: string) {
  const response = await request(ctx.server).get(path).set('Cookie', cookie);
  expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
}

/** A provider with hidden contact fields and three plain offers, none of them a refund candidate. */
async function pinnedWorld() {
  const category = await createCategory(ctx.prisma);
  const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
  await ctx.prisma.providerProfile.update({
    where: { id: provider.id },
    data: { businessName: 'Pinli Usta Tesisat', contactName: 'Gizli Yetkili', phone: '+905321112233', email: 'gizli.hv@example.test' },
  });
  const offers = [];
  for (let i = 0; i < 3; i += 1) {
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, city: 'İzmir', district: 'Bornova' });
    await ctx.prisma.serviceRequest.update({
      where: { id: req.id },
      data: { customerName: 'Saklı Müşteri', customerPhone: '+905557778899', customerEmail: 'sakli@example.test' },
    });
    offers.push(
      await ctx.prisma.offer.create({
        data: { requestId: req.id, providerId: provider.id, priceAmount: 1000, message: 'x', creditCost: 0 },
      }),
    );
  }
  const pinnedRequest = await ctx.prisma.serviceRequest.findUniqueOrThrow({
    where: { id: offers[0]!.requestId },
    select: { id: true, requestNumber: true },
  });
  return { category, provider, offers, pinnedRequest };
}

const HIDDEN = ['Gizli Yetkili', '+905321112233', 'gizli.hv@example.test', 'Saklı Müşteri', '+905557778899', 'sakli@example.test'];

describe('GET /offers — the pinned provider is named whatever the page holds', () => {
  it('on a full page, an empty refund filter and a page past the last', async () => {
    const { provider } = await pinnedWorld();
    const cookie = await superAdmin();
    const expected = { id: provider.id, businessName: 'Pinli Usta Tesisat' };

    const full = await get(`/offers?providerId=${provider.id}`, cookie);
    expect(full.items).toHaveLength(3);
    expect(full.context).toEqual({ provider: expected, request: null });

    const emptyRefund = await get(`/offers?providerId=${provider.id}&refundAction=FULL_REFUND`, cookie);
    expect(emptyRefund).toMatchObject({ items: [], total: 0 });
    expect(emptyRefund.context.provider).toEqual(expected);

    const outOfRange = await get(`/offers?providerId=${provider.id}&page=9&pageSize=2`, cookie);
    expect(outOfRange).toMatchObject({ items: [], total: 3, hasNextPage: false });
    expect(outOfRange.context.provider).toEqual(expected);

    // Pagination and filter semantics are untouched by the context.
    expect(full.summary).toEqual(emptyRefund.summary);
    expect(full.summary).toEqual(outOfRange.summary);
  });
});

describe('GET /offers — the pinned request, symmetrically', () => {
  it('on a full page, an empty refund filter and a page past the last', async () => {
    const { category, pinnedRequest } = await pinnedWorld();
    const cookie = await superAdmin();
    const expected = {
      id: pinnedRequest.id,
      requestNumber: pinnedRequest.requestNumber,
      city: 'İzmir',
      district: 'Bornova',
      category: { name: category.name },
    };

    for (const path of [
      `/offers?requestId=${pinnedRequest.id}`,
      `/offers?requestId=${pinnedRequest.id}&refundAction=FULL_REFUND`,
      `/offers?requestId=${pinnedRequest.id}&page=4`,
    ]) {
      const body = await get(path, cookie);
      expect(body.context, path).toEqual({ provider: null, request: expected });
    }
    expect((await get(`/offers?requestId=${pinnedRequest.id}&page=4`, cookie)).items).toEqual([]);
  });
});

describe('GET /offers — a pin with nothing behind it', () => {
  it('answers null for an unknown id, for a provider or request without offers, and with no pin', async () => {
    await pinnedWorld();
    const lonelyCategory = await createCategory(ctx.prisma);
    const lonelyProvider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    const lonelyRequest = await createApprovedRequest(ctx.prisma, { categoryId: lonelyCategory.id });
    const cookie = await superAdmin();

    for (const path of [
      '/offers?providerId=cm-no-such-provider&requestId=cm-no-such-request',
      `/offers?providerId=${lonelyProvider.id}&requestId=${lonelyRequest.id}`,
      '/offers',
    ]) {
      expect((await get(path, cookie)).context, path).toEqual({ provider: null, request: null });
    }
  });
});

describe('GET /offers — the context carries identity only, for every reader', () => {
  it('the same minimal key set with OFFERS_READ alone and with every contact permission', async () => {
    const { provider, pinnedRequest } = await pinnedWorld();
    const path = `/offers?providerId=${provider.id}&requestId=${pinnedRequest.id}&refundAction=FULL_REFUND`;
    const readers = [
      await sessionWith([AdminPermission.OFFERS_READ]),
      await sessionWith([
        AdminPermission.OFFERS_READ,
        AdminPermission.PROVIDERS_READ,
        AdminPermission.REQUESTS_READ,
        AdminPermission.CUSTOMERS_READ,
      ]),
      await superAdmin(),
    ];
    for (const cookie of readers) {
      const body = await get(path, cookie);
      expect(Object.keys(body).sort()).toEqual(
        ['context', 'hasNextPage', 'items', 'page', 'pageSize', 'summary', 'total', 'totalPages'],
      );
      expect(Object.keys(body.context).sort()).toEqual(['provider', 'request']);
      expect(Object.keys(body.context.provider).sort()).toEqual(['businessName', 'id']);
      expect(Object.keys(body.context.request).sort()).toEqual(['category', 'city', 'district', 'id', 'requestNumber']);
      expect(Object.keys(body.context.request.category)).toEqual(['name']);
      const serialized = JSON.stringify(body.context);
      for (const hidden of HIDDEN) expect(serialized, hidden).not.toContain(hidden);
    }
  });
});

describe('GET /offers — the context is one bounded read per pin', () => {
  it('reads one offer for each pin, never the list', async () => {
    const { provider, pinnedRequest } = await pinnedWorld();
    const service = new OffersService(logged as unknown as PrismaService, null as never, null as never);
    const viewer = { id: 'viewer', role: UserRole.SUPER_ADMIN, permissions: [] } as never;
    statements = [];
    const res = await service.listOffers(
      { providerId: provider.id, requestId: pinnedRequest.id, refundAction: 'FULL_REFUND', page: 1, pageSize: 5 },
      viewer,
    );
    expect(res.items).toEqual([]);
    expect(res.context.provider?.businessName).toBe('Pinli Usta Tesisat');

    const offerReads = statements.filter(
      (s) => /FROM "(public"\.")?Offer"/.test(s.query) && /^\s*SELECT/i.test(s.query) && !/^\s*SELECT COUNT\(/i.test(s.query),
    );
    // The page, then one LIMIT 1 per pin.
    expect(offerReads).toHaveLength(3);
    for (const statement of offerReads) expect(statement.query).toMatch(/LIMIT \$\d+/);
    for (const statement of offerReads.slice(1)) expect(JSON.parse(statement.params)).toContain(1);
  });
});
