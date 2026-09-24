import {
  type CampaignChannel,
  CampaignStatus,
  type CampaignEligibilityFact,
  type CampaignTrigger,
  type Prisma,
  type PrismaClient,
  UserRole,
} from '@prisma/client';
import { grantPromoCreditLot } from '../src/modules/credits/promo-credit-ledger';
import { createUser, uniqueSuffix } from './harness';

/**
 * Campaign rows written straight through Prisma, for the specs whose subject
 * is the engine's data model rather than the admin API.
 *
 * No production code path can produce an ACTIVE campaign in this slice —
 * there is no activation endpoint — so a spec that needs one writes it here,
 * with the same shape the S2B activation endpoint will write: `status = ACTIVE`
 * and `activeVersionId` pointing at a version the validator would accept.
 */

export type CampaignFixtureOptions = {
  trigger?: CampaignTrigger;
  facts?: CampaignEligibilityFact[];
  status?: CampaignStatus;
  credits?: number;
  expiresInDays?: number;
  priority?: number;
  maxRedemptionsPerProvider?: number;
  maxRedemptionsGlobal?: number | null;
  maxRedemptionsPerDay?: number | null;
  budgetCredits?: number | null;
  windowStartAt?: Date | null;
  windowEndAt?: Date | null;
  conditions?: Prisma.InputJsonValue[];
  createdById?: string;
  /** CMP-006 PR-D: omitted = the definition has no channel and the column its default (ALL), like every pre-PR-D version. */
  channel?: CampaignChannel;
};

export async function createCampaignFixture(prisma: PrismaClient, options: CampaignFixtureOptions = {}) {
  const suffix = uniqueSuffix();
  const trigger = options.trigger ?? 'PROVIDER_APPROVED';
  const facts = trigger === 'PROVIDER_ELIGIBILITY_REACHED'
    ? [...(options.facts ?? ['PROVIDER_APPROVED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED'])].sort()
    : [];
  const factSetKey = facts.length > 0 ? facts.join('+') : null;
  const credits = options.credits ?? 10;
  const expiresInDays = options.expiresInDays ?? 30;
  const createdById = options.createdById ?? (await createUser(prisma, { role: UserRole.SUPER_ADMIN })).id;
  const status = options.status ?? CampaignStatus.ACTIVE;

  const definition = {
    schemaVersion: 1,
    trigger,
    ...(factSetKey ? { eligibility: { facts } } : {}),
    conditions: { all: options.conditions ?? [] },
    benefit: { type: 'PROMO_CREDITS', credits, expiresInDays },
    limits: {
      maxRedemptionsPerProvider: options.maxRedemptionsPerProvider ?? 1,
      maxRedemptionsGlobal: options.maxRedemptionsGlobal ?? null,
      maxRedemptionsPerDay: options.maxRedemptionsPerDay ?? null,
      budgetCredits: options.budgetCredits ?? null,
    },
    window: {
      startAt: options.windowStartAt?.toISOString() ?? null,
      endAt: options.windowEndAt?.toISOString() ?? null,
    },
    stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
    priority: options.priority ?? 100,
    ...(options.channel ? { channel: options.channel } : {}),
  };

  const campaign = await prisma.campaign.create({
    data: {
      key: `kampanya-${suffix}`,
      name: `Kampanya ${suffix}`,
      status: CampaignStatus.DRAFT,
      createdById,
    },
  });
  const version = await prisma.campaignVersion.create({
    data: {
      campaignId: campaign.id,
      versionNumber: 1,
      trigger,
      eligibilityFacts: facts,
      factSetKey,
      definition: definition as unknown as Prisma.InputJsonValue,
      benefitType: 'PROMO_CREDITS',
      benefitCredits: credits,
      benefitExpiresInDays: expiresInDays,
      maxRedemptionsPerProvider: definition.limits.maxRedemptionsPerProvider,
      maxRedemptionsGlobal: definition.limits.maxRedemptionsGlobal,
      maxRedemptionsPerDay: definition.limits.maxRedemptionsPerDay,
      budgetCredits: definition.limits.budgetCredits,
      windowStartAt: options.windowStartAt ?? null,
      windowEndAt: options.windowEndAt ?? null,
      stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
      priority: definition.priority,
      ...(options.channel ? { channel: options.channel } : {}),
      createdById,
    },
  });
  const updated = await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      currentVersionId: version.id,
      status,
      activeVersionId: status === CampaignStatus.DRAFT ? null : version.id,
    },
  });
  return { campaign: updated, version };
}

/** Row counts of every table the engine may write, plus the campaign-level counters. */
export async function engineWriteSnapshot(prisma: PrismaClient) {
  const campaigns = await prisma.campaign.findMany({
    select: { id: true, redemptionCount: true, budgetConsumedCredits: true },
    orderBy: { id: 'asc' },
  });
  return {
    triggerEvents: await prisma.campaignTriggerEvent.count(),
    redemptions: await prisma.campaignRedemption.count(),
    evaluationLogs: await prisma.campaignEvaluationLog.count(),
    lots: await prisma.promoCreditLot.count(),
    consumptions: await prisma.promoCreditLotConsumption.count(),
    providerCounters: await prisma.campaignProviderCounter.count(),
    dailyCounters: await prisma.campaignDailyCounter.count(),
    ledgerRows: await prisma.providerCreditTransaction.count(),
    campaignCounters: campaigns,
  };
}

export async function setEngineEnabled(prisma: PrismaClient, enabled: boolean) {
  await prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48, campaignEngineEnabled: enabled },
    update: { campaignEngineEnabled: enabled },
  });
}

export type PromoLotFixtureOptions = {
  credits?: number;
  /** Absolute expiry; defaults to 30 days from now. */
  expiresAt?: Date;
  /** Reuse a campaign (and thereby test a second redemption of the same campaign by another event). */
  campaign?: { campaign: { id: string }; version: { id: string } };
  createdById?: string;
};

/**
 * A granted promo lot for a provider, written the way S2B2's engine will
 * write it: an ACTIVE campaign, a trigger event, a GRANTED redemption, and
 * then the S2B1 grant primitive (CAMPAIGN_GRANT row + lot + link) inside one
 * Serializable transaction. No production path can produce this in S2B1;
 * every accounting spec starts from here.
 */
export async function createPromoLotFixture(prisma: PrismaClient, providerId: string, options: PromoLotFixtureOptions = {}) {
  const credits = options.credits ?? 10;
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 30 * 86_400_000);
  const { campaign, version } =
    options.campaign ?? (await createCampaignFixture(prisma, { credits, createdById: options.createdById }));
  const suffix = uniqueSuffix();
  const event = await prisma.campaignTriggerEvent.create({
    data: {
      triggerEventKey: `PROVIDER_APPROVED:${providerId}:${suffix}`,
      trigger: 'PROVIDER_APPROVED',
      providerId,
    },
  });
  const redemption = await prisma.campaignRedemption.create({
    data: {
      campaignId: campaign.id,
      campaignVersionId: version.id,
      providerId,
      trigger: 'PROVIDER_APPROVED',
      triggerEventId: event.id,
      triggerEventKey: event.triggerEventKey,
      rulesSnapshot: {},
      grantedCredits: credits,
    },
  });
  const granted = await prisma.$transaction(
    (tx) => grantPromoCreditLot(tx, { providerId, redemptionId: redemption.id, credits, expiresAt, now: new Date() }),
    { isolationLevel: 'Serializable' },
  );
  const lot = await prisma.promoCreditLot.findUniqueOrThrow({ where: { id: granted.lotId } });
  return { campaign, version, event, redemption, lot, grantTransactionId: granted.transactionId };
}

/**
 * The wallet invariant of the S2B1 design note §5, checked from the rows
 * alone: the ledger sums to the newest balance, and that balance equals the
 * paid share plus every lot remainder still inside the wallet.
 */
export async function walletInvariant(prisma: PrismaClient, providerId: string) {
  const rows = await prisma.providerCreditTransaction.findMany({
    where: { providerId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { type: true, amount: true, balanceAfter: true },
  });
  const balance = rows.at(-1)?.balanceAfter ?? 0;
  const sumOfAmounts = rows.reduce((total, row) => total + row.amount, 0);
  const lots = await prisma.promoCreditLot.findMany({
    where: { providerId, status: { in: ['ACTIVE', 'EXHAUSTED'] } },
    select: { remainingCredits: true },
  });
  const promoInWallet = lots.reduce((total, lot) => total + lot.remainingCredits, 0);
  return { balance, sumOfAmounts, promoInWallet, paid: balance - promoInWallet, rows };
}
