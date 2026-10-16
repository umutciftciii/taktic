import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCategory, createProvider, createStaffAdmin, uniqueLocation } from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';
import {
  retireShowcasePlacements,
  seedApprovedShowcaseCard,
  seedLiveShowcasePlacement,
} from '../src/showcase-fixtures';

/**
 * SHOWCASE-ALLOWANCE-002 — /finance/offer-allowances through the real admin
 * screen, the real API and the real database.
 *
 * The suite shares one database, so every figure asserted here is read under
 * this spec's own provider or category filter: the totals of other specs'
 * runs never leak into an expectation.
 */

async function seedRun(freeOfferCount: number) {
  const location = uniqueLocation();
  const category = await createCategory(3, { namePrefix: 'E2E Ücretsiz Hak' });
  const provider = await createProvider({ categoryId: category.id, location, credits: 0 });
  const { card, version } = await seedApprovedShowcaseCard({
    providerId: provider.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
    title: 'E2E ücretsiz hak raporu',
  });
  const { placement } = await seedLiveShowcasePlacement({
    providerId: provider.id,
    cardId: card.id,
    versionId: version.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
    freeOfferCount,
  });
  return { category, provider, placement };
}

async function expectNoPageOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label}: page overflow`).toBeLessThanOrEqual(1);
}

test('a FINANCE_READ session reads the free vitrin offer report, filtered from its own rows', async ({ browser }) => {
  const run = await seedRun(3);
  const zero = await seedRun(0);
  const account = await createStaffAdmin(['FINANCE_READ']);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  try {
    await actor.page.setViewportSize({ width: 1440, height: 1200 });
    await actor.loginToAdmin(account.email, account.password);
    const page = actor.page;

    await page.goto(`${primaryRuntime.adminUrl}/finance`);
    await page.getByRole('link', { name: 'Ücretsiz vitrin hakları' }).click();
    await expect(page).toHaveURL(/\/finance\/offer-allowances$/);
    await assertNoErrorScreen(page);
    await expect(page.getByRole('heading', { name: 'Ücretsiz vitrin teklif hakları' })).toBeVisible();

    // Narrow to this spec's category, then to its provider through the row's own link.
    await page.goto(`${primaryRuntime.adminUrl}/finance/offer-allowances?categoryId=${run.category.id}`);
    const providerRow = page.getByTestId('allowance-provider-table-row').filter({ hasText: run.provider.businessName });
    await providerRow.getByRole('link', { name: /Bu satıra göre filtrele/ }).click();
    await expect(page).toHaveURL(new RegExp(`providerId=${run.provider.id}`));
    await expect(page).toHaveURL(new RegExp(`categoryId=${run.category.id}`));

    await expect(page.getByTestId('allowance-kpi-defined').locator('.finance-kpi-value')).toHaveText('3');
    await expect(page.getByTestId('allowance-kpi-used').locator('.finance-kpi-value')).toHaveText('0');
    await expect(page.getByTestId('allowance-kpi-usable').locator('.finance-kpi-value')).toHaveText('3');
    await expect(page.getByTestId('allowance-kpi-unusable').locator('.finance-kpi-value')).toHaveText('0');
    // A category filter leaves unplaced rights out, and says why.
    await expect(page.getByTestId('allowance-kpi-unplaced')).toContainText('Kategori filtresinde gösterilmez');

    const valueCard = page.getByTestId('allowance-value-section');
    await expect(
      valueCard.getByRole('heading', { name: 'Ücretsiz tekliflerin gösterge niteliğindeki TL karşılığı' }),
    ).toBeVisible();
    await expect(valueCard).toContainText('gelir ya da kesin gelir kaybı değildir');
    await expect(page.getByTestId('offer-allowance-active-filters')).toContainText(run.provider.businessName);

    // Removing the provider chip keeps the category filter.
    await page
      .getByTestId('offer-allowance-active-filters')
      .getByRole('link', { name: new RegExp(`Filtreyi kaldır: İşletme`) })
      .click();
    await expect(page).not.toHaveURL(/providerId=/);
    await expect(page).toHaveURL(new RegExp(`categoryId=${run.category.id}`));

    // A run sold with 0 free offers carries no grant, and the report says that is expected.
    await page.goto(`${primaryRuntime.adminUrl}/finance/offer-allowances?providerId=${zero.provider.id}`);
    await expect(page.getByTestId('allowance-kpi-defined').locator('.finance-kpi-value')).toHaveText('0');
    await expect(page.getByTestId('allowance-integrity-zero')).toContainText('1 yayın 0 ücretsiz teklifle satıldı');

    // A hand-written day grouping without a window is shown as a notice, never an error page.
    await page.goto(`${primaryRuntime.adminUrl}/finance/offer-allowances?groupBy=day`);
    await assertNoErrorScreen(page);
    await expect(page.getByTestId('offer-allowance-notice')).toContainText('Günlük gruplama');

    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${primaryRuntime.adminUrl}/finance/offer-allowances?providerId=${run.provider.id}`);
      await assertNoErrorScreen(page);
      await expectNoPageOverflow(page, `offer-allowances@${width}`);
      // The window only, so a long page never meets WebKit's device-pixel limit.
      mkdirSync(resolve(artifactsDir, 'showcase-allowance-002'), { recursive: true });
      await page.screenshot({
        path: resolve(artifactsDir, 'showcase-allowance-002', `${test.info().project.name}-offer-allowances-${width}.png`),
      });
    }
  } finally {
    await actor.close();
    await retireShowcasePlacements([run.placement.id, zero.placement.id]);
  }
});
