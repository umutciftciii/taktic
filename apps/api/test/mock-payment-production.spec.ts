import {
  OfferPackageType,
  PackagePurchaseStatus,
  ServiceCategoryKind,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MOCK_PAYMENT_UNAVAILABLE,
  isMockPaymentPermitted,
} from '../src/modules/payments/mock-payment-availability';
import {
  createCategory,
  createDiscoverableProvider,
  createShowcasePackage,
  createTestApp,
  createUser,
  currentCreditBalance,
  loginAs,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * RELEASE-GAP-001 G-02: the mock card form settles nothing, so on production it
 * must neither open a purchase nor settle one.
 *
 * `mock` is the only provider a production boot accepts, which is why the
 * provider check that already closes `mock-pay` on a Lemon Squeezy deployment
 * cannot close it here. What closes it is the deployment's own statement,
 * APP_ENVIRONMENT — the same rule the sandbox integrations follow.
 */

const MANAGED_KEYS = ['APP_ENVIRONMENT', 'PAYMENT_PROVIDER'] as const;

const MOCK_CARD = {
  cardholderName: 'Test Kart',
  cardNumber: '4111111111111111',
  expiryMonth: 12,
  expiryYear: 2030,
  cvv: '123',
};

let ctx: TestContext;
let original: Record<string, string | undefined>;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  original = Object.fromEntries(MANAGED_KEYS.map((key) => [key, process.env[key]]));
  process.env.PAYMENT_PROVIDER = 'mock';
  delete process.env.APP_ENVIRONMENT;
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

async function providerWithPackages() {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: owner.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const suffix = uniqueSuffix();
  const creditPackage = await ctx.prisma.offerCreditPackage.create({
    data: {
      name: `Başlangıç Paketi ${suffix}`,
      slug: `paket-${suffix}`,
      creditAmount: 30,
      priceAmount: 49900,
      currency: 'TRY',
      isActive: true,
      type: OfferPackageType.ONE_TIME_CREDITS,
    },
  });
  const showcasePackage = await createShowcasePackage(ctx.prisma);
  const cookie = await loginAs(ctx.prisma, owner.id);

  return { provider, creditPackage, showcasePackage, cookie };
}

const creditCheckout = (providerId: string, cookie: string, packageId: string) =>
  request(ctx.server)
    .post(`/providers/${providerId}/checkout-sessions`)
    .set('Cookie', cookie)
    .send({ packageId });

const legacyPurchase = (providerId: string, cookie: string, packageId: string) =>
  request(ctx.server)
    .post(`/providers/${providerId}/package-purchases`)
    .set('Cookie', cookie)
    .send({ packageId });

const showcaseCheckout = (providerId: string, cookie: string, showcasePackageId: string) =>
  request(ctx.server)
    .post(`/providers/${providerId}/showcase/packages/checkout`)
    .set('Cookie', cookie)
    .send({ showcasePackageId, priceTermsAccepted: true, priceTermsVersion: 'v1' });

const mockPay = (providerId: string, cookie: string, purchaseId: string) =>
  request(ctx.server)
    .post(`/providers/${providerId}/package-purchases/${purchaseId}/mock-pay`)
    .set('Cookie', cookie)
    .send(MOCK_CARD);

describe('where the mock form may run', () => {
  it('follows the sandbox rule: never on production, always on staging', () => {
    expect(isMockPaymentPermitted({ APP_ENVIRONMENT: 'production', NODE_ENV: 'development' })).toBe(false);
    expect(isMockPaymentPermitted({ APP_ENVIRONMENT: 'production', NODE_ENV: 'test' })).toBe(false);
    expect(isMockPaymentPermitted({ APP_ENVIRONMENT: 'production', NODE_ENV: 'production' })).toBe(false);
    // A production build that forgot to declare itself is closed, not local.
    expect(isMockPaymentPermitted({ NODE_ENV: 'production' })).toBe(false);
    expect(isMockPaymentPermitted({ APP_ENVIRONMENT: 'local', NODE_ENV: 'production' })).toBe(false);

    expect(isMockPaymentPermitted({ APP_ENVIRONMENT: 'staging', NODE_ENV: 'production' })).toBe(true);
    expect(isMockPaymentPermitted({ APP_ENVIRONMENT: 'local', NODE_ENV: 'development' })).toBe(true);
    expect(isMockPaymentPermitted({ NODE_ENV: 'test' })).toBe(true);
  });

  it('refuses a misspelt environment loudly rather than reading it as "not production"', () => {
    expect(() => isMockPaymentPermitted({ APP_ENVIRONMENT: 'prod', NODE_ENV: 'test' })).toThrow(
      /APP_ENVIRONMENT must be one of/,
    );
  });
});

describe('on APP_ENVIRONMENT=production', () => {
  it('does not settle a pending credit purchase, and loads no credit', async () => {
    const { provider, creditPackage, cookie } = await providerWithPackages();
    const opened = await legacyPurchase(provider.id, cookie, creditPackage.id).expect(201);
    const purchaseId = opened.body.id as string;

    process.env.APP_ENVIRONMENT = 'production';
    const refused = await mockPay(provider.id, cookie, purchaseId);

    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe(MOCK_PAYMENT_UNAVAILABLE);
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(purchase.status).toBe(PackagePurchaseStatus.PENDING);
    expect(purchase.paidAt).toBeNull();
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('does not settle a pending vitrin purchase, and grants no right', async () => {
    const { provider, showcasePackage, cookie } = await providerWithPackages();
    const opened = await showcaseCheckout(provider.id, cookie, showcasePackage.id).expect(201);
    const purchaseId = opened.body.purchase.id as string;

    process.env.APP_ENVIRONMENT = 'production';
    const refused = await mockPay(provider.id, cookie, purchaseId);

    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe(MOCK_PAYMENT_UNAVAILABLE);
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(purchase.status).toBe(PackagePurchaseStatus.PENDING);
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(0);
    expect(await ctx.prisma.showcasePlacement.count()).toBe(0);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('answers a missing or foreign purchase exactly as it answers an own one', async () => {
    const owner = await providerWithPackages();
    const other = await providerWithPackages();
    const foreign = await legacyPurchase(other.provider.id, other.cookie, other.creditPackage.id).expect(201);

    process.env.APP_ENVIRONMENT = 'production';
    const missing = await mockPay(owner.provider.id, owner.cookie, 'cmissingpurchase000000000');
    const crossed = await mockPay(owner.provider.id, owner.cookie, foreign.body.id as string);

    for (const response of [missing, crossed]) {
      expect(response.status).toBe(404);
      expect(response.body.code).toBe(MOCK_PAYMENT_UNAVAILABLE);
    }
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
  });

  it('opens no credit checkout and hands back no pending one', async () => {
    const { provider, creditPackage, cookie } = await providerWithPackages();
    // A mock checkout left pending from before the deployment declared itself.
    await creditCheckout(provider.id, cookie, creditPackage.id).expect(201);

    process.env.APP_ENVIRONMENT = 'production';
    const refused = await creditCheckout(provider.id, cookie, creditPackage.id);

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe(MOCK_PAYMENT_UNAVAILABLE);
    expect(refused.body.purchase).toBeUndefined();
    expect(await ctx.prisma.packagePurchase.count()).toBe(1);
  });

  it('opens no purchase through the legacy package-purchase route', async () => {
    const { provider, creditPackage, cookie } = await providerWithPackages();

    process.env.APP_ENVIRONMENT = 'production';
    const refused = await legacyPurchase(provider.id, cookie, creditPackage.id);

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe(MOCK_PAYMENT_UNAVAILABLE);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });

  it('opens no vitrin checkout and records no acceptance', async () => {
    const { provider, showcasePackage, cookie } = await providerWithPackages();

    process.env.APP_ENVIRONMENT = 'production';
    const refused = await showcaseCheckout(provider.id, cookie, showcasePackage.id);

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe(MOCK_PAYMENT_UNAVAILABLE);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
    expect(await ctx.prisma.showcasePackageTermsAcceptance.count()).toBe(0);
  });
});

describe('on APP_ENVIRONMENT=staging', () => {
  it('still opens and settles through the mock form, as before', async () => {
    process.env.APP_ENVIRONMENT = 'staging';
    const { provider, creditPackage, showcasePackage, cookie } = await providerWithPackages();

    const credit = await creditCheckout(provider.id, cookie, creditPackage.id).expect(201);
    const paid = await mockPay(provider.id, cookie, credit.body.purchase.id as string);
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe('PAID');
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(30);

    const vitrin = await showcaseCheckout(provider.id, cookie, showcasePackage.id).expect(201);
    const settled = await mockPay(provider.id, cookie, vitrin.body.purchase.id as string);
    expect(settled.status).toBe(201);
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(1);
  });
});
