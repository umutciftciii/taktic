import {
  CampaignStatus,
  type CampaignEligibilityFact,
  type CampaignTrigger,
  type Prisma,
  type PrismaClient,
  UserRole,
} from '@prisma/client';
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
