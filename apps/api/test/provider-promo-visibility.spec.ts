import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CampaignRevokeReason, Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PromoCreditLotExpiryService } from '../src/modules/credits/promo-credit-lot-expiry.service';
import { revokePromoCreditLot } from '../src/modules/credits/promo-credit-ledger';
import { createPromoLotFixture } from './campaign-fixtures';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * CMP-004 S4 — a provider sees their own spendable promotion credit, and
 * nobody can ask for anyone else's.
 *
 * `GET /providers/me/credits/promo` answers the signed-in PROVIDER about the
 * profile their session owns: the credit that can still pay for an offer
 * (lots ACTIVE, with something left, not yet expired — the same predicate
 * the spend path uses), earliest expiry first, each lot with its amount, its
 * expiry and the campaign's name. Nothing about the campaign's rules, and no
 * way to name another provider: the route takes no id at all, so there is no
 * 403/404 difference — and no timing difference — for a caller to probe
 * provider ids with. The id-taking credits route carries no promotion, and
 * `/providers/<id>/credits/promo` is not a route for any id.
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

const PATH = '/providers/me/credits/promo';
const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY);

type PromoView = {
  spendableCredits: number;
  lots: Array<{ id: string; remainingCredits: number; expiresAt: string; campaignName: string }>;
};

async function providerFixture() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 4 });
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
  const cookie = await loginAs(ctx.prisma, owner.id);
  return { category, owner, provider, cookie };
}

async function promo(cookie: string, expected = 200) {
  const response = await request(ctx.server).get(PATH).set('Cookie', cookie).expect(expected);
  return response.body as PromoView;
}

describe('GET /providers/me/credits/promo', () => {
  it('lists only the lots that can still pay, earliest expiry first, and sums them', async () => {
    const fixture = await providerFixture();
    await grantCredits(ctx.prisma, fixture.provider.id, 5);
    const later = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 10, expiresAt: inDays(30) });
    const sooner = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 3, expiresAt: inDays(5) });
    // Swept EXPIRED, REVOKED, and EXHAUSTED by an offer.
    const swept = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 2, expiresAt: inDays(1) });
    await ctx.prisma.promoCreditLot.update({ where: { id: swept.lot.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await ctx.app.get(PromoCreditLotExpiryService).expireDueLots(new Date());
    // Past its expiry but not yet swept (backdated after the sweep): in the wallet, not spendable.
    const unswept = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 2, expiresAt: inDays(1) });
    await ctx.prisma.promoCreditLot.update({ where: { id: unswept.lot.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const revoked = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 6, expiresAt: inDays(10) });
    await ctx.prisma.$transaction(
      (tx) => revokePromoCreditLot(tx, { lotId: revoked.lot.id, reason: CampaignRevokeReason.ADMIN_REVOKED, revokedById: null, now: new Date() }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    const exhausted = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 4, expiresAt: inDays(2) });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: fixture.category.id });
    await request(ctx.server)
      .post(`/providers/${fixture.provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', fixture.cookie)
      .send(offerPayload())
      .expect(201);
    expect((await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: exhausted.lot.id } })).status).toBe('EXHAUSTED');

    const body = await promo(fixture.cookie);
    const soonerCampaign = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: sooner.campaign.id } });
    const laterCampaign = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: later.campaign.id } });
    expect(body).toEqual({
      spendableCredits: 13,
      lots: [
        { id: sooner.lot.id, remainingCredits: 3, expiresAt: sooner.lot.expiresAt.toISOString(), campaignName: soonerCampaign.name },
        { id: later.lot.id, remainingCredits: 10, expiresAt: later.lot.expiresAt.toISOString(), campaignName: laterCampaign.name },
      ],
    });
    // The wallet still counts the unswept remainder; the projection does not.
    const credits = await request(ctx.server).get(`/providers/${fixture.provider.id}/credits`).set('Cookie', fixture.cookie).expect(200);
    expect(credits.body.balance).toBe(5 + 10 + 3 + 2);
  });

  it('is empty, not absent, for a provider with no promotion', async () => {
    const fixture = await providerFixture();
    expect(await promo(fixture.cookie)).toEqual({ spendableCredits: 0, lots: [] });
  });

  it('carries nothing about the campaign but its name, and no provider or lot identity beyond the lot id', async () => {
    const fixture = await providerFixture();
    await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 10 });
    const response = await request(ctx.server).get(PATH).set('Cookie', fixture.cookie).expect(200);
    const body = JSON.stringify(response.body);
    for (const forbidden of ['definition', 'rulesSnapshot', 'conditions', 'limits', 'maxRedemptions', 'redemptionId', 'campaignId', 'key', 'providerId', 'revokeNote']) {
      expect(body, forbidden).not.toContain(`"${forbidden}"`);
    }
    expect(body).not.toContain(fixture.provider.id);
  });

  it('answers only a PROVIDER session: anonymous 401, CUSTOMER and SUPER_ADMIN 403', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await request(ctx.server).get(PATH).expect(401);
    await promo(await loginAs(ctx.prisma, customer.id), 403);
    await promo(await loginAs(ctx.prisma, admin.id), 403);
  });

  it('derives the provider from the session alone: a second provider sees only their own lots whatever id they send', async () => {
    const first = await providerFixture();
    const second = await providerFixture();
    await createPromoLotFixture(ctx.prisma, first.provider.id, { credits: 10 });
    await createPromoLotFixture(ctx.prisma, second.provider.id, { credits: 2 });

    expect((await promo(first.cookie)).spendableCredits).toBe(10);
    expect((await promo(second.cookie)).spendableCredits).toBe(2);

    // Nothing on the request can select another provider: query, header or
    // body ids are not read, so the second provider still gets their own 2.
    const attempts = [
      () => request(ctx.server).get(`${PATH}?providerId=${first.provider.id}`),
      () => request(ctx.server).get(`${PATH}?id=${first.provider.id}`),
      () => request(ctx.server).get(PATH).set('x-provider-id', first.provider.id),
      () => request(ctx.server).get(PATH).send({ providerId: first.provider.id }),
    ];
    for (const attempt of attempts) {
      const response = await attempt().set('Cookie', second.cookie).expect(200);
      expect((response.body as PromoView).spendableCredits).toBe(2);
      expect(JSON.stringify(response.body)).not.toContain(first.provider.id);
    }
  });

  it('a session whose account owns no provider profile is refused, not answered with an empty list', async () => {
    const orphan = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await promo(await loginAs(ctx.prisma, orphan.id), 404);
  });
});

describe('the id-taking routes carry no promotion', () => {
  it('GET /providers/:id/credits has no promo key, for the owner and for a super admin', async () => {
    const fixture = await providerFixture();
    await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 10 });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    for (const cookie of [fixture.cookie, await loginAs(ctx.prisma, admin.id)]) {
      const response = await request(ctx.server).get(`/providers/${fixture.provider.id}/credits`).set('Cookie', cookie).expect(200);
      expect(response.body).not.toHaveProperty('promo');
      expect(JSON.stringify(response.body)).not.toMatch(/spendableCredits|campaignName/);
    }
  });

  it('GET /providers/:id/credits/promo is not a route: 404 for the owner, for a stranger and for an id that does not exist', async () => {
    const fixture = await providerFixture();
    await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 10 });
    const stranger = await providerFixture();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookies = [fixture.cookie, stranger.cookie, await loginAs(ctx.prisma, admin.id)];
    for (const id of [fixture.provider.id, stranger.provider.id, 'does-not-exist', 'me-not-quite']) {
      // Same answer for every caller and every id, signed in or not.
      await request(ctx.server).get(`/providers/${id}/credits/promo`).expect(404);
      for (const cookie of cookies) {
        const response = await request(ctx.server).get(`/providers/${id}/credits/promo`).set('Cookie', cookie).expect(404);
        expect(JSON.stringify(response.body)).not.toMatch(/spendableCredits|campaignName/);
      }
    }
  });
});

describe('the contract in the source', () => {
  it('the me route reads no route parameter: no @Param in its handler', () => {
    const source = readFileSync(resolve(__dirname, '../src/modules/credits/credits.controller.ts'), 'utf8');
    const start = source.indexOf("@Get('providers/me/credits/promo')");
    expect(start, 'the me route exists').toBeGreaterThan(-1);
    // The handler runs from its route decorator to the method's closing brace.
    const end = source.indexOf('\n  }', start);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    expect(handler).not.toContain('@Param');
    expect(handler).not.toContain('@Query');
    expect(handler).not.toContain('@Body');
    expect(handler).not.toContain('@Headers');
    expect(handler).toContain('@CurrentUser()');
    expect(handler).toContain('@Roles(UserRole.PROVIDER)');
  });
});
