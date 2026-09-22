import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { prisma } from './fixtures';

/**
 * Campaign rows for the admin and provider campaign specs (CMP-003 S3, CMP-004 S4).
 *
 * The engine itself is never driven here: an ACTIVE campaign and a granted
 * lot are written the way the engine writes them (CAMPAIGN_GRANT row, lot,
 * GRANTED redemption, SETTLED event), so a screen can be exercised without
 * turning the engine on in the shared database.
 */

const OPERATIONS_SETTINGS_ID = 'singleton';
let lotSequence = 0;

export async function setEngine(enabled: boolean) {
  await prisma().operationsSettings.upsert({
    where: { id: OPERATIONS_SETTINGS_ID },
    create: { id: OPERATIONS_SETTINGS_ID, unviewedOfferRefundWindowHours: 48, campaignEngineEnabled: enabled },
    update: { campaignEngineEnabled: enabled },
  });
}

export const DEFINITION = {
  schemaVersion: 1,
  trigger: 'PROVIDER_APPROVED',
  conditions: { all: [] },
  benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 30 },
  limits: { maxRedemptionsPerProvider: 5, maxRedemptionsGlobal: null, maxRedemptionsPerDay: null, budgetCredits: null, maxRevokesPerDay: 1 },
  window: { startAt: null, endAt: null },
  stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
  priority: 100,
};

/** An ACTIVE campaign whose running version tolerates one revoke a day. */
export async function seedActiveCampaign(adminUserId: string, key: string) {
  const campaign = await prisma().campaign.create({ data: { key, name: `E2E operasyon ${key}`, status: 'DRAFT', createdById: adminUserId } });
  const version = await prisma().campaignVersion.create({
    data: {
      campaignId: campaign.id,
      versionNumber: 1,
      trigger: 'PROVIDER_APPROVED',
      eligibilityFacts: [],
      factSetKey: null,
      definition: DEFINITION,
      benefitType: 'PROMO_CREDITS',
      benefitCredits: 10,
      benefitExpiresInDays: 30,
      maxRedemptionsPerProvider: 5,
      maxRedemptionsGlobal: null,
      maxRedemptionsPerDay: null,
      budgetCredits: null,
      maxRevokesPerDay: 1,
      windowStartAt: null,
      windowEndAt: null,
      stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
      priority: 100,
      createdById: adminUserId,
    },
  });
  await prisma().campaign.update({ where: { id: campaign.id }, data: { currentVersionId: version.id, activeVersionId: version.id, status: 'ACTIVE' } });
  await prisma().campaignAuditLog.createMany({
    data: [
      { campaignId: campaign.id, action: 'CREATED', actorId: adminUserId },
      { campaignId: campaign.id, action: 'VERSION_CREATED', campaignVersionId: version.id, actorId: adminUserId, summary: { versionNumber: 1 } },
      { campaignId: campaign.id, action: 'VERSION_ACTIVATED', campaignVersionId: version.id, actorId: adminUserId, summary: { versionNumber: 1 } },
      { campaignId: campaign.id, action: 'ACTIVATED', campaignVersionId: version.id, actorId: adminUserId, summary: { versionNumber: 1 } },
    ],
  });
  return { campaign, version };
}

/** A granted lot, written the way the engine's grant writes it: event → redemption → CAMPAIGN_GRANT row → lot → link. */
export async function seedGrantedLot(
  campaign: { campaign: { id: string }; version: { id: string } },
  providerId: string,
  credits: number,
  spent = 0,
  options: { expiresAt?: Date } = {},
) {
  // One event per seeded lot: the key is unique, and a provider may be
  // seeded with several lots (the provider promo spec does).
  lotSequence += 1;
  const event = await prisma().campaignTriggerEvent.create({
    data: { triggerEventKey: `PROVIDER_APPROVED:${providerId}:${lotSequence}`, trigger: 'PROVIDER_APPROVED', providerId },
  });
  const redemption = await prisma().campaignRedemption.create({
    data: {
      campaignId: campaign.campaign.id,
      campaignVersionId: campaign.version.id,
      providerId,
      trigger: 'PROVIDER_APPROVED',
      triggerEventId: event.id,
      triggerEventKey: event.triggerEventKey,
      rulesSnapshot: DEFINITION,
      grantedCredits: credits,
    },
  });
  const latest = await prisma().providerCreditTransaction.findFirst({ where: { providerId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const grant = await prisma().providerCreditTransaction.create({
    data: {
      providerId,
      type: 'CAMPAIGN_GRANT',
      amount: credits,
      balanceAfter: (latest?.balanceAfter ?? 0) + credits,
      reason: 'CAMPAIGN_GRANT',
      referenceType: 'CampaignRedemption',
      referenceId: redemption.id,
    },
  });
  const lot = await prisma().promoCreditLot.create({
    data: {
      providerId,
      redemptionId: redemption.id,
      grantedCredits: credits,
      remainingCredits: credits - spent,
      expiresAt: options.expiresAt ?? new Date(Date.now() + 30 * 86_400_000),
    },
  });
  await prisma().campaignRedemption.update({ where: { id: redemption.id }, data: { grantTransactionId: grant.id } });
  // SETTLED and the settlement columns in one statement, as the engine writes them (CHECK settled_status_matches).
  await prisma().campaignTriggerEvent.update({
    where: { id: event.id },
    data: { status: 'SETTLED', settledByCampaignId: campaign.campaign.id, settledRedemptionId: redemption.id, settledAt: new Date() },
  });
  await prisma().campaign.update({ where: { id: campaign.campaign.id }, data: { redemptionCount: { increment: 1 }, budgetConsumedCredits: { increment: credits } } });
  return { event, redemption, lot };
}


/** Fails when anything but a `.table-scroll` descendant extends past the viewport. */
export async function expectNoHorizontalOverflow(page: Page, label: string) {
  const { overflow, culprits } = await page.evaluate(() => {
    const limit = window.innerWidth;
    const culprits = Array.from(document.querySelectorAll('body *'))
      .filter((el) => el.getBoundingClientRect().right > limit + 1)
      .filter((el) => !el.parentElement?.closest('.table-scroll'))
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')} right=${Math.round(el.getBoundingClientRect().right)}`);
    return { overflow: document.documentElement.scrollWidth - limit, culprits };
  });
  expect(overflow, `${label}: the page is ${overflow}px wider than the viewport (${culprits.join(' | ')})`).toBeLessThanOrEqual(0);
}

