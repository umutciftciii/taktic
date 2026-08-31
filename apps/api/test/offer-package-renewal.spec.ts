import {
  EntitlementRenewalFailureCode,
  EntitlementRenewalStatus,
  OfferPackageType,
  ProviderEntitlementStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EntitlementRenewalService } from '../src/modules/entitlements/entitlement-renewal.service';
import {
  CheckoutSession,
  CheckoutSessionRequest,
  PaymentProviderCapabilities,
  PaymentProviderPort,
  StoredPaymentChargeError,
  StoredPaymentChargeRequest,
  StoredPaymentChargeResult,
} from '../src/modules/payments/payment-provider.port';
import {
  createCategory,
  createEntitlement,
  createOfferPackage,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An adapter that *can* charge a stored payment method.
 *
 * No adapter shipped in this build can, which is exactly why the successful
 * renewal path needs a stand-in to be testable at all. Its existence in the
 * test suite is not a claim that the feature is live: the two real adapters
 * both declare `automaticRenewal: false`, and there is a case below that pins
 * that.
 */
class RenewingPaymentAdapter extends PaymentProviderPort {
  readonly kind = 'mock' as const;
  readonly capabilities: PaymentProviderCapabilities = {
    automaticRenewal: true,
    automaticRenewalUnsupportedReason: null,
  };

  readonly charges: StoredPaymentChargeRequest[] = [];
  failWith: StoredPaymentChargeError['failureCode'] | null = null;

  async createCheckoutSession(_request: CheckoutSessionRequest): Promise<CheckoutSession> {
    return { provider: this.kind, url: null, providerCheckoutId: null, expiresAt: null };
  }

  async chargeStoredPaymentMethod(
    input: StoredPaymentChargeRequest,
  ): Promise<StoredPaymentChargeResult> {
    this.charges.push(input);

    if (this.failWith) {
      throw new StoredPaymentChargeError(this.failWith);
    }

    return { providerTransactionRef: `txn-${this.charges.length}` };
  }
}

let defaultCtx: TestContext;
let renewingCtx: TestContext;
const renewingAdapter = new RenewingPaymentAdapter();

beforeAll(async () => {
  defaultCtx = await createTestApp();
  renewingCtx = await createTestApp({ paymentProvider: renewingAdapter });
});

afterAll(async () => {
  await defaultCtx.app.close();
  await renewingCtx.app.close();
});

beforeEach(async () => {
  await resetDatabase(defaultCtx.prisma);
  renewingAdapter.charges.length = 0;
  renewingAdapter.failWith = null;
});

/** A period that ran out an hour ago, with auto-renew already on. */
async function duePeriod(
  ctx: TestContext,
  options: { autoRenewEnabled?: boolean; paymentMethodReference?: string | null } = {},
) {
  const category = await createCategory(defaultCtx.prisma, 'Klima', { offerCreditCost: 2 });
  const provider = await createProviderProfile(defaultCtx.prisma, {});
  const pkg = await createOfferPackage(defaultCtx.prisma, {
    type: OfferPackageType.MONTHLY_QUOTA,
    quotaCredits: 20,
  });

  const entitlement = await createEntitlement(defaultCtx.prisma, {
    providerId: provider.id,
    packageId: pkg.id,
    type: OfferPackageType.MONTHLY_QUOTA,
    startAt: new Date(Date.now() - 31 * DAY_MS),
    endAt: new Date(Date.now() - 60 * 60 * 1000),
    quotaCredits: 20,
    // Partly spent, so a reset is distinguishable from a top-up.
    remainingQuota: 3,
    autoRenewEnabled: options.autoRenewEnabled ?? true,
    paymentMethodReference:
      options.paymentMethodReference === undefined
        ? 'pm_provider_token_reference'
        : options.paymentMethodReference,
  });

  return { category, provider, pkg, entitlement };
}

describe('a period whose clock has run out', () => {
  it('simply expires when auto-renew was never turned on', async () => {
    const { entitlement } = await duePeriod(defaultCtx, { autoRenewEnabled: false });

    const summary = await defaultCtx.app
      .get(EntitlementRenewalService)
      .runDueRenewals();

    expect(summary.expired).toBe(1);
    const after = await defaultCtx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    expect(after.status).toBe(ProviderEntitlementStatus.EXPIRED);
    // Nothing was attempted, so nothing is recorded as an attempt.
    expect(
      await defaultCtx.prisma.packageRenewalAttempt.count({
        where: { entitlementId: entitlement.id },
      }),
    ).toBe(0);
  });

  it('records UNSUPPORTED and does not extend access when the adapter cannot charge', async () => {
    const { entitlement } = await duePeriod(defaultCtx);
    const before = await defaultCtx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });

    const summary = await defaultCtx.app.get(EntitlementRenewalService).runDueRenewals();

    expect(summary.unsupported).toBe(1);
    const after = await defaultCtx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    expect(after.status).toBe(ProviderEntitlementStatus.PAST_DUE);
    // The one assertion this whole feature turns on: a payment that did not
    // happen buys no time at all.
    expect(after.endAt.toISOString()).toBe(before.endAt.toISOString());
    expect(after.periodIndex).toBe(0);
    expect(after.remainingQuota).toBe(3);
    expect(after.lastRenewalFailureCode).toBe(
      EntitlementRenewalFailureCode.PROVIDER_UNSUPPORTED,
    );

    const attempt = await defaultCtx.prisma.packageRenewalAttempt.findFirstOrThrow({
      where: { entitlementId: entitlement.id },
    });
    expect(attempt.status).toBe(EntitlementRenewalStatus.UNSUPPORTED);
    expect(attempt.periodIndex).toBe(1);
    expect(attempt.providerTransactionRef).toBeNull();
  });
});

describe('with an adapter that can charge a stored payment method', () => {
  it('starts the next period at the previous end and resets the quota', async () => {
    const { entitlement } = await duePeriod(renewingCtx);
    const before = await renewingCtx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });

    const summary = await renewingCtx.app.get(EntitlementRenewalService).runDueRenewals();

    expect(summary.renewed).toBe(1);
    const after = await renewingCtx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });

    expect(after.status).toBe(ProviderEntitlementStatus.ACTIVE);
    expect(after.periodIndex).toBe(1);
    // The charge landed after the period had already lapsed, so the new period
    // starts when the money arrived rather than back-dated to the old end.
    expect(after.startAt.getTime()).toBeGreaterThan(before.endAt.getTime());
    expect(after.endAt.getTime() - after.startAt.getTime()).toBe(30 * DAY_MS);
    // Reset from the snapshot, not topped up: 20, never 23.
    expect(after.remainingQuota).toBe(20);
    expect(after.lastRenewalFailureCode).toBeNull();

    const attempt = await renewingCtx.prisma.packageRenewalAttempt.findFirstOrThrow({
      where: { entitlementId: entitlement.id },
    });
    expect(attempt.status).toBe(EntitlementRenewalStatus.SUCCEEDED);
    expect(attempt.providerTransactionRef).toBe('txn-1');

    // The idempotency key names the period, so a provider that honours keys
    // refuses a second charge on its own side.
    expect(renewingAdapter.charges).toHaveLength(1);
    const [charge] = renewingAdapter.charges;
    expect(charge?.idempotencyKey).toBe(`${entitlement.id}:1`);
    expect(charge?.paymentMethodReference).toBe('pm_provider_token_reference');
  });

  it('records the failure class and does not extend access when the charge is declined', async () => {
    const { entitlement } = await duePeriod(renewingCtx);
    const before = await renewingCtx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    renewingAdapter.failWith = 'PAYMENT_DECLINED';

    const summary = await renewingCtx.app.get(EntitlementRenewalService).runDueRenewals();

    expect(summary.failed).toBe(1);
    const after = await renewingCtx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    expect(after.status).toBe(ProviderEntitlementStatus.PAST_DUE);
    expect(after.endAt.toISOString()).toBe(before.endAt.toISOString());
    expect(after.periodIndex).toBe(0);
    expect(after.lastRenewalFailureCode).toBe(EntitlementRenewalFailureCode.PAYMENT_DECLINED);

    const attempt = await renewingCtx.prisma.packageRenewalAttempt.findFirstOrThrow({
      where: { entitlementId: entitlement.id },
    });
    expect(attempt.status).toBe(EntitlementRenewalStatus.FAILED);
  });

  it('reports a missing payment method as its own class', async () => {
    const { entitlement } = await duePeriod(renewingCtx, { paymentMethodReference: null });

    await renewingCtx.app.get(EntitlementRenewalService).runDueRenewals();

    const attempt = await renewingCtx.prisma.packageRenewalAttempt.findFirstOrThrow({
      where: { entitlementId: entitlement.id },
    });
    expect(attempt.failureCode).toBe(EntitlementRenewalFailureCode.PAYMENT_METHOD_MISSING);
    expect(renewingAdapter.charges).toHaveLength(0);
  });

  it('charges once when two passes run at the same time', async () => {
    const { entitlement } = await duePeriod(renewingCtx);
    const service = renewingCtx.app.get(EntitlementRenewalService);

    await Promise.all([service.runDueRenewals(), service.runDueRenewals()]);

    expect(renewingAdapter.charges).toHaveLength(1);
    expect(
      await renewingCtx.prisma.packageRenewalAttempt.count({
        where: {
          entitlementId: entitlement.id,
          status: EntitlementRenewalStatus.SUCCEEDED,
        },
      }),
    ).toBe(1);
    const after = await renewingCtx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    expect(after.periodIndex).toBe(1);
  });

  it('cannot record two successful renewals for one period', async () => {
    const { entitlement } = await duePeriod(renewingCtx);

    await renewingCtx.prisma.packageRenewalAttempt.create({
      data: {
        entitlementId: entitlement.id,
        periodIndex: 1,
        status: EntitlementRenewalStatus.SUCCEEDED,
        providerTransactionRef: 'txn-existing',
      },
    });

    await expect(
      renewingCtx.prisma.packageRenewalAttempt.create({
        data: {
          entitlementId: entitlement.id,
          periodIndex: 1,
          status: EntitlementRenewalStatus.SUCCEEDED,
          providerTransactionRef: 'txn-duplicate',
        },
      }),
    ).rejects.toThrow();

    // A failed attempt for the same period is still allowed: it is the audit
    // trail of a period that kept failing to renew.
    await expect(
      renewingCtx.prisma.packageRenewalAttempt.create({
        data: {
          entitlementId: entitlement.id,
          periodIndex: 1,
          status: EntitlementRenewalStatus.FAILED,
          failureCode: EntitlementRenewalFailureCode.PAYMENT_DECLINED,
        },
      }),
    ).resolves.toBeTruthy();
  });
});

describe('turning auto-renew on and off', () => {
  async function providerWithPeriod(ctx: TestContext) {
    const ownerUser = await createUser(defaultCtx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(defaultCtx.prisma, { userId: ownerUser.id });
    const pkg = await createOfferPackage(defaultCtx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 10,
    });
    const entitlement = await createEntitlement(defaultCtx.prisma, {
      providerId: provider.id,
      packageId: pkg.id,
      type: OfferPackageType.MONTHLY_QUOTA,
    });
    const cookie = await loginAs(defaultCtx.prisma, ownerUser.id);

    return { ownerUser, provider, pkg, entitlement, cookie, ctx };
  }

  it('refuses to switch it on while no adapter can charge, and says why', async () => {
    const { provider, entitlement, cookie } = await providerWithPeriod(defaultCtx);

    const response = await request(defaultCtx.server)
      .patch(`/providers/${provider.id}/entitlements/${entitlement.id}/auto-renew`)
      .set('Cookie', cookie)
      .send({ enabled: true });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('AUTO_RENEW_UNSUPPORTED');
    expect(response.body.unsupportedReason).toBe('NO_STORED_PAYMENT_METHOD');
    // The wording is a fact, not a promise of a later release.
    expect(response.body.message).toContain('otomatik yenileme kullanılamıyor');
    expect(response.body.message).not.toMatch(/yakında|coming soon/i);

    const after = await defaultCtx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    expect(after.autoRenewEnabled).toBe(false);
  });

  it('advertises the capability as unavailable on the provider listing', async () => {
    const { provider, cookie } = await providerWithPeriod(defaultCtx);

    const response = await request(defaultCtx.server)
      .get(`/providers/${provider.id}/entitlements`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.autoRenew.available).toBe(false);
    expect(response.body.autoRenew.unsupportedReason).toBe('NO_STORED_PAYMENT_METHOD');
    expect(response.body.autoRenew.periodDays).toBe(30);
  });

  it('cancelling does not shorten the period the provider paid for', async () => {
    const { provider, entitlement, cookie } = await providerWithPeriod(defaultCtx);
    await defaultCtx.prisma.providerPackageEntitlement.update({
      where: { id: entitlement.id },
      data: { autoRenewEnabled: true, autoRenewConsentAt: new Date() },
    });
    const before = await defaultCtx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });

    const response = await request(defaultCtx.server)
      .post(`/providers/${provider.id}/entitlements/${entitlement.id}/cancel`)
      .set('Cookie', cookie)
      .expect(201);

    const after = await defaultCtx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    expect(after.autoRenewEnabled).toBe(false);
    expect(after.autoRenewConsentAt).toBeNull();
    expect(after.cancelledAt).not.toBeNull();
    // Still ACTIVE, still ending when it always did.
    expect(after.status).toBe(ProviderEntitlementStatus.ACTIVE);
    expect(after.endAt.toISOString()).toBe(before.endAt.toISOString());

    const listed = response.body.entitlements.find(
      (item: { id: string }) => item.id === entitlement.id,
    );
    expect(listed.usable).toBe(true);
  });

  it('lets a cancelled period still pay for offers until it ends', async () => {
    const category = await createCategory(defaultCtx.prisma, 'Klima', { offerCreditCost: 3 });
    const ownerUser = await createUser(defaultCtx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(defaultCtx.prisma, { userId: ownerUser.id });
    await defaultCtx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: category.id },
    });
    await defaultCtx.prisma.providerServiceArea.create({
      data: { providerId: provider.id, city: 'İstanbul', district: 'Kadıköy' },
    });
    const pkg = await createOfferPackage(defaultCtx.prisma, {
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 10,
    });
    const entitlement = await createEntitlement(defaultCtx.prisma, {
      providerId: provider.id,
      packageId: pkg.id,
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 10,
      autoRenewEnabled: true,
    });
    const cookie = await loginAs(defaultCtx.prisma, ownerUser.id);

    await request(defaultCtx.server)
      .post(`/providers/${provider.id}/entitlements/${entitlement.id}/cancel`)
      .set('Cookie', cookie)
      .expect(201);

    const serviceRequest = await defaultCtx.prisma.serviceRequest.create({
      data: {
        categoryId: category.id,
        requestNumber: `TR-CANCEL-${entitlement.id.slice(-6)}`,
        customerName: 'Müşteri',
        customerPhone: '05554443322',
        city: 'İstanbul',
        district: 'Kadıköy',
        status: 'APPROVED',
        qualityScore: 80,
      },
    });

    const offer = await request(defaultCtx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', cookie)
      .send({
        priceAmount: 150_000,
        currency: 'TRY',
        message: 'Cancelled period still pays for this offer.',
      });

    expect(offer.status).toBe(201);
    const after = await defaultCtx.prisma.providerPackageEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    expect(after.remainingQuota).toBe(7);
  });
});
