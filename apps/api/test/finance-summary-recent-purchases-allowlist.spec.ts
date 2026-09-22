import { PackagePurchaseStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createDiscoverableProvider,
  createOfferPackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * Security: `GET /finance/summary` projects recent purchases through an
 * allowlist `select`, not a denylist `omit`.
 *
 * The response used to carry every PackagePurchase column, including the
 * payment correlation token that `packagePurchaseOmit` keeps out of every
 * other response. The fix names the eleven fields the admin finance screen
 * reads and nothing else, so a column added to the table later stays out of
 * this response until someone deliberately adds it to the select.
 */

const ADMIN_SCREEN_FIELDS = [
  'id',
  'purchaseNumber',
  'createdAt',
  'providerId',
  'provider',
  'packageNameSnapshot',
  'creditAmountSnapshot',
  'priceAmountSnapshot',
  'currencySnapshot',
  'status',
  'mockPaymentReference',
].sort();

const FORBIDDEN_FIELDS = ['paymentReference', 'providerCheckoutUrl', 'providerOrderId', 'adminNote'];

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

async function seedPurchaseWithSecrets() {
  const category = await createCategory(ctx.prisma, 'Klima');
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
  const offerPackage = await createOfferPackage(ctx.prisma);
  const secrets = {
    paymentReference: 'corr-token-must-not-leak-7f3a',
    providerCheckoutUrl: 'https://checkout.example.test/must-not-leak-91c2',
    providerOrderId: 'order-must-not-leak-5d0e',
    adminNote: 'internal-note-must-not-leak-b84f',
  };
  const purchase = await ctx.prisma.packagePurchase.create({
    data: {
      providerId: provider.id,
      packageId: offerPackage.id,
      status: PackagePurchaseStatus.PENDING,
      creditAmountSnapshot: offerPackage.creditAmount,
      priceAmountSnapshot: offerPackage.priceAmount,
      packageNameSnapshot: offerPackage.name,
      paymentProvider: 'mock',
      mockPaymentReference: 'MOCK-REF-1',
      ...secrets,
    },
  });
  return { provider, offerPackage, purchase, secrets };
}

async function summary() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  const response = await request(ctx.server)
    .get('/finance/summary')
    .set('Cookie', await loginAs(ctx.prisma, admin.id))
    .expect(200);
  return response.body as { recentPurchases: Array<Record<string, unknown>> };
}

describe('GET /finance/summary recentPurchases — allowlist projection (security fix, not a denylist)', () => {
  it('does not carry the payment correlation token (paymentReference leak regression)', async () => {
    const { purchase, secrets } = await seedPurchaseWithSecrets();

    const body = await summary();

    const row = body.recentPurchases.find((item) => item.id === purchase.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('paymentReference');
    expect(JSON.stringify(body)).not.toContain(secrets.paymentReference);
  });

  it('never names or carries paymentReference, providerCheckoutUrl, providerOrderId or adminNote anywhere in the body', async () => {
    const { secrets } = await seedPurchaseWithSecrets();

    const serialized = JSON.stringify(await summary());

    for (const field of FORBIDDEN_FIELDS) {
      expect(serialized, `key ${field}`).not.toContain(`"${field}"`);
    }
    for (const value of Object.values(secrets)) {
      expect(serialized, `value ${value}`).not.toContain(value);
    }
  });

  it('returns exactly the eleven fields the admin finance screen reads — the allowlist, nothing more', async () => {
    const { provider, offerPackage, purchase } = await seedPurchaseWithSecrets();

    const body = await summary();

    expect(body.recentPurchases).toHaveLength(1);
    const [row] = body.recentPurchases;
    expect(Object.keys(row ?? {}).sort()).toEqual(ADMIN_SCREEN_FIELDS);
    expect(row).toEqual({
      id: purchase.id,
      purchaseNumber: purchase.purchaseNumber,
      createdAt: purchase.createdAt.toISOString(),
      providerId: provider.id,
      provider: { businessName: provider.businessName },
      packageNameSnapshot: offerPackage.name,
      creditAmountSnapshot: offerPackage.creditAmount,
      priceAmountSnapshot: offerPackage.priceAmount,
      currencySnapshot: purchase.currencySnapshot,
      status: PackagePurchaseStatus.PENDING,
      mockPaymentReference: 'MOCK-REF-1',
    });
  });
});
