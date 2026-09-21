import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCategory, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * CMP-003 S3 — the campaign operations desk, driven end to end.
 *
 * An ACTIVE campaign with a daily revoke threshold of 1 has granted two
 * promotional lots (seeded the way the engine writes them: CAMPAIGN_GRANT
 * row, lot, GRANTED redemption) and has one evaluation event parked in
 * RETRY_WAIT. The operator opens the detail, sees both redemptions by the
 * providers' business names and nothing else about them, revokes the first
 * with a reason (ledger row, lot REVOKED, audit), revokes the second and
 * watches the campaign pause itself (AUTO_PAUSED in the audit), puts the
 * parked event back in the queue, and is refused a second revoke of an
 * already-revoked row. A provider's session cannot open the screen. The
 * detail fits at 320, 768, 1024 and 1440 with both tables present.
 */

const WIDTHS = [320, 768, 1024, 1440] as const;
const SCREENSHOT_DIR = resolve(artifactsDir, 'admin-campaign-operations');
const OPERATIONS_SETTINGS_ID = 'singleton';

async function setEngine(enabled: boolean) {
  await prisma().operationsSettings.upsert({
    where: { id: OPERATIONS_SETTINGS_ID },
    create: { id: OPERATIONS_SETTINGS_ID, unviewedOfferRefundWindowHours: 48, campaignEngineEnabled: enabled },
    update: { campaignEngineEnabled: enabled },
  });
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
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

const DEFINITION = {
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
async function seedActiveCampaign(adminUserId: string, key: string) {
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
async function seedGrantedLot(campaign: { campaign: { id: string }; version: { id: string } }, providerId: string, credits: number, spent = 0) {
  const event = await prisma().campaignTriggerEvent.create({
    data: { triggerEventKey: `PROVIDER_APPROVED:${providerId}`, trigger: 'PROVIDER_APPROVED', providerId },
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
    data: { providerId, redemptionId: redemption.id, grantedCredits: credits, remainingCredits: credits - spent, expiresAt: new Date(Date.now() + 30 * 86_400_000) },
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

test.describe('admin campaign operations desk', () => {
  test('revokes with a reason, pauses itself past the threshold, re-queues a parked event, and fits every width', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const key = `e2e-operasyon-${Date.now().toString(36)}`;
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Kampanya Operasyon' });
    const first = await createProvider({ categoryId: category.id, location, credits: 5 });
    const second = await createProvider({ categoryId: category.id, location, credits: 0 });
    const parkedProvider = await createProvider({ categoryId: category.id, location, credits: 0 });
    const seeded = await seedActiveCampaign(adminAccount.id, key);
    const firstLot = await seedGrantedLot(seeded, first.id, 10);
    const secondLot = await seedGrantedLot(seeded, second.id, 10, 4);
    const parked = await prisma().campaignTriggerEvent.create({
      data: {
        triggerEventKey: `PROVIDER_APPROVED:${parkedProvider.id}`,
        trigger: 'PROVIDER_APPROVED',
        providerId: parkedProvider.id,
        status: 'RETRY_WAIT',
        attemptCount: 2,
        lastErrorCode: 'ENGINE_ERROR',
        lastErrorAt: new Date(),
        nextAttemptAt: new Date(Date.now() + 6 * 3_600_000),
      },
    });
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const page = admin.page;

    try {
      await setEngine(true);
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/campaigns/${seeded.campaign.id}`);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('campaign-status')).toHaveAttribute('data-status', 'ACTIVE');

      // ---- what the desk shows, and what it must not ----
      const redemptions = page.getByTestId('campaign-redemptions');
      await expect(redemptions.getByTestId('campaign-redemption-row')).toHaveCount(2);
      await expect(redemptions).toContainText(first.businessName);
      await expect(redemptions).toContainText(second.businessName);
      await expect(page.getByTestId('campaign-current-definition').first()).toContainText('günlük geri alma eşiği 1');
      const events = page.getByTestId('campaign-events');
      await expect(events.locator(`[data-testid="campaign-event-row"][data-event="${parked.id}"]`)).toHaveAttribute('data-retryable', 'true');
      await expect(events).toContainText('ENGINE_ERROR');
      const html = await page.content();
      for (const forbidden of [first.email, first.phone, second.email, second.phone, parkedProvider.email]) {
        expect(html, `the screen must not carry ${forbidden}`).not.toContain(forbidden);
      }

      // ---- revoke the first: reason required, then ledger + lot + audit ----
      const firstRow = page.locator(`[data-testid="campaign-redemption-row"][data-redemption="${firstLot.redemption.id}"]`);
      await firstRow.getByTestId('campaign-revoke').click();
      // HTML `required` stops an empty reason before any request is made.
      await expect(page).not.toHaveURL(/ok=revoke/);
      expect((await prisma().campaignRedemption.findUniqueOrThrow({ where: { id: firstLot.redemption.id } })).status).toBe('GRANTED');
      await firstRow.getByTestId('campaign-revoke-reason').fill('E2E: sahte ödeme şüphesi');
      await firstRow.getByTestId('campaign-revoke').click();
      await expect(page).toHaveURL(/ok=revoke/);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('campaign-ok')).toContainText('geri alındı');
      await expect(firstRow).toHaveAttribute('data-status', 'REVOKED');
      await expect(firstRow).toContainText('Yönetici kararı');
      await expect(firstRow).toContainText('E2E: sahte ödeme şüphesi');
      await expect(firstRow.getByTestId('campaign-revoke')).toHaveCount(0);
      await expect(page.getByTestId('campaign-status')).toHaveAttribute('data-status', 'ACTIVE');
      await expect(page.getByTestId('campaign-audit')).toContainText('Hak ediş geri alındı');
      await expect(page.getByTestId('campaign-audit')).toContainText('gerekçe: E2E: sahte ödeme şüphesi');
      const firstLotAfter = await prisma().promoCreditLot.findUniqueOrThrow({ where: { id: firstLot.lot.id } });
      expect(firstLotAfter).toMatchObject({ status: 'REVOKED', remainingCredits: 0 });
      const firstLedger = await prisma().providerCreditTransaction.findMany({ where: { providerId: first.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      expect(firstLedger.map((row) => [row.type, row.amount, row.balanceAfter])).toEqual([
        ['ADMIN_GRANT', 5, 5],
        ['CAMPAIGN_GRANT', 10, 15],
        ['CAMPAIGN_REVOKE', -10, 5],
      ]);
      expect(await prisma().campaignRedemption.findUniqueOrThrow({ where: { id: firstLot.redemption.id } })).toMatchObject({
        status: 'REVOKED',
        revokeReason: 'ADMIN_REVOKED',
        revokedById: adminAccount.id,
        revokeNote: 'E2E: sahte ödeme şüphesi',
        spentAtRevoke: 0,
      });

      // ---- revoke the second (partly spent): only the remainder, and the campaign pauses itself ----
      const secondRow = page.locator(`[data-testid="campaign-redemption-row"][data-redemption="${secondLot.redemption.id}"]`);
      await secondRow.getByTestId('campaign-revoke-reason').fill('E2E: ikinci geri alma');
      await secondRow.getByTestId('campaign-revoke').click();
      await expect(page).toHaveURL(/ok=revoke/);
      await assertNoErrorScreen(page);
      await expect(secondRow).toHaveAttribute('data-status', 'REVOKED');
      await expect(secondRow).toContainText('düşülen 6 · harcanan 4');
      await expect(page.getByTestId('campaign-status')).toHaveAttribute('data-status', 'PAUSED');
      await expect(page.getByTestId('campaign-lifecycle-panel')).toHaveAttribute('data-status', 'PAUSED');
      await expect(page.getByTestId('campaign-audit')).toContainText('Kampanya kendini duraklattı');
      await expect(page.getByTestId('campaign-audit')).toContainText('bugün 2 geri alma, eşik 1');
      const secondLedger = await prisma().providerCreditTransaction.findMany({ where: { providerId: second.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      expect(secondLedger.map((row) => [row.type, row.amount, row.balanceAfter])).toEqual([
        ['CAMPAIGN_GRANT', 10, 10],
        ['CAMPAIGN_REVOKE', -6, 4],
      ]);
      expect(await prisma().campaignRedemption.findUniqueOrThrow({ where: { id: secondLot.redemption.id } })).toMatchObject({ status: 'REVOKED', spentAtRevoke: 4 });
      const counters = await prisma().campaignRevokeDailyCounter.findMany({ where: { campaignId: seeded.campaign.id } });
      expect(counters.map((row) => row.revokeCount)).toEqual([2]);
      expect(await prisma().campaignAuditLog.count({ where: { campaignId: seeded.campaign.id, action: 'AUTO_PAUSED' } })).toBe(1);

      // ---- a revoked row offers no second revoke; exactly two CAMPAIGN_REVOKE rows exist ----
      await expect(page.getByTestId('campaign-revoke-form')).toHaveCount(0);
      expect(await prisma().providerCreditTransaction.count({ where: { type: 'CAMPAIGN_REVOKE' } })).toBe(2);

      // ---- re-queue the parked event: nothing evaluated here, the audit says who asked ----
      const eventRow = page.locator(`[data-testid="campaign-event-row"][data-event="${parked.id}"]`);
      await eventRow.getByTestId('campaign-retry').click();
      await expect(page).toHaveURL(/ok=retry/);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('campaign-ok')).toContainText('kuyruğa alındı');
      const requeued = await prisma().campaignTriggerEvent.findUniqueOrThrow({ where: { id: parked.id } });
      expect(requeued.status).toBe('RETRY_WAIT');
      expect(requeued.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(requeued.attemptCount).toBe(2);
      expect(await prisma().campaignRedemption.count({ where: { providerId: parkedProvider.id } })).toBe(0);
      await expect(page.getByTestId('campaign-audit')).toContainText('Olay kuyruğa alındı');
      // The event still shows its parked state (the worker has not run: its cron is pinned to once a year).
      await expect(eventRow).toHaveAttribute('data-status', 'RETRY_WAIT');

      // ---- engine off: the retry control is gone, the revoke control is not ----
      await setEngine(false);
      await admin.gotoAdmin(`/campaigns/${seeded.campaign.id}`);
      await assertNoErrorScreen(page);
      await expect(eventRow.getByTestId('campaign-retry')).toHaveCount(0);
      await expect(eventRow).toContainText('motor kapalı');

      // ---- every width, both tables present ----
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 960 });
        await admin.gotoAdmin(`/campaigns/${seeded.campaign.id}`);
        await assertNoErrorScreen(page);
        await expect(page.getByTestId('campaign-redemption-row')).toHaveCount(2);
        await expect(page.getByTestId('campaign-event-row').first()).toBeVisible();
        await expectNoHorizontalOverflow(page, `detail @${width}`);
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, `detail-${width}.png`), fullPage: false });
      }
    } finally {
      await setEngine(false);
      await admin.close();
    }
  });

  test('a provider session is sent to the login form, not to the desk', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Kampanya Operasyon Erişim' });
    const providerAccount = await createProvider({ categoryId: category.id, location, credits: 3 });
    const seeded = await seedActiveCampaign(adminAccount.id, `e2e-operasyon-erisim-${Date.now().toString(36)}`);
    await seedGrantedLot(seeded, providerAccount.id, 10);
    const intruder = await Actor.open(browser, 'intruder', primaryRuntime);

    try {
      await intruder.loginToWeb(providerAccount.email, providerAccount.password);
      await intruder.gotoAdmin(`/campaigns/${seeded.campaign.id}`);
      await expect(intruder.page).toHaveURL(/\/login/);
      await expect(intruder.page.getByTestId('campaign-redemptions')).toHaveCount(0);
      await assertNoErrorScreen(intruder.page);
      expect(await prisma().providerCreditTransaction.count({ where: { type: 'CAMPAIGN_REVOKE' } })).toBe(0);
    } finally {
      await intruder.close();
    }
  });
});
