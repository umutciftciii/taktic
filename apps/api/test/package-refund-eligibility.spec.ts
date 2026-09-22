import {
  CreditTransactionType,
  OfferPackageType,
  PackagePurchaseKind,
  PackagePurchaseStatus,
  UserRole,
} from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  consumePromoCreditsForSpend,
  grantPromoCreditLot,
} from '../src/modules/credits/promo-credit-ledger';
import {
  PACKAGE_REFUND_WINDOW_MS,
  evaluatePackageRefundEligibility,
  type PackageRefundEligibilityFacts,
} from '../src/modules/package-refunds/package-refund-eligibility';
import { PackageRefundEligibilityService } from '../src/modules/package-refunds/package-refund-eligibility.service';
import { createCampaignFixture } from './campaign-fixtures';
import {
  createOfferPackage,
  createProviderProfile,
  createTestApp,
  createUser,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * CMP-006 PR-A — the canonical package *money* refund eligibility.
 *
 * Two halves. The pure function is proved rule by rule against hand-written
 * facts, including the exact 14-day boundary. The service is proved against
 * real rows: offer spends before and after payment, promo lots linked to this
 * purchase or another, used and unused — and that concurrent and repeated
 * evaluations at the same instant are identical.
 *
 * Nothing here may move money or credits; the last case says so from the rows.
 */

const PAID_AT = new Date('2026-09-01T10:00:00.000Z');
const SECOND = 1000;

function facts(overrides: Partial<PackageRefundEligibilityFacts> = {}): PackageRefundEligibilityFacts {
  return {
    purchaseId: 'purchase-1',
    kind: PackagePurchaseKind.OFFER_PACKAGE,
    status: PackagePurchaseStatus.PAID,
    packageType: OfferPackageType.ONE_TIME_CREDITS,
    paidAt: PAID_AT,
    reversalRecordedAt: null,
    offerSpendCountSincePaid: 0,
    firstOfferSpendAtSincePaid: null,
    linkedPromoConsumptionCount: 0,
    linkedPromoConsumedCredits: 0,
    ...overrides,
  };
}

const at = (ms: number) => new Date(PAID_AT.getTime() + ms);

describe('evaluatePackageRefundEligibility (pure)', () => {
  it('is REFUNDABLE when every rule passes, and says it is only advice', () => {
    const result = evaluatePackageRefundEligibility(facts(), at(SECOND));
    expect(result.recommendation).toBe('REFUNDABLE');
    expect(result.blockingCodes).toEqual([]);
    expect(result.reasons.map((entry) => entry.code)).toEqual([
      'WITHIN_REFUND_WINDOW',
      'NO_CREDIT_SPENT_SINCE_PAYMENT',
      'NO_LINKED_PROMO_CONSUMED',
    ]);
    expect(result.summary).toContain('yalnız bir tavsiyedir');
    expect(result.windowEndsAt).toBe(at(PACKAGE_REFUND_WINDOW_MS).toISOString());
  });

  it('keeps the window open at exactly 14 days, and closes it 1 second later', () => {
    expect(evaluatePackageRefundEligibility(facts(), at(PACKAGE_REFUND_WINDOW_MS)).recommendation).toBe(
      'REFUNDABLE',
    );

    const late = evaluatePackageRefundEligibility(facts(), at(PACKAGE_REFUND_WINDOW_MS + SECOND));
    expect(late.recommendation).toBe('EXCEPTION_ONLY');
    expect(late.blockingCodes).toEqual(['REFUND_WINDOW_EXPIRED']);
    expect(late.reasons[0]?.explanation).toContain('14 günden fazla');
  });

  it('refuses a normal refund after any offer-credit spend since payment', () => {
    const result = evaluatePackageRefundEligibility(
      facts({ offerSpendCountSincePaid: 1, firstOfferSpendAtSincePaid: at(60 * SECOND) }),
      at(SECOND),
    );
    expect(result.recommendation).toBe('EXCEPTION_ONLY');
    expect(result.blockingCodes).toEqual(['CREDIT_SPENT_SINCE_PAYMENT']);
    expect(result.reasons.find((entry) => entry.blocking)!.explanation).toContain(
      'promosyondan veya önceki bakiyeden',
    );
  });

  it('refuses a normal refund when a linked promo credit was consumed', () => {
    const result = evaluatePackageRefundEligibility(
      facts({ linkedPromoConsumptionCount: 1, linkedPromoConsumedCredits: 1 }),
      at(SECOND),
    );
    expect(result.blockingCodes).toEqual(['LINKED_PROMO_CONSUMED']);
  });

  it('reports every blocking rule at once, in canonical order', () => {
    const result = evaluatePackageRefundEligibility(
      facts({ offerSpendCountSincePaid: 3, linkedPromoConsumptionCount: 2 }),
      at(PACKAGE_REFUND_WINDOW_MS + SECOND),
    );
    expect(result.blockingCodes).toEqual([
      'REFUND_WINDOW_EXPIRED',
      'CREDIT_SPENT_SINCE_PAYMENT',
      'LINKED_PROMO_CONSUMED',
    ]);
    expect(result.summary).toContain('3 tanesi sağlanmıyor');
  });

  it.each([
    ['PENDING', { status: PackagePurchaseStatus.PENDING, paidAt: null }, 'PURCHASE_NOT_PAID'],
    ['FAILED', { status: PackagePurchaseStatus.FAILED, paidAt: null }, 'PURCHASE_NOT_PAID'],
    ['REFUNDED', { status: PackagePurchaseStatus.REFUNDED }, 'PURCHASE_ALREADY_REFUNDED'],
    ['reversal flagged', { reversalRecordedAt: at(SECOND) }, 'PAYMENT_REVERSAL_RECORDED'],
  ] as const)('is NOT_APPLICABLE for a %s purchase', (_label, overrides, code) => {
    const result = evaluatePackageRefundEligibility(facts(overrides), at(SECOND));
    expect(result.recommendation).toBe('NOT_APPLICABLE');
    expect(result.blockingCodes).toEqual([code]);
    expect(result.windowEndsAt).toBeNull();
  });

  it.each([
    ['a vitrin purchase', { kind: PackagePurchaseKind.SHOWCASE_PACKAGE, packageType: null }, 'PURCHASE_KIND_NOT_COVERED'],
    ['a monthly quota package', { packageType: OfferPackageType.MONTHLY_QUOTA }, 'PACKAGE_TYPE_NOT_COVERED'],
    ['an unlimited package', { packageType: OfferPackageType.CATEGORY_UNLIMITED }, 'PACKAGE_TYPE_NOT_COVERED'],
  ] as const)('leaves %s to an exception review', (_label, overrides, code) => {
    const result = evaluatePackageRefundEligibility(facts(overrides), at(SECOND));
    expect(result.recommendation).toBe('EXCEPTION_ONLY');
    expect(result.blockingCodes).toEqual([code]);
  });

  it('is a function of its inputs: the same facts and instant give an identical result', () => {
    const input = facts({ offerSpendCountSincePaid: 1 });
    const now = at(5 * SECOND);
    expect(evaluatePackageRefundEligibility(input, now)).toEqual(evaluatePackageRefundEligibility(input, now));
  });
});

describe('PackageRefundEligibilityService (real rows)', () => {
  let ctx: TestContext;
  let service: PackageRefundEligibilityService;

  beforeAll(async () => {
    ctx = await createTestApp();
    service = ctx.app.get(PackageRefundEligibilityService);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  async function paidPurchase(options: { type?: OfferPackageType; paidAt?: Date } = {}) {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
    const pkg = await createOfferPackage(ctx.prisma, { type: options.type });
    const purchase = await ctx.prisma.packagePurchase.create({
      data: {
        providerId: provider.id,
        packageId: pkg.id,
        status: PackagePurchaseStatus.PAID,
        paidAt: options.paidAt ?? PAID_AT,
        creditAmountSnapshot: pkg.creditAmount,
        priceAmountSnapshot: pkg.priceAmount,
        packageNameSnapshot: pkg.name,
      },
    });
    return { provider, purchase };
  }

  let balance = 0;
  async function ledger(providerId: string, type: CreditTransactionType, amount: number, createdAt: Date) {
    balance += amount;
    return ctx.prisma.providerCreditTransaction.create({
      data: { providerId, type, amount, balanceAfter: Math.max(balance, 0), createdAt },
    });
  }

  /** A promo lot granted for `purchaseId` — the redemption a paid purchase raises. */
  async function linkedPromoLot(providerId: string, purchaseId: string, credits = 5) {
    const { campaign, version } = await createCampaignFixture(ctx.prisma, {
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      credits,
    });
    const key = `PACKAGE_PAYMENT_SUCCEEDED:${purchaseId}:${uniqueSuffix()}`;
    const event = await ctx.prisma.campaignTriggerEvent.create({
      data: { triggerEventKey: key, trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId, purchaseId },
    });
    const redemption = await ctx.prisma.campaignRedemption.create({
      data: {
        campaignId: campaign.id,
        campaignVersionId: version.id,
        providerId,
        trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
        triggerEventId: event.id,
        triggerEventKey: key,
        purchaseId,
        rulesSnapshot: {},
        grantedCredits: credits,
      },
    });
    await ctx.prisma.$transaction(
      (tx) =>
        grantPromoCreditLot(tx, {
          providerId,
          redemptionId: redemption.id,
          credits,
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
          now: new Date(),
        }),
      { isolationLevel: 'Serializable' },
    );
    balance += credits;
  }

  /** An offer spend drawn from the provider's promo lots first, as the offer flow does. */
  async function spendFromPromo(providerId: string, cost: number, createdAt: Date) {
    await ctx.prisma.$transaction(
      async (tx) => {
        balance -= cost;
        const spend = await tx.providerCreditTransaction.create({
          data: {
            providerId,
            type: CreditTransactionType.OFFER_SPEND,
            amount: -cost,
            balanceAfter: Math.max(balance, 0),
            createdAt,
          },
        });
        await consumePromoCreditsForSpend(tx, {
          providerId,
          spendTransactionId: spend.id,
          creditCost: cost,
          now: new Date(),
        });
      },
      { isolationLevel: 'Serializable' },
    );
  }

  beforeEach(() => {
    balance = 0;
  });

  it('a fresh, untouched credit purchase is REFUNDABLE', async () => {
    const { purchase } = await paidPurchase();
    const result = await service.evaluate(purchase.id, at(SECOND));
    expect(result.recommendation).toBe('REFUNDABLE');
  });

  it('14 days and 1 second after payment is expired', async () => {
    const { purchase } = await paidPurchase();
    expect((await service.evaluate(purchase.id, at(PACKAGE_REFUND_WINDOW_MS))).recommendation).toBe(
      'REFUNDABLE',
    );
    expect(
      (await service.evaluate(purchase.id, at(PACKAGE_REFUND_WINDOW_MS + SECOND))).blockingCodes,
    ).toEqual(['REFUND_WINDOW_EXPIRED']);
  });

  it('an offer spend before payment does not count; one after payment does, whatever paid for it', async () => {
    const { provider, purchase } = await paidPurchase();
    await ledger(provider.id, CreditTransactionType.ADMIN_GRANT, 10, at(-3600 * SECOND));
    await ledger(provider.id, CreditTransactionType.OFFER_SPEND, -2, at(-60 * SECOND));
    await ledger(provider.id, CreditTransactionType.PACKAGE_PURCHASE, 10, PAID_AT);

    expect((await service.evaluate(purchase.id, at(SECOND))).recommendation).toBe('REFUNDABLE');

    // Spent from the *older* balance — it still blocks (D1b: no source split).
    await ledger(provider.id, CreditTransactionType.OFFER_SPEND, -1, at(120 * SECOND));
    const result = await service.evaluate(purchase.id, at(200 * SECOND));
    expect(result.blockingCodes).toEqual(['CREDIT_SPENT_SINCE_PAYMENT']);
    expect(result.facts.offerSpendCountSincePaid).toBe(1);
    expect(result.facts.firstOfferSpendAtSincePaid).toBe(at(120 * SECOND).toISOString());
  });

  it('a spend at the very instant of payment counts (the conservative side of the tie)', async () => {
    const { provider, purchase } = await paidPurchase();
    await ledger(provider.id, CreditTransactionType.OFFER_SPEND, -1, PAID_AT);
    expect((await service.evaluate(purchase.id, at(SECOND))).blockingCodes).toEqual([
      'CREDIT_SPENT_SINCE_PAYMENT',
    ]);
  });

  it('another provider’s spends are not this purchase’s business', async () => {
    const { purchase } = await paidPurchase();
    const other = await paidPurchase();
    await ledger(other.provider.id, CreditTransactionType.OFFER_SPEND, -1, at(60 * SECOND));
    expect((await service.evaluate(purchase.id, at(120 * SECOND))).recommendation).toBe('REFUNDABLE');
  });

  it('an unused promo lot linked to the purchase does not, on its own, break eligibility', async () => {
    const { provider, purchase } = await paidPurchase({ paidAt: new Date(Date.now() - 60_000) });
    await linkedPromoLot(provider.id, purchase.id);

    const result = await service.evaluate(purchase.id);
    expect(result.recommendation).toBe('REFUNDABLE');
    expect(result.reasons.map((entry) => entry.code)).toContain('NO_LINKED_PROMO_CONSUMED');
  });

  it('consuming a linked promo credit blocks, and reports both the spend and the promo use', async () => {
    const paidAt = new Date(Date.now() - 60_000);
    const { provider, purchase } = await paidPurchase({ paidAt });
    await linkedPromoLot(provider.id, purchase.id, 5);
    await spendFromPromo(provider.id, 1, new Date());

    const result = await service.evaluate(purchase.id);
    expect(result.blockingCodes).toEqual(['CREDIT_SPENT_SINCE_PAYMENT', 'LINKED_PROMO_CONSUMED']);
    expect(result.facts.linkedPromoConsumptionCount).toBe(1);
    expect(result.facts.linkedPromoConsumedCredits).toBe(1);
  });

  it('promo consumed from a lot linked to a different purchase is not a linked consumption', async () => {
    const paidAt = new Date(Date.now() - 60_000);
    const { provider, purchase } = await paidPurchase({ paidAt });
    const unrelated = await ctx.prisma.packagePurchase.create({
      data: {
        providerId: provider.id,
        packageId: purchase.packageId,
        status: PackagePurchaseStatus.PAID,
        paidAt: new Date(Date.now() - 120_000),
        creditAmountSnapshot: 1,
        priceAmountSnapshot: 1,
        packageNameSnapshot: 'Eski paket',
      },
    });
    await linkedPromoLot(provider.id, unrelated.id, 5);
    await spendFromPromo(provider.id, 1, new Date());

    const result = await service.evaluate(purchase.id);
    expect(result.blockingCodes).toEqual(['CREDIT_SPENT_SINCE_PAYMENT']);
    expect(result.facts.linkedPromoConsumptionCount).toBe(0);
  });

  it('a period package is left to an exception review', async () => {
    const { purchase } = await paidPurchase({ type: OfferPackageType.MONTHLY_QUOTA });
    expect((await service.evaluate(purchase.id, at(SECOND))).blockingCodes).toEqual([
      'PACKAGE_TYPE_NOT_COVERED',
    ]);
  });

  it('an unknown purchase is 404, not an answer', async () => {
    await expect(service.evaluate('does-not-exist')).rejects.toMatchObject({ status: 404 });
  });

  it('concurrent and repeated evaluations at one instant are identical', async () => {
    const { provider, purchase } = await paidPurchase();
    await ledger(provider.id, CreditTransactionType.OFFER_SPEND, -1, at(60 * SECOND));
    const now = at(PACKAGE_REFUND_WINDOW_MS + SECOND);

    const results = await Promise.all(Array.from({ length: 8 }, () => service.evaluate(purchase.id, now)));
    const again = await service.evaluate(purchase.id, now);
    for (const result of [...results, again]) {
      expect(result).toEqual(results[0]);
    }
  });

  it('evaluating writes nothing: no ledger row, no status change, no refund flag', async () => {
    const { provider, purchase } = await paidPurchase();
    await ledger(provider.id, CreditTransactionType.PACKAGE_PURCHASE, 10, PAID_AT);
    const before = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } });
    const ledgerBefore = await ctx.prisma.providerCreditTransaction.count();

    await service.evaluate(purchase.id, at(SECOND));

    expect(await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } })).toEqual(before);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(ledgerBefore);
    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(0);
  });
});
