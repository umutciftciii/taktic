import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PromoCreditLotExpiryService } from '../src/modules/credits/promo-credit-lot-expiry.service';
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
 * CMP-004 S4 — the admin credit ledger names the campaign behind a promo row.
 *
 * A CAMPAIGN_GRANT, CAMPAIGN_EXPIRE or CAMPAIGN_REVOKE row references a
 * redemption, a lot or a consumption share; the operator reading the ledger
 * should see which campaign (and which rule version) that is, by exact
 * reference — and nothing else about it: not the operator's revoke note, not
 * the rules, not the provider beyond what every row already carries.
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

type LedgerItem = {
  id: string;
  type: string;
  referenceType: string | null;
  referenceId: string | null;
  campaign: { id: string; name: string; versionNumber: number } | null;
};

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { admin, cookie: await loginAs(ctx.prisma, admin.id) };
}

async function ledger(cookie: string, query = '') {
  const response = await request(ctx.server).get(`/finance/credit-ledger${query}`).set('Cookie', cookie).expect(200);
  return response.body as { items: LedgerItem[]; total: number };
}

describe('GET /finance/credit-ledger with campaign rows', () => {
  it('names the campaign and version on the three campaign movements and nothing on the others', async () => {
    const { admin, cookie } = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 3 });
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
    await grantCredits(ctx.prisma, provider.id, 2);

    // A lot, an offer paid from it, the lot dies, the offer is refunded: one
    // GRANT (ref redemption), one EXPIRE for the remainder (ref lot), one
    // EXPIRE forfeit (ref consumption).
    const granted = await createPromoLotFixture(ctx.prisma, provider.id, { credits: 4, expiresAt: new Date(Date.now() + 5_000), createdById: admin.id });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const offer = await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', await loginAs(ctx.prisma, owner.id))
      .send(offerPayload())
      .expect(201);
    await ctx.prisma.promoCreditLot.update({ where: { id: granted.lot.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await ctx.app.get(PromoCreditLotExpiryService).expireDueLots(new Date());
    await request(ctx.server)
      .post(`/offers/${offer.body.id as string}/refund-credit`)
      .set('Cookie', cookie)
      .send({ reasonCode: 'INVALID_REQUEST' })
      .expect(201);

    const { items } = await ledger(cookie);
    const campaignRow = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: granted.campaign.id } });
    const expectedCampaign = { id: campaignRow.id, name: campaignRow.name, versionNumber: 1 };
    const byType = (type: string) => items.filter((item) => item.type === type);

    expect(byType('CAMPAIGN_GRANT')).toHaveLength(1);
    expect(byType('CAMPAIGN_GRANT')[0]).toMatchObject({ referenceType: 'CampaignRedemption', campaign: expectedCampaign });
    const expires = byType('CAMPAIGN_EXPIRE');
    expect(expires.map((row) => row.referenceType).sort()).toEqual(['PromoCreditLot', 'PromoCreditLotConsumption']);
    for (const row of expires) {
      expect(row.campaign).toEqual(expectedCampaign);
    }
    for (const row of items.filter((item) => !item.type.startsWith('CAMPAIGN_'))) {
      expect(row.campaign).toBeNull();
    }
    expect(items.map((item) => item.type).sort()).toEqual(
      ['ADMIN_GRANT', 'CAMPAIGN_EXPIRE', 'CAMPAIGN_EXPIRE', 'CAMPAIGN_GRANT', 'OFFER_REFUND', 'OFFER_SPEND'].sort(),
    );
  });

  it('names the campaign on a revoke row and carries no revoke note, rules or event payload', async () => {
    const { admin, cookie } = await adminCookie();
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
    const granted = await createPromoLotFixture(ctx.prisma, provider.id, { credits: 10, createdById: admin.id });

    await request(ctx.server)
      .post(`/admin/campaigns/${granted.campaign.id}/redemptions/${granted.redemption.id}/revoke`)
      .set('Cookie', cookie)
      .send({ reason: 'GIZLI-NOT sahte hesap şüphesi' })
      .expect(201);

    const { items } = await ledger(cookie, '?type=CAMPAIGN_REVOKE');
    const campaignRow = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: granted.campaign.id } });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'CAMPAIGN_REVOKE',
      referenceType: 'PromoCreditLot',
      referenceId: granted.lot.id,
      campaign: { id: campaignRow.id, name: campaignRow.name, versionNumber: 1 },
    });
    const body = JSON.stringify(items);
    expect(body).not.toContain('GIZLI-NOT');
    expect(body).not.toContain('rulesSnapshot');
    expect(body).not.toContain('definition');
    expect(body).not.toContain('revokeNote');
  });

  it('keeps the original filters: an unknown type is refused and the six original types still page', async () => {
    const { cookie } = await adminCookie();
    await request(ctx.server).get('/finance/credit-ledger?type=CAMPAIGN_BONUS').set('Cookie', cookie).expect(400);
    const page = await ledger(cookie, '?type=OFFER_SPEND,OFFER_REFUND&page=1&pageSize=10');
    expect(page).toMatchObject({ items: [], total: 0 });
  });

  it('is a SUPER_ADMIN screen', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await request(ctx.server).get('/finance/credit-ledger').expect(401);
    await request(ctx.server).get('/finance/credit-ledger').set('Cookie', await loginAs(ctx.prisma, owner.id)).expect(403);
  });
});
