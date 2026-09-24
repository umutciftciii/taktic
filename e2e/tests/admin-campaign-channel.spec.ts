import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, prisma } from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * CMP-006 PR-D — campaign channel targeting on the admin screens.
 *
 * One operator builds a package campaign and picks "Mobil": the builder warns
 * that no mobile source exists, the draft is saved anyway as version 1, and
 * the detail shows the channel in the definition, the version history and the
 * audit trail. With the engine switch on (set on the test database, as the
 * lifecycle spec does), the lifecycle panel says activation is impossible for
 * this channel and disables the button; forcing the form reaches the API,
 * which refuses with CHANNEL_SOURCE_UNAVAILABLE and writes nothing. A
 * revision to "Web" is a new version — version 1 stays MOBILE — and it
 * activates. Nothing is granted anywhere. Finally the builder and the detail
 * fit at 320, 768, 1024 and 1440 without a horizontal scroll. The switch is
 * put back off in `finally`.
 *
 * BUG-OPS-002: a MOBILE draft that cannot be activated can be closed. The
 * panel offers "Taslağı kapat" (not "Sonlandır"), the close lands the draft
 * in ENDED with `activeVersionId` null, the audit trail says the draft was
 * closed without ever running, and nothing of the engine was touched.
 */

const OPERATIONS_SETTINGS_ID = 'singleton';
const WIDTHS = [320, 768, 1024, 1440] as const;
const SCREENSHOT_DIR = resolve(artifactsDir, 'admin-campaign-channel');

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

test.describe('admin campaign channel', () => {
  test('picks a channel, keeps it in the immutable version, and shows why MOBILE cannot be activated', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const key = `e2e-kanal-${Date.now().toString(36)}`;
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const page = admin.page;

    try {
      await setEngine(false);
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);

      // ---- the builder: three channels, Tümü by default; Mobil warns ----------
      await admin.gotoAdmin('/campaigns/new');
      await assertNoErrorScreen(page);
      const channel = page.getByTestId('campaign-channel');
      await expect(channel).toHaveAttribute('data-channel', 'ALL');
      await expect(channel.getByRole('radio')).toHaveCount(3);
      await expect(channel).toContainText('Web');
      await expect(channel).toContainText('Mobil');
      await expect(channel).toContainText('Tümü');
      await expect(page.getByTestId('campaign-channel-mobile-warning')).toHaveCount(0);

      await page.locator('input[name="name"]').fill('E2E Kanal kampanyası');
      await page.locator('input[name="key"]').fill(key);
      await page.getByLabel('Tetikleyici').getByText('Paket ödemesi tamamlandı').click();
      await page.getByTestId('campaign-add-condition').click();
      await page.getByLabel('Koşul 1 türü').selectOption('FIRST_SUCCESSFUL_PAID_PURCHASE');
      await page.getByTestId('campaign-credits').fill('10');
      await page.getByTestId('campaign-expires-in-days').fill('30');
      await page.getByTestId('campaign-channel-MOBILE').check();
      await expect(channel).toHaveAttribute('data-channel', 'MOBILE');
      await expect(page.getByTestId('campaign-channel-mobile-warning')).toContainText('Mobil istemci henüz yayında değil');

      await page.getByTestId('campaign-validate').click();
      const result = page.getByTestId('campaign-result');
      await expect(result).toHaveAttribute('data-valid', 'true');
      await expect(page.getByTestId('campaign-result-channel')).toHaveText('Mobil');

      // ---- saved as version 1, channel in every place it belongs ---------------
      await page.getByTestId('campaign-save').click();
      await expect(page).toHaveURL(/\/campaigns\/[a-z0-9]+\?ok=created/);
      await assertNoErrorScreen(page);
      const campaign = await prisma().campaign.findUniqueOrThrow({ where: { key }, include: { versions: true } });
      expect(campaign.versions.map((v) => [v.versionNumber, v.channel])).toEqual([[1, 'MOBILE']]);
      expect((campaign.versions[0]!.definition as { channel?: string }).channel).toBe('MOBILE');
      await expect(page.getByTestId('campaign-definition-channel')).toHaveText('Mobil');
      await expect(page.locator('[data-testid="campaign-version-row"][data-version="1"] [data-testid="campaign-version-channel"]')).toHaveText('Mobil');
      await expect(page.getByTestId('campaign-audit')).toContainText('kanal: Mobil');

      // ---- engine on: the panel explains, the API refuses, nothing is written ---
      await setEngine(true);
      await admin.gotoAdmin(`/campaigns/${campaign.id}`);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('campaign-engine-state')).toHaveAttribute('data-engine', 'on');
      const blocked = page.getByTestId('campaign-lifecycle-channel-unavailable');
      await expect(blocked).toHaveAttribute('data-channel', 'MOBILE');
      await expect(blocked).toContainText('Mobil kanalı için kayıtlı kaynak yok');
      await expect(page.getByTestId('campaign-activate')).toBeDisabled();

      const auditBefore = await prisma().campaignAuditLog.count({ where: { campaignId: campaign.id } });
      await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('[data-testid="campaign-activate"]');
        button?.closest('form')?.requestSubmit();
      });
      const refusal = page.getByTestId('campaign-lifecycle-error');
      await expect(refusal).toContainText('CHANNEL_SOURCE_UNAVAILABLE');
      await expect(refusal).toContainText('channel');
      expect(await prisma().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ status: 'DRAFT', activeVersionId: null });
      expect(await prisma().campaignAuditLog.count({ where: { campaignId: campaign.id } })).toBe(auditBefore);

      // ---- a new version is the only way to change the channel ------------------
      const reviseForm = page.getByTestId('campaign-form');
      await expect(reviseForm.getByTestId('campaign-channel')).toHaveAttribute('data-channel', 'MOBILE');
      await reviseForm.getByTestId('campaign-channel-WEB').check();
      await expect(reviseForm.getByTestId('campaign-channel-mobile-warning')).toHaveCount(0);
      await reviseForm.getByTestId('campaign-save').click();
      await expect(page).toHaveURL(/ok=revised&v=2/);
      await assertNoErrorScreen(page);
      await expect(page.locator('[data-testid="campaign-version-row"][data-version="2"] [data-testid="campaign-version-channel"]')).toHaveText('Web');
      await expect(page.locator('[data-testid="campaign-version-row"][data-version="1"] [data-testid="campaign-version-channel"]')).toHaveText('Mobil');
      await expect(page.getByTestId('campaign-audit')).toContainText('değişen: channel');
      await expect(page.getByTestId('campaign-lifecycle-channel-unavailable')).toHaveCount(0);
      const versions = await prisma().campaignVersion.findMany({ where: { campaignId: campaign.id }, orderBy: { versionNumber: 'asc' } });
      expect(versions.map((v) => [v.versionNumber, v.channel])).toEqual([[1, 'MOBILE'], [2, 'WEB']]);

      await expect(page.getByTestId('campaign-activate')).toBeEnabled();
      await page.getByTestId('campaign-activate').click();
      await expect(page).toHaveURL(/ok=activate/);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('campaign-status')).toHaveAttribute('data-status', 'ACTIVE');
      await expect(page.locator('[data-testid="campaign-version-row"][data-version="2"]')).toHaveAttribute('data-active', 'true');
      await expect(page.getByTestId('campaign-active-definition').getByTestId('campaign-definition-channel')).toHaveText('Web');
      expect((await prisma().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).activeVersionId).toBe(versions[1]!.id);

      // ---- the list names the running channel; nothing was granted -------------
      await admin.gotoAdmin('/campaigns');
      await assertNoErrorScreen(page);
      const row = page.locator(`[data-testid="campaign-row"][data-campaign-key="${key}"]`);
      await expect(row.getByTestId('campaign-row-channel')).toHaveText('Web');
      expect(await prisma().campaignRedemption.count({ where: { campaignId: campaign.id } })).toBe(0);
      expect(await prisma().providerCreditTransaction.count({ where: { type: 'CAMPAIGN_GRANT' } })).toBe(0);

      // ---- responsive: builder and detail at every width -----------------------
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 960 });
        await admin.gotoAdmin('/campaigns/new');
        await assertNoErrorScreen(page);
        await page.getByTestId('campaign-channel-MOBILE').check();
        await expect(page.getByTestId('campaign-channel-mobile-warning')).toBeVisible();
        await expectNoHorizontalOverflow(page, `builder @${width}`);
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, `builder-${width}.png`), fullPage: false });

        await admin.gotoAdmin(`/campaigns/${campaign.id}`);
        await assertNoErrorScreen(page);
        await expect(page.getByTestId('campaign-version-row')).toHaveCount(2);
        await expectNoHorizontalOverflow(page, `detail @${width}`);
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, `detail-${width}.png`), fullPage: false });
      }
    } finally {
      // Leave nothing running for the specs after this one: the switch off and
      // this campaign ended (it was only ever a screen fixture).
      await setEngine(false);
      await prisma().campaign.updateMany({ where: { key }, data: { status: 'ENDED' } });
      await admin.close();
    }
  });

  test('a MOBILE draft refused with CHANNEL_SOURCE_UNAVAILABLE is closed as a draft: ENDED, audited, nothing granted', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const key = `e2e-taslak-kapat-${Date.now().toString(36)}`;
    const { campaign, version } = await seedMobileDraft(adminAccount.id, key);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const page = admin.page;
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    try {
      await setEngine(true);
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/campaigns/${campaign.id}`);
      await assertNoErrorScreen(page);

      // ---- the draft cannot run: activation is refused on its channel ----------
      await expect(page.getByTestId('campaign-lifecycle-channel-unavailable')).toHaveAttribute('data-channel', 'MOBILE');
      await expect(page.getByTestId('campaign-activate')).toBeDisabled();
      await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('[data-testid="campaign-activate"]');
        button?.closest('form')?.requestSubmit();
      });
      await expect(page.getByTestId('campaign-lifecycle-error')).toContainText('CHANNEL_SOURCE_UNAVAILABLE');
      expect(await prisma().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ status: 'DRAFT', activeVersionId: null });

      // ---- the panel offers closing the draft, not ending a running campaign ----
      await expect(page.getByTestId('campaign-end')).toHaveCount(0);
      await expect(page.getByTestId('campaign-pause')).toHaveCount(0);
      const closeForm = page.getByTestId('campaign-close-draft-form');
      await expect(closeForm).toContainText('hiç etkinleştirmeden');
      await expect(page.getByTestId('campaign-close-draft')).toHaveText('Taslağı kapat');
      await page.getByTestId('campaign-close-draft-reason').fill('E2E: mobil taslak kullanılmayacak');
      await page.getByTestId('campaign-close-draft').click();
      await expect(page).toHaveURL(/ok=close/);
      await assertNoErrorScreen(page);

      // ---- ENDED, audited as a closed draft; the panel offers nothing more -----
      await expect(page.getByTestId('campaign-ok')).toContainText('Taslak kapatıldı');
      await expect(page.getByTestId('campaign-status')).toHaveAttribute('data-status', 'ENDED');
      const panel = page.getByTestId('campaign-lifecycle-panel');
      await expect(panel).toHaveAttribute('data-status', 'ENDED');
      await expect(panel).toContainText('hiç etkinleşmedi');
      for (const testId of ['campaign-activate', 'campaign-close-draft', 'campaign-pause', 'campaign-resume', 'campaign-end', 'campaign-form']) {
        await expect(page.getByTestId(testId)).toHaveCount(0);
      }
      const audit = page.getByTestId('campaign-audit');
      await expect(audit).toContainText('Taslak kapatıldı (hiç etkinleşmedi)');
      await expect(audit).toContainText('gerekçe: E2E: mobil taslak kullanılmayacak');
      await expect(audit).not.toContainText('Kampanya sonlandırıldı');

      const stored = await prisma().campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      expect(stored).toMatchObject({ status: 'ENDED', activeVersionId: null, currentVersionId: version.id, redemptionCount: 0, budgetConsumedCredits: 0 });
      const rows = await prisma().campaignAuditLog.findMany({ where: { campaignId: campaign.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      expect(rows.map((row) => row.action)).toEqual(['CREATED', 'VERSION_CREATED', 'ENDED']);
      expect(rows[2]).toMatchObject({ actorId: adminAccount.id, campaignVersionId: null });
      expect(rows[2]!.summary).toEqual({ reason: 'E2E: mobil taslak kullanılmayacak', versionNumber: null, fromStatus: 'DRAFT' });
      expect(await prisma().campaignVersion.count({ where: { campaignId: campaign.id } })).toBe(1);
      expect(await prisma().campaignTriggerEvent.count({ where: { settledByCampaignId: campaign.id } })).toBe(0);
      expect(await prisma().campaignRedemption.count({ where: { campaignId: campaign.id } })).toBe(0);
      expect(await prisma().campaignEvaluationLog.count({ where: { campaignId: campaign.id } })).toBe(0);
      expect(await prisma().promoCreditLot.count({ where: { redemption: { campaignId: campaign.id } } })).toBe(0);

      // ---- the list says Sona erdi ---------------------------------------------
      await admin.gotoAdmin('/campaigns');
      await assertNoErrorScreen(page);
      await expect(page.locator(`[data-testid="campaign-row"][data-campaign-key="${key}"]`).getByTestId('campaign-row-status')).toHaveText('Sona erdi');
      expect(consoleErrors).toEqual([]);
    } finally {
      await setEngine(false);
      await admin.close();
    }
  });
});

/** A MOBILE DRAFT with one stored version, written the way the create route writes it. */
async function seedMobileDraft(adminUserId: string, key: string) {
  const definition = {
    schemaVersion: 1,
    trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
    conditions: { all: [{ type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' }, { type: 'NO_PRIOR_REVOCATION' }] },
    benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 30 },
    limits: { maxRedemptionsPerProvider: 1, maxRedemptionsGlobal: 1000, maxRedemptionsPerDay: null, budgetCredits: 10000 },
    window: { startAt: null, endAt: null },
    stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
    priority: 100,
    channel: 'MOBILE',
  };
  const campaign = await prisma().campaign.create({ data: { key, name: `E2E taslak kapat ${key}`, status: 'DRAFT', createdById: adminUserId } });
  const version = await prisma().campaignVersion.create({
    data: {
      campaignId: campaign.id,
      versionNumber: 1,
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      eligibilityFacts: [],
      factSetKey: null,
      definition,
      benefitType: 'PROMO_CREDITS',
      benefitCredits: 10,
      benefitExpiresInDays: 30,
      maxRedemptionsPerProvider: 1,
      maxRedemptionsGlobal: 1000,
      maxRedemptionsPerDay: null,
      budgetCredits: 10000,
      windowStartAt: null,
      windowEndAt: null,
      stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
      priority: 100,
      channel: 'MOBILE',
      createdById: adminUserId,
    },
  });
  await prisma().campaign.update({ where: { id: campaign.id }, data: { currentVersionId: version.id } });
  await prisma().campaignAuditLog.createMany({
    data: [
      { campaignId: campaign.id, action: 'CREATED', actorId: adminUserId },
      { campaignId: campaign.id, action: 'VERSION_CREATED', campaignVersionId: version.id, actorId: adminUserId, summary: { versionNumber: 1, channel: 'MOBILE' } },
    ],
  });
  return { campaign, version };
}
