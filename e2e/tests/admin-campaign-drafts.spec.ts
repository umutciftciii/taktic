import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCategory, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * CMP-002 S1 — the campaign draft screens, driven end to end.
 *
 * One operator builds the package-bonus campaign from the catalogue form,
 * asks for a check, is refused (credits 0), fixes it, saves, sees version 1,
 * revises, sees version 2 with version 1 untouched in the history — and at
 * every step the screen says the engine is off and nothing was granted. A
 * provider's session cannot open the screen at all. Finally the three
 * screens fit at 320, 768, 1024 and 1440 without a horizontal scroll.
 */

const WIDTHS = [320, 768, 1024, 1440] as const;
const SCREENSHOT_DIR = resolve(artifactsDir, 'admin-campaign-drafts');

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const { overflow, culprits } = await page.evaluate(() => {
    const limit = window.innerWidth;
    // Elements inside a horizontal scroll container are clipped by it and
    // cannot widen the document; the rest, widest first, are the suspects.
    const culprits = Array.from(document.querySelectorAll('body *'))
      .filter((el) => el.getBoundingClientRect().right > limit + 1)
      .filter((el) => !el.parentElement?.closest('.table-scroll'))
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
      .slice(0, 8)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return `${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')} right=${Math.round(rect.right)}`;
      });
    return { overflow: document.documentElement.scrollWidth - limit, culprits };
  });
  expect(
    overflow,
    `${label}: the page is ${overflow}px wider than the viewport (${culprits.join(' | ')})`,
  ).toBeLessThanOrEqual(0);
}

async function expectEngineOff(page: Page) {
  const state = page.getByTestId('campaign-engine-state');
  await expect(state).toHaveAttribute('data-engine', 'off');
  await expect(state).toContainText('Kampanya motoru kapalı');
  const text = (await page.locator('main').innerText()).toLowerCase();
  expect(text).not.toContain('kredi verildi');
}

test.describe('admin campaign drafts', () => {
  test('builds, validates, saves and revises a draft with the engine off throughout', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const suffix = `${Date.now().toString(36)}`;
    const key = `e2e-paket-bonusu-${suffix}`;
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const page = admin.page;

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);

      // ---- the list, and its notice ----------------------------------------
      await admin.gotoAdmin('/campaigns');
      await assertNoErrorScreen(page);
      await expectEngineOff(page);
      await expect(page.getByRole('heading', { name: 'Kampanyalar' })).toBeVisible();
      await page.getByTestId('campaign-new-link').click();
      await expect(page).toHaveURL(/\/campaigns\/new/);
      await assertNoErrorScreen(page);
      await expectEngineOff(page);
      await expect(page.getByTestId('campaign-engine-notice')).toContainText('henüz devrede değil');

      // ---- the builder: no JSON editor, catalogue options only --------------
      await expect(page.locator('textarea')).toHaveCount(0);
      await page.locator('input[name="name"]').fill('E2E Paket bonusu');
      await page.locator('input[name="key"]').fill(key);
      await page.getByLabel('Tetikleyici').getByText('Paket ödemesi tamamlandı').click();

      await page.getByTestId('campaign-add-condition').click();
      await page.getByLabel('Koşul 1 türü').selectOption('FIRST_SUCCESSFUL_PAID_PURCHASE');
      await page.getByTestId('campaign-add-condition').click();
      await page.getByLabel('Koşul 2 türü').selectOption('MIN_PAID_AMOUNT');
      const row2 = page.getByTestId('campaign-condition-row').nth(1);
      await row2.getByLabel(/Tutar \(kuruş\)/).fill('10000');
      // A condition the trigger does not offer is not in the menu at all.
      await expect(page.getByLabel('Koşul 2 türü').locator('option[value="FIRST_PROVIDER_APPROVAL"]')).toHaveCount(0);

      // Credits 0 is refused by the API, beside the field, and nothing is saved.
      await page.getByTestId('campaign-credits').fill('0');
      await page.getByTestId('campaign-expires-in-days').fill('30');
      await page.getByTestId('campaign-validate').click();
      const result = page.getByTestId('campaign-result');
      await expect(result).toHaveAttribute('data-valid', 'false');
      await expect(result).toContainText('BENEFIT_INVALID');
      await expect(result).toContainText('Hiçbir şey kaydedilmedi');
      await expect(page.getByTestId('campaign-credits')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByTestId('campaign-benefit').getByTestId('campaign-field-error')).toHaveCount(1);
      expect(await prisma().campaign.count({ where: { key } })).toBe(0);

      // Fixed, the check passes and still saves nothing.
      await page.getByTestId('campaign-credits').fill('10');
      await page.getByTestId('campaign-validate').click();
      await expect(result).toHaveAttribute('data-valid', 'true');
      await expect(result).toContainText('Tanım geçerli');
      await expect(result).toContainText('Henüz kaydedilmedi');
      await expect(result).toContainText('Koşul sayısı');
      expect(await prisma().campaign.count({ where: { key } })).toBe(0);

      // ---- save: version 1 ---------------------------------------------------
      await page.getByTestId('campaign-save').click();
      await expect(page).toHaveURL(/\/campaigns\/[a-z0-9]+\?ok=created/);
      await assertNoErrorScreen(page);
      await expectEngineOff(page);
      await expect(page.getByTestId('campaign-ok')).toContainText('sürüm 1');
      await expect(page.getByTestId('campaign-status')).toHaveText('Taslak');
      await expect(page.getByTestId('campaign-version-row')).toHaveCount(1);
      await expect(page.getByTestId('campaign-current-definition')).toContainText('En az ödenen tutar');
      await expect(page.getByTestId('campaign-audit')).toContainText('Kampanya oluşturuldu');
      await expect(page.getByTestId('campaign-audit')).toContainText('Sürüm kaydedildi');

      const campaign = await prisma().campaign.findUniqueOrThrow({ where: { key }, include: { versions: true } });
      expect(campaign.status).toBe('DRAFT');
      expect(campaign.versions.map((v) => v.versionNumber)).toEqual([1]);
      const v1 = campaign.versions[0]!;
      expect(campaign.currentVersionId).toBe(v1.id);
      expect(await prisma().providerCreditTransaction.count()).toBe(
        await prisma().providerCreditTransaction.count({ where: { type: { in: ['ADMIN_GRANT', 'ADMIN_DEDUCT', 'PACKAGE_PURCHASE', 'OFFER_SPEND', 'OFFER_REFUND', 'ADJUSTMENT'] } } }),
      );

      // ---- revise: version 2, version 1 untouched ---------------------------
      const reviseForm = page.getByTestId('campaign-form');
      await expect(reviseForm.getByTestId('campaign-credits')).toHaveValue('10');
      await reviseForm.getByTestId('campaign-credits').fill('15');
      await reviseForm.getByTestId('campaign-save').click();
      await expect(page).toHaveURL(/ok=revised&v=2/);
      await assertNoErrorScreen(page);
      await expectEngineOff(page);
      await expect(page.getByTestId('campaign-version-row')).toHaveCount(2);
      await expect(page.getByTestId('campaign-version-row').nth(0)).toContainText('v2 (güncel)');
      await expect(page.getByTestId('campaign-version-row').nth(0)).toContainText('15');
      await expect(page.getByTestId('campaign-version-row').nth(1)).toContainText('v1');
      await expect(page.getByTestId('campaign-audit')).toContainText('değişen: benefit');

      const after = await prisma().campaignVersion.findUniqueOrThrow({ where: { id: v1.id } });
      expect(after).toEqual(v1);
      const versions = await prisma().campaignVersion.findMany({ where: { campaignId: campaign.id }, orderBy: { versionNumber: 'asc' } });
      expect(versions.map((v) => [v.versionNumber, v.benefitCredits])).toEqual([[1, 10], [2, 15]]);

      // ---- the list shows the draft, still off ------------------------------
      await admin.gotoAdmin('/campaigns');
      await assertNoErrorScreen(page);
      await expectEngineOff(page);
      const row = page.locator(`[data-testid="campaign-row"][data-campaign-key="${key}"]`);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('Taslak');
      await expect(row).toContainText('v2');

      // ---- and it fits at every width ---------------------------------------
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 960 });
        await admin.gotoAdmin('/campaigns');
        await assertNoErrorScreen(page);
        await expect(row).toBeVisible();
        await expectNoHorizontalOverflow(page, `list @${width}`);
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, `list-${width}.png`), fullPage: false });

        await admin.gotoAdmin(`/campaigns/${campaign.id}`);
        await assertNoErrorScreen(page);
        await expect(page.getByTestId('campaign-version-row')).toHaveCount(2);
        await expectNoHorizontalOverflow(page, `detail @${width}`);
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, `detail-${width}.png`), fullPage: false });

        await admin.gotoAdmin('/campaigns/new');
        await assertNoErrorScreen(page);
        await page.getByTestId('campaign-add-condition').click();
        await page.getByLabel('Koşul 1 türü').selectOption('MIN_PAID_AMOUNT');
        await expectNoHorizontalOverflow(page, `builder @${width}`);
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, `builder-${width}.png`), fullPage: false });
      }
    } finally {
      await admin.close();
    }
  });

  test('a provider session is sent to the login form, not to the drafts', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Kampanya Erişim' });
    const providerAccount = await createProvider({ categoryId: category.id, location, credits: 3 });
    const intruder = await Actor.open(browser, 'intruder', primaryRuntime);

    try {
      await intruder.loginToWeb(providerAccount.email, providerAccount.password);
      await intruder.gotoAdmin('/campaigns');
      await expect(intruder.page).toHaveURL(/\/login/);
      await expect(intruder.page.getByTestId('campaigns-table')).toHaveCount(0);
      await intruder.gotoAdmin('/campaigns/new');
      await expect(intruder.page).toHaveURL(/\/login/);
      await expect(intruder.page.getByTestId('campaign-form')).toHaveCount(0);
      await assertNoErrorScreen(intruder.page);
    } finally {
      await intruder.close();
    }
  });
});
