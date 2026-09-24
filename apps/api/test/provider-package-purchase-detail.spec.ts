import { OfferPackageType, PackagePurchaseStatus, ProviderStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOfferPackage, createProviderProfile, createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';

/**
 * BUG-OPS-002 — `GET /providers/:providerId/package-purchases/:purchaseId`,
 * as the web detail screen relies on it.
 *
 * The owner reads their purchase. Another provider asking for it through
 * their own panel, and anyone asking for an id that was never issued, get the
 * same 404 — status and body identical, nothing naming the purchase, its
 * owner or which of the two it was. Another provider's panel stays a 403 from
 * ProviderAccessGuard; the web maps that onto the same not-found page. None of
 * this widens what the route returns.
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

const UNKNOWN_ID = 'c000000000000000000000000';

async function providerWithSession() {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, { userId: user.id, status: ProviderStatus.APPROVED });
  return { provider, cookie: await loginAs(ctx.prisma, user.id) };
}

async function paidPurchase(providerId: string) {
  const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.ONE_TIME_CREDITS, creditAmount: 25 });
  return ctx.prisma.packagePurchase.create({
    data: {
      providerId,
      packageId: pkg.id,
      status: PackagePurchaseStatus.PAID,
      creditAmountSnapshot: 25,
      priceAmountSnapshot: pkg.priceAmount,
      packageNameSnapshot: pkg.name,
      paidAt: new Date(),
    },
  });
}

describe('provider package purchase detail', () => {
  it('own purchase 200; a foreign and an unknown purchase are the same 404, with nothing to tell them apart', async () => {
    const owner = await providerWithSession();
    const outsider = await providerWithSession();
    const purchase = await paidPurchase(owner.provider.id);

    const own = await request(ctx.server)
      .get(`/providers/${owner.provider.id}/package-purchases/${purchase.id}`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(own.body).toMatchObject({ id: purchase.id, providerId: owner.provider.id, status: 'PAID', packageNameSnapshot: purchase.packageNameSnapshot });

    const foreign = await request(ctx.server)
      .get(`/providers/${outsider.provider.id}/package-purchases/${purchase.id}`)
      .set('Cookie', outsider.cookie);
    const unknown = await request(ctx.server)
      .get(`/providers/${outsider.provider.id}/package-purchases/${UNKNOWN_ID}`)
      .set('Cookie', outsider.cookie);

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.body).toEqual(unknown.body);
    expect(foreign.headers['content-type']).toBe(unknown.headers['content-type']);
    const leaked = JSON.stringify(foreign.body);
    for (const secret of [purchase.id, owner.provider.id, owner.provider.businessName, purchase.packageNameSnapshot]) {
      expect(leaked).not.toContain(secret);
    }
  });

  it('another provider’s panel stays a 403 from the access guard, whether the purchase exists or not', async () => {
    const owner = await providerWithSession();
    const outsider = await providerWithSession();
    const purchase = await paidPurchase(owner.provider.id);

    const existing = await request(ctx.server)
      .get(`/providers/${owner.provider.id}/package-purchases/${purchase.id}`)
      .set('Cookie', outsider.cookie)
      .expect(403);
    const missing = await request(ctx.server)
      .get(`/providers/${owner.provider.id}/package-purchases/${UNKNOWN_ID}`)
      .set('Cookie', outsider.cookie)
      .expect(403);
    expect(existing.body).toEqual(missing.body);
    expect(JSON.stringify(existing.body)).not.toContain(purchase.packageNameSnapshot);
  });
});
