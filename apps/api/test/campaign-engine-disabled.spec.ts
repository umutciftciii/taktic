import { CampaignStatus, OfferPackageType, PackagePurchaseStatus, ProviderStatus, UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampaignEngineService } from '../src/modules/campaigns/engine/campaign-engine.service';
import { createCampaignFixture, engineWriteSnapshot, setEngineEnabled } from './campaign-fixtures';
import {
  createOfferPackage,
  createProviderProfile,
  createTestApp,
  createUser,
  grantCredits,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The kill switch is a true no-op on storage (S2A design note D1).
 *
 * With `campaignEngineEnabled` false — or the settings row absent — every
 * entry point returns CAMPAIGN_ENGINE_DISABLED before touching a table, even
 * when an ACTIVE campaign with a matching trigger, a fully eligible provider
 * and a settled purchase are all sitting there waiting. Nothing is written:
 * not the event, not a log line, not a counter, and the ledger is exactly as
 * the fixture left it.
 */

let ctx: TestContext;
let engine: CampaignEngineService;

beforeAll(async () => {
  ctx = await createTestApp();
  engine = ctx.app.get(CampaignEngineService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

async function eligibleProvider() {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  await ctx.prisma.user.update({ where: { id: owner.id }, data: { emailVerifiedAt: new Date(), phoneVerifiedAt: new Date() } });
  const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status: ProviderStatus.APPROVED });
  await ctx.prisma.providerProfile.update({ where: { id: provider.id }, data: { approvedAt: new Date() } });
  return { owner, provider };
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

/** Every trigger has an ACTIVE campaign, so "no candidate" cannot be the reason nothing happens. */
async function activeCampaignsForEveryTrigger() {
  await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED', status: CampaignStatus.ACTIVE });
  await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', status: CampaignStatus.ACTIVE });
  await createCampaignFixture(ctx.prisma, {
    trigger: 'PROVIDER_ELIGIBILITY_REACHED',
    facts: ['PROVIDER_APPROVED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED'],
    status: CampaignStatus.ACTIVE,
  });
}

describe.each([
  ['settings row absent', async () => {}],
  ['settings row present with the switch off', async () => setEngineEnabled(ctx.prisma, false)],
])('with the engine off (%s)', (_label, arrange) => {
  it('evaluate() returns CAMPAIGN_ENGINE_DISABLED for all three triggers and writes nothing', async () => {
    await arrange();
    await activeCampaignsForEveryTrigger();
    const { provider } = await eligibleProvider();
    await grantCredits(ctx.prisma, provider.id, 3);
    const purchase = await paidPurchase(provider.id);
    const before = await engineWriteSnapshot(ctx.prisma);

    const results = await ctx.prisma.$transaction(async (tx) => [
      await engine.evaluate(tx, { trigger: 'PROVIDER_APPROVED', providerId: provider.id, approvalTransition: true }),
      await engine.evaluate(tx, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: provider.id, purchaseId: purchase.id }),
      await engine.evaluate(tx, {
        trigger: 'PROVIDER_ELIGIBILITY_REACHED',
        providerId: provider.id,
        facts: ['PROVIDER_APPROVED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED'],
      }),
    ]);

    expect(results.map((result) => result.outcome)).toEqual([
      'CAMPAIGN_ENGINE_DISABLED',
      'CAMPAIGN_ENGINE_DISABLED',
      'CAMPAIGN_ENGINE_DISABLED',
    ]);
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(before);
    expect(before.triggerEvents).toBe(0);
    expect(before.ledgerRows).toBe(1);
  });

  it('onProviderFact() returns CAMPAIGN_ENGINE_DISABLED for every fact and writes nothing', async () => {
    await arrange();
    await activeCampaignsForEveryTrigger();
    const { provider } = await eligibleProvider();
    const before = await engineWriteSnapshot(ctx.prisma);

    const results = await ctx.prisma.$transaction(async (tx) => [
      await engine.onProviderFact(tx, provider.id, 'PROVIDER_APPROVED'),
      await engine.onProviderFact(tx, provider.id, 'EMAIL_VERIFIED'),
      await engine.onProviderFact(tx, provider.id, 'PHONE_VERIFIED'),
    ]);

    expect(results.map((result) => result.outcome)).toEqual([
      'CAMPAIGN_ENGINE_DISABLED',
      'CAMPAIGN_ENGINE_DISABLED',
      'CAMPAIGN_ENGINE_DISABLED',
    ]);
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(before);
  });

  it('does not read anything it does not need: no campaign, provider or purchase lookup precedes the switch', async () => {
    await arrange();
    // No campaign, no provider, a purchase id that does not exist. A disabled
    // engine must not even notice.
    const result = await ctx.prisma.$transaction((tx) =>
      engine.evaluate(tx, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: 'missing', purchaseId: 'missing' }),
    );
    expect(result).toEqual({ outcome: 'CAMPAIGN_ENGINE_DISABLED' });
  });
});

describe('the switch is read inside the caller transaction', () => {
  it('a switch flipped on after the transaction started is not seen by it', async () => {
    await setEngineEnabled(ctx.prisma, false);
    await activeCampaignsForEveryTrigger();
    const { provider } = await eligibleProvider();
    const before = await engineWriteSnapshot(ctx.prisma);

    const result = await ctx.prisma.$transaction(
      async (tx) => {
        await tx.operationsSettings.findUnique({ where: { id: 'singleton' } });
        await setEngineEnabled(ctx.prisma, true); // outside the transaction
        return engine.evaluate(tx, { trigger: 'PROVIDER_APPROVED', providerId: provider.id, approvalTransition: true });
      },
      { isolationLevel: 'Serializable' },
    );

    expect(result.outcome).toBe('CAMPAIGN_ENGINE_DISABLED');
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(before);
  });
});
