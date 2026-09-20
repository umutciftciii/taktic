import { CreditTransactionType, Prisma, ProviderStatus, UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCampaignFixture } from './campaign-fixtures';
import {
  createProviderProfile,
  createTestApp,
  createUser,
  grantCredits,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * CMP-002 S2B1, Migration C: what the database refuses on its own.
 *
 * Every case writes straight through Prisma, bypassing the accounting code,
 * so that what is proven is the constraint and not the code that happens to
 * respect it today (design note §4).
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

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function expectCheckViolation(promise: Promise<unknown>, constraint: string) {
  await expect(promise).rejects.toMatchObject({ message: expect.stringContaining(constraint) });
}

/** A lot written by hand (as S2A specs do), plus an OFFER_SPEND debit to hang a consumption on. */
async function fixture() {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status: ProviderStatus.APPROVED });
  const { campaign, version } = await createCampaignFixture(ctx.prisma);
  const event = await ctx.prisma.campaignTriggerEvent.create({
    data: { triggerEventKey: `PROVIDER_APPROVED:${provider.id}`, trigger: 'PROVIDER_APPROVED', providerId: provider.id },
  });
  const redemption = await ctx.prisma.campaignRedemption.create({
    data: {
      campaignId: campaign.id,
      campaignVersionId: version.id,
      providerId: provider.id,
      trigger: 'PROVIDER_APPROVED',
      triggerEventId: event.id,
      triggerEventKey: event.triggerEventKey,
      rulesSnapshot: {},
      grantedCredits: 10,
    },
  });
  const lot = await ctx.prisma.promoCreditLot.create({
    data: {
      providerId: provider.id,
      redemptionId: redemption.id,
      grantedCredits: 10,
      remainingCredits: 10,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const grant = await grantCredits(ctx.prisma, provider.id, 10);
  const debit = await ctx.prisma.providerCreditTransaction.create({
    data: {
      providerId: provider.id,
      type: CreditTransactionType.OFFER_SPEND,
      amount: -3,
      balanceAfter: grant.balanceAfter - 3,
      referenceType: 'Offer',
      referenceId: 'offer-x',
    },
  });
  return { provider, lot, debit };
}

function consumption(lotId: string, creditTransactionId: string, data: Partial<Prisma.PromoCreditLotConsumptionUncheckedCreateInput> = {}) {
  return ctx.prisma.promoCreditLotConsumption.create({
    data: { lotId, creditTransactionId, consumedCredits: 3, ...data },
  });
}

describe('PromoCreditLotConsumption', () => {
  it('records one share per lot and debit, and refuses a second row for the same pair', async () => {
    const { lot, debit } = await fixture();
    const row = await consumption(lot.id, debit.id);
    expect(row).toMatchObject({ status: 'CONSUMED', refundedCredits: 0, forfeitedCredits: 0, settledAt: null });
    await expect(consumption(lot.id, debit.id)).rejects.toSatisfy(isUniqueViolation);
  });

  it('refuses a zero share and a settlement larger than the share', async () => {
    const { lot, debit } = await fixture();
    await expectCheckViolation(consumption(lot.id, debit.id, { consumedCredits: 0 }), 'PromoCreditLotConsumption_credits_bounded');
    const row = await consumption(lot.id, debit.id);
    await expectCheckViolation(
      ctx.prisma.promoCreditLotConsumption.update({ where: { id: row.id }, data: { refundedCredits: 4 } }),
      'PromoCreditLotConsumption_credits_bounded',
    );
  });

  it('keeps a CONSUMED row unsettled and an unsettled row CONSUMED', async () => {
    const { lot, debit } = await fixture();
    const row = await consumption(lot.id, debit.id);
    await expectCheckViolation(
      ctx.prisma.promoCreditLotConsumption.update({ where: { id: row.id }, data: { settledAt: new Date() } }),
      'PromoCreditLotConsumption_settlement_complete',
    );
    await expectCheckViolation(
      ctx.prisma.promoCreditLotConsumption.update({ where: { id: row.id }, data: { status: 'REFUNDED' } }),
      'PromoCreditLotConsumption_settlement_complete',
    );
    await expectCheckViolation(
      ctx.prisma.promoCreditLotConsumption.update({ where: { id: row.id }, data: { refundedCredits: 1 } }),
      'PromoCreditLotConsumption_consumed_untouched',
    );
  });

  it('requires REFUNDED and FORFEITED to account for the whole share, and a forfeit to name its ledger row', async () => {
    const { provider, lot, debit } = await fixture();
    const refund = await ctx.prisma.providerCreditTransaction.create({
      data: { providerId: provider.id, type: CreditTransactionType.OFFER_REFUND, amount: 3, balanceAfter: 10, referenceType: 'Offer', referenceId: 'offer-x' },
    });
    const row = await consumption(lot.id, debit.id);
    const settled = { refundTransactionId: refund.id, settledAt: new Date() };
    await expectCheckViolation(
      ctx.prisma.promoCreditLotConsumption.update({ where: { id: row.id }, data: { ...settled, status: 'REFUNDED', refundedCredits: 2 } }),
      'PromoCreditLotConsumption_refunded_whole',
    );
    await expectCheckViolation(
      ctx.prisma.promoCreditLotConsumption.update({ where: { id: row.id }, data: { ...settled, status: 'FORFEITED', forfeitedCredits: 3 } }),
      'PromoCreditLotConsumption_forfeit_row_matches_status',
    );
    const forfeit = await ctx.prisma.providerCreditTransaction.create({
      data: { providerId: provider.id, type: CreditTransactionType.CAMPAIGN_EXPIRE, amount: -3, balanceAfter: 7, referenceType: 'PromoCreditLotConsumption', referenceId: row.id },
    });
    await expectCheckViolation(
      ctx.prisma.promoCreditLotConsumption.update({ where: { id: row.id }, data: { ...settled, status: 'FORFEITED', forfeitedCredits: 2, refundedCredits: 1, forfeitTransactionId: forfeit.id } }),
      'PromoCreditLotConsumption_forfeited_whole',
    );
    const ok = await ctx.prisma.promoCreditLotConsumption.update({
      where: { id: row.id },
      data: { ...settled, status: 'FORFEITED', forfeitedCredits: 3, forfeitTransactionId: forfeit.id },
    });
    expect(ok.status).toBe('FORFEITED');
  });

  it('cannot lose the lot or the ledger rows it refers to', async () => {
    const { lot, debit } = await fixture();
    await consumption(lot.id, debit.id);
    await expect(ctx.prisma.providerCreditTransaction.delete({ where: { id: debit.id } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(ctx.prisma.promoCreditLot.delete({ where: { id: lot.id } })).rejects.toMatchObject({ code: 'P2003' });
  });
});

describe('the credit ledger enum', () => {
  it('appends CAMPAIGN_GRANT, CAMPAIGN_EXPIRE and CAMPAIGN_REVOKE after the six original values', async () => {
    const rows = await ctx.prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'CreditTransactionType' ORDER BY e.enumsortorder`;
    expect(rows.map((row) => row.enumlabel)).toEqual([
      'ADMIN_GRANT', 'ADMIN_DEDUCT', 'PACKAGE_PURCHASE', 'OFFER_SPEND', 'OFFER_REFUND', 'ADJUSTMENT',
      'CAMPAIGN_GRANT', 'CAMPAIGN_EXPIRE', 'CAMPAIGN_REVOKE',
    ]);
    expect(Object.values(CreditTransactionType)).toHaveLength(9);
  });
});
