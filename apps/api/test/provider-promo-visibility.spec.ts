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
 * CMP-004 S4 — a provider sees their own spendable promotion credit.
 *
 * `GET /providers/:id/credits` gains `promo`: the credit that can still pay
 * for an offer (lots ACTIVE, with something left, not yet expired — the same
 * predicate the spend path uses), earliest expiry first, each lot with its
 * amount, its expiry and the campaign's name. Nothing about the campaign's
 * rules, nothing about anyone else's lots, and nothing to anyone but the
 * provider (and a super admin).
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

async function credits(providerId: string, cookie: string, expected = 200) {
  const response = await request(ctx.server).get(`/providers/${providerId}/credits`).set('Cookie', cookie).expect(expected);
  return response.body as { balance: number; promo: PromoView };
}

describe('GET /providers/:providerId/credits — promo', () => {
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

    const body = await credits(fixture.provider.id, fixture.cookie);
    const soonerCampaign = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: sooner.campaign.id } });
    const laterCampaign = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: later.campaign.id } });
    expect(body.promo).toEqual({
      spendableCredits: 13,
      lots: [
        { id: sooner.lot.id, remainingCredits: 3, expiresAt: sooner.lot.expiresAt.toISOString(), campaignName: soonerCampaign.name },
        { id: later.lot.id, remainingCredits: 10, expiresAt: later.lot.expiresAt.toISOString(), campaignName: laterCampaign.name },
      ],
    });
    // The wallet still counts the unswept remainder; the projection does not.
    expect(body.balance).toBe(5 + 10 + 3 + 2);
  });

  it('is empty, not absent, for a provider with no promotion', async () => {
    const fixture = await providerFixture();
    const body = await credits(fixture.provider.id, fixture.cookie);
    expect(body.promo).toEqual({ spendableCredits: 0, lots: [] });
  });

  it('carries nothing about the campaign but its name', async () => {
    const fixture = await providerFixture();
    await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 10 });
    const response = await request(ctx.server).get(`/providers/${fixture.provider.id}/credits`).set('Cookie', fixture.cookie).expect(200);
    const body = JSON.stringify(response.body);
    for (const forbidden of ['definition', 'rulesSnapshot', 'conditions', 'limits', 'maxRedemptions', 'redemptionId', 'campaignId', 'key']) {
      expect(body, forbidden).not.toContain(`"${forbidden}"`);
    }
  });

  it('refuses everyone but the provider and a super admin', async () => {
    const fixture = await providerFixture();
    await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 10 });
    const other = await providerFixture();
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    await request(ctx.server).get(`/providers/${fixture.provider.id}/credits`).expect(401);
    await credits(fixture.provider.id, await loginAs(ctx.prisma, customer.id), 403);
    await credits(fixture.provider.id, other.cookie, 403);
    // The other provider's own view shows only their own (empty) promotion.
    expect((await credits(other.provider.id, other.cookie)).promo).toEqual({ spendableCredits: 0, lots: [] });
    expect((await credits(fixture.provider.id, await loginAs(ctx.prisma, admin.id))).promo.spendableCredits).toBe(10);
  });
});
