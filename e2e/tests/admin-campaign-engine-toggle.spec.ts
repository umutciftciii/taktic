import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { expectNoHorizontalOverflow } from '../src/campaign-fixtures';
import { createAdmin, createCategory, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * CMP-004 S4 — the campaign engine's switch, on the operations screen.
 *
 * The API suite proves the rules (default off, SUPER_ADMIN only, one audit
 * row per real change). What only a browser can answer is proved here: the
 * switch opens on "Kapalı", refuses to move without the operator's explicit
 * confirmation, moves once confirmed and shows who moved it, and moves back
 * — all in this suite's own database, which is put back to "off" at the
 * end. A provider's session cannot reach the screen. It fits every width.
 */

const WIDTHS = [320, 768, 1024, 1440] as const;
const SCREENSHOT_DIR = resolve(artifactsDir, 'admin-campaign-engine-toggle');

async function storedFlag(): Promise<boolean | null> {
  const row = await prisma().operationsSettings.findUnique({ where: { id: 'singleton' }, select: { campaignEngineEnabled: true } });
  return row?.campaignEngineEnabled ?? null;
}

async function resetEngine() {
  await prisma().operationsSettingsChange.deleteMany({ where: { setting: 'campaignEngineEnabled' } });
  await prisma().operationsSettings.updateMany({ where: { id: 'singleton' }, data: { campaignEngineEnabled: false } });
}

test.describe('campaign engine switch', () => {
  test.beforeEach(resetEngine);
  test.afterEach(resetEngine);

  test('opens off, needs an explicit confirmation, switches on and off with an audit line, and fits every width', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const page = admin.page;

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/operations-settings');
      await assertNoErrorScreen(page);

      const card = page.locator('#kampanya-motoru');
      await expect(card).toBeVisible();
      await expect(card.getByTestId('campaign-engine-state')).toHaveText('Kapalı');
      await expect(card.getByTestId('campaign-engine-audit-empty')).toBeVisible();

      // Without the confirmation the request never leaves the form.
      await card.getByTestId('campaign-engine-submit').click();
      await expect(card.getByTestId('campaign-engine-state')).toHaveText('Kapalı');
      expect(await storedFlag()).not.toBe(true);
      expect(await prisma().operationsSettingsChange.count({ where: { setting: 'campaignEngineEnabled' } })).toBe(0);

      // Confirmed: on, with the operator on the trail.
      await card.getByTestId('campaign-engine-confirm').check();
      await card.getByTestId('campaign-engine-submit').click();
      await expect(page).toHaveURL(/ok=campaign-engine-on/);
      await assertNoErrorScreen(page);
      await expect(card.getByTestId('campaign-engine-state')).toHaveText('Açık');
      expect(await storedFlag()).toBe(true);
      const audit = card.getByTestId('campaign-engine-audit');
      await expect(audit).toContainText('Açık');
      await expect(audit).toContainText(adminAccount.name ?? 'Yönetici');
      expect(await prisma().operationsSettingsChange.count({ where: { setting: 'campaignEngineEnabled' } })).toBe(1);

      // The campaign list now says the engine is on and points back here.
      await admin.gotoAdmin('/campaigns');
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('campaign-engine-state')).toHaveAttribute('data-engine', 'on');

      // Off again, confirmed: a second trail line, nothing else.
      await admin.gotoAdmin('/operations-settings');
      await card.getByTestId('campaign-engine-confirm').check();
      await card.getByTestId('campaign-engine-submit').click();
      await expect(page).toHaveURL(/ok=campaign-engine-off/);
      await assertNoErrorScreen(page);
      await expect(card.getByTestId('campaign-engine-state')).toHaveText('Kapalı');
      expect(await storedFlag()).toBe(false);
      expect(await prisma().operationsSettingsChange.count({ where: { setting: 'campaignEngineEnabled' } })).toBe(2);

      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 960 });
        await admin.gotoAdmin('/operations-settings#kampanya-motoru');
        await assertNoErrorScreen(page);
        await expect(card.getByTestId('campaign-engine-submit')).toBeVisible();
        await expectNoHorizontalOverflow(page, `operations-settings @${width}`);
        const tooTall = await page.evaluate(() => document.documentElement.scrollHeight * window.devicePixelRatio > 32000);
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, `operations-settings-${width}.png`), fullPage: !tooTall });
      }
    } finally {
      await admin.close();
    }
  });

  test('a provider session is sent to the login form and the switch stays off', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Motor Erişim' });
    const providerAccount = await createProvider({ categoryId: category.id, location, credits: 1 });
    const intruder = await Actor.open(browser, 'intruder', primaryRuntime);
    try {
      await intruder.loginToWeb(providerAccount.email, providerAccount.password);
      await intruder.gotoAdmin('/operations-settings');
      await expect(intruder.page).toHaveURL(/\/login/);
      await expect(intruder.page.locator('#kampanya-motoru')).toHaveCount(0);
      expect(await storedFlag()).not.toBe(true);
    } finally {
      await intruder.close();
    }
  });
});
