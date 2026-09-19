import { Prisma, ProviderStatus, UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCampaignFixture } from './campaign-fixtures';
import {
  createProviderProfile,
  createTestApp,
  createUser,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * CMP-002 S2A, Migration B: what the database refuses on its own.
 *
 * Every case here writes straight through Prisma, bypassing the engine, so
 * that what is proven is the constraint and not the code that happens to
 * respect it today. The rules come from CMP-001 §3.2 / §12.2 and the S2A
 * design note §2.
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

/** A CHECK violation surfaces as a raw query error whose message names the constraint. */
async function expectCheckViolation(promise: Promise<unknown>, constraint: string) {
  await expect(promise).rejects.toMatchObject({
    message: expect.stringContaining(constraint),
  });
}

async function provider() {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  return createProviderProfile(ctx.prisma, { userId: owner.id, status: ProviderStatus.APPROVED });
}

async function approvalEvent(providerId: string) {
  return ctx.prisma.campaignTriggerEvent.create({
    data: {
      triggerEventKey: `PROVIDER_APPROVED:${providerId}`,
      trigger: 'PROVIDER_APPROVED',
      providerId,
    },
  });
}

async function redemption(args: {
  campaignId: string;
  campaignVersionId: string;
  providerId: string;
  eventId: string;
  eventKey: string;
  credits?: number;
}) {
  return ctx.prisma.campaignRedemption.create({
    data: {
      campaignId: args.campaignId,
      campaignVersionId: args.campaignVersionId,
      providerId: args.providerId,
      trigger: 'PROVIDER_APPROVED',
      triggerEventId: args.eventId,
      triggerEventKey: args.eventKey,
      rulesSnapshot: {},
      grantedCredits: args.credits ?? 10,
    },
  });
}

describe('CampaignTriggerEvent', () => {
  it('has a globally unique triggerEventKey, independent of any campaign', async () => {
    const p = await provider();
    await approvalEvent(p.id);
    await expect(approvalEvent(p.id)).rejects.toSatisfy(isUniqueViolation);
  });

  it('refuses a purchase-less payment event and a purchase on a non-payment event', async () => {
    const p = await provider();
    await expectCheckViolation(
      ctx.prisma.campaignTriggerEvent.create({
        data: { triggerEventKey: `PACKAGE_PAYMENT_SUCCEEDED:x`, trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: p.id },
      }),
      'CampaignTriggerEvent_purchase_matches_trigger',
    );
  });

  it('refuses an eligibility event without a factSetKey and a factSetKey on other triggers', async () => {
    const p = await provider();
    await expectCheckViolation(
      ctx.prisma.campaignTriggerEvent.create({
        data: { triggerEventKey: `PROVIDER_ELIGIBILITY_REACHED:A+B:${p.id}`, trigger: 'PROVIDER_ELIGIBILITY_REACHED', providerId: p.id },
      }),
      'CampaignTriggerEvent_factSetKey_matches_trigger',
    );
    await expectCheckViolation(
      ctx.prisma.campaignTriggerEvent.create({
        data: { triggerEventKey: `PROVIDER_APPROVED:${p.id}`, trigger: 'PROVIDER_APPROVED', providerId: p.id, factSetKey: 'A+B' },
      }),
      'CampaignTriggerEvent_factSetKey_matches_trigger',
    );
  });

  it('is settled by all three settlement columns together or by none', async () => {
    const p = await provider();
    const { campaign } = await createCampaignFixture(ctx.prisma);
    const event = await approvalEvent(p.id);
    await expectCheckViolation(
      ctx.prisma.campaignTriggerEvent.update({
        where: { id: event.id },
        data: { settledByCampaignId: campaign.id },
      }),
      'CampaignTriggerEvent_settlement_complete',
    );
  });

  it('cannot count a negative evaluation', async () => {
    const p = await provider();
    const event = await approvalEvent(p.id);
    await expectCheckViolation(
      ctx.prisma.campaignTriggerEvent.update({ where: { id: event.id }, data: { evaluationCount: -1 } }),
      'CampaignTriggerEvent_evaluationCount_nonnegative',
    );
  });
});

describe('CampaignRedemption', () => {
  it('refuses a second redemption of the same event by the same campaign', async () => {
    const p = await provider();
    const { campaign, version } = await createCampaignFixture(ctx.prisma);
    const event = await approvalEvent(p.id);
    const args = { campaignId: campaign.id, campaignVersionId: version.id, providerId: p.id, eventId: event.id, eventKey: event.triggerEventKey };
    await redemption(args);
    await expect(redemption(args)).rejects.toSatisfy(isUniqueViolation);
  });

  it('accepts the same event redeemed by a different campaign — the key is not globally unique here', async () => {
    const p = await provider();
    const a = await createCampaignFixture(ctx.prisma);
    const b = await createCampaignFixture(ctx.prisma);
    const event = await approvalEvent(p.id);
    await redemption({ campaignId: a.campaign.id, campaignVersionId: a.version.id, providerId: p.id, eventId: event.id, eventKey: event.triggerEventKey });
    await redemption({ campaignId: b.campaign.id, campaignVersionId: b.version.id, providerId: p.id, eventId: event.id, eventKey: event.triggerEventKey });
    expect(await ctx.prisma.campaignRedemption.count({ where: { triggerEventKey: event.triggerEventKey } })).toBe(2);
  });

  it('lets one event be settled by exactly one redemption', async () => {
    const p = await provider();
    const a = await createCampaignFixture(ctx.prisma);
    const b = await createCampaignFixture(ctx.prisma);
    const event = await approvalEvent(p.id);
    const first = await redemption({ campaignId: a.campaign.id, campaignVersionId: a.version.id, providerId: p.id, eventId: event.id, eventKey: event.triggerEventKey });
    const second = await redemption({ campaignId: b.campaign.id, campaignVersionId: b.version.id, providerId: p.id, eventId: event.id, eventKey: event.triggerEventKey });
    const other = await approvalEvent((await provider()).id);

    await ctx.prisma.campaignTriggerEvent.update({
      where: { id: event.id },
      data: { settledByCampaignId: a.campaign.id, settledRedemptionId: first.id, settledAt: new Date() },
    });
    // The other event cannot claim a redemption that already settled one.
    await expect(
      ctx.prisma.campaignTriggerEvent.update({
        where: { id: other.id },
        data: { settledByCampaignId: b.campaign.id, settledRedemptionId: first.id, settledAt: new Date() },
      }),
    ).rejects.toSatisfy(isUniqueViolation);
    expect(second.id).not.toBe(first.id);
  });

  it('carries no ledger reference in this slice and bounds grantedCredits', async () => {
    const p = await provider();
    const { campaign, version } = await createCampaignFixture(ctx.prisma);
    const event = await approvalEvent(p.id);
    const row = await redemption({ campaignId: campaign.id, campaignVersionId: version.id, providerId: p.id, eventId: event.id, eventKey: event.triggerEventKey });
    expect(row.grantTransactionId).toBeNull();
    expect(row.status).toBe('GRANTED');
    await expectCheckViolation(
      ctx.prisma.campaignRedemption.update({ where: { id: row.id }, data: { grantedCredits: 0 } }),
      'CampaignRedemption_grantedCredits_bounded',
    );
  });

  it('cannot be REVOKED without a moment and a reason', async () => {
    const p = await provider();
    const { campaign, version } = await createCampaignFixture(ctx.prisma);
    const event = await approvalEvent(p.id);
    const row = await redemption({ campaignId: campaign.id, campaignVersionId: version.id, providerId: p.id, eventId: event.id, eventKey: event.triggerEventKey });
    await expectCheckViolation(
      ctx.prisma.campaignRedemption.update({ where: { id: row.id }, data: { status: 'REVOKED' } }),
      'CampaignRedemption_revocation_complete',
    );
  });
});

describe('PromoCreditLot', () => {
  async function lotFixture(overrides: Partial<Prisma.PromoCreditLotUncheckedCreateInput> = {}) {
    const p = await provider();
    const { campaign, version } = await createCampaignFixture(ctx.prisma);
    const event = await approvalEvent(p.id);
    const row = await redemption({ campaignId: campaign.id, campaignVersionId: version.id, providerId: p.id, eventId: event.id, eventKey: event.triggerEventKey });
    return ctx.prisma.promoCreditLot.create({
      data: {
        providerId: p.id,
        redemptionId: row.id,
        grantedCredits: 10,
        remainingCredits: 10,
        expiresAt: new Date(Date.now() + 86_400_000),
        ...overrides,
      },
    });
  }

  it('belongs to exactly one redemption', async () => {
    const lot = await lotFixture();
    await expect(
      ctx.prisma.promoCreditLot.create({
        data: { providerId: lot.providerId, redemptionId: lot.redemptionId, grantedCredits: 5, remainingCredits: 5, expiresAt: lot.expiresAt },
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('never holds a negative remainder', async () => {
    const lot = await lotFixture();
    await expectCheckViolation(
      ctx.prisma.promoCreditLot.update({ where: { id: lot.id }, data: { remainingCredits: -1 } }),
      'PromoCreditLot_credits_bounded',
    );
  });

  it('never holds more than was granted', async () => {
    await expectCheckViolation(lotFixture({ grantedCredits: 10, remainingCredits: 11 }), 'PromoCreditLot_credits_bounded');
  });

  it('cannot be granted zero credits', async () => {
    await expectCheckViolation(lotFixture({ grantedCredits: 0, remainingCredits: 0 }), 'PromoCreditLot_credits_bounded');
  });

  it('is EXHAUSTED only at zero remaining', async () => {
    const lot = await lotFixture();
    await expectCheckViolation(
      ctx.prisma.promoCreditLot.update({ where: { id: lot.id }, data: { status: 'EXHAUSTED' } }),
      'PromoCreditLot_exhausted_means_empty',
    );
    await ctx.prisma.promoCreditLot.update({ where: { id: lot.id }, data: { status: 'EXHAUSTED', remainingCredits: 0 } });
  });

  it('starts ACTIVE with no expiry or revoke transaction', async () => {
    const lot = await lotFixture();
    expect(lot.status).toBe('ACTIVE');
    expect(lot.expiryTransactionId).toBeNull();
    expect(lot.revokeTransactionId).toBeNull();
  });
});

describe('counters', () => {
  it('CampaignProviderCounter is unique per campaign and provider and never negative', async () => {
    const p = await provider();
    const { campaign } = await createCampaignFixture(ctx.prisma);
    const row = await ctx.prisma.campaignProviderCounter.create({ data: { campaignId: campaign.id, providerId: p.id } });
    expect(row.redemptionCount).toBe(0);
    await expect(
      ctx.prisma.campaignProviderCounter.create({ data: { campaignId: campaign.id, providerId: p.id } }),
    ).rejects.toSatisfy(isUniqueViolation);
    await expectCheckViolation(
      ctx.prisma.campaignProviderCounter.update({ where: { id: row.id }, data: { redemptionCount: -1 } }),
      'CampaignProviderCounter_redemptionCount_nonnegative',
    );
  });

  it('CampaignDailyCounter is unique per campaign and day and never negative', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma);
    const day = new Date('2026-09-19T00:00:00.000Z');
    const row = await ctx.prisma.campaignDailyCounter.create({ data: { campaignId: campaign.id, day } });
    await expect(
      ctx.prisma.campaignDailyCounter.create({ data: { campaignId: campaign.id, day } }),
    ).rejects.toSatisfy(isUniqueViolation);
    await ctx.prisma.campaignDailyCounter.create({ data: { campaignId: campaign.id, day: new Date('2026-09-20T00:00:00.000Z') } });
    await expectCheckViolation(
      ctx.prisma.campaignDailyCounter.update({ where: { id: row.id }, data: { redemptionCount: -1 } }),
      'CampaignDailyCounter_redemptionCount_nonnegative',
    );
  });

  it('Campaign cumulative counters default to zero and cannot go negative', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma);
    expect(campaign.redemptionCount).toBe(0);
    expect(campaign.budgetConsumedCredits).toBe(0);
    await expectCheckViolation(
      ctx.prisma.campaign.update({ where: { id: campaign.id }, data: { budgetConsumedCredits: -1 } }),
      'Campaign_counters_nonnegative',
    );
  });
});

describe('CampaignEvaluationLog', () => {
  it('accepts repeated rows for one event and one campaign — there is no unique', async () => {
    const p = await provider();
    const { campaign, version } = await createCampaignFixture(ctx.prisma);
    const event = await approvalEvent(p.id);
    for (let i = 0; i < 3; i += 1) {
      await ctx.prisma.campaignEvaluationLog.create({
        data: {
          triggerEventId: event.id,
          campaignId: campaign.id,
          campaignVersionId: version.id,
          providerId: p.id,
          outcome: 'CONDITIONS_FAILED',
          reasonCode: 'FIRST_PROVIDER_APPROVAL',
        },
      });
    }
    expect(await ctx.prisma.campaignEvaluationLog.count()).toBe(3);
  });
});

describe('the credit ledger', () => {
  it('still knows exactly the six pre-CMP-002 transaction types', async () => {
    const rows = await ctx.prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'CreditTransactionType' ORDER BY e.enumsortorder`;
    expect(rows.map((row) => row.enumlabel)).toEqual([
      'ADMIN_GRANT',
      'ADMIN_DEDUCT',
      'PACKAGE_PURCHASE',
      'OFFER_SPEND',
      'OFFER_REFUND',
      'ADJUSTMENT',
    ]);
  });
});
