import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { expectNoHorizontalOverflow, seedActiveCampaign, seedGrantedLot } from '../src/campaign-fixtures';
import { createAdmin, createCategory, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * CMP-004 S4 — what a provider sees of their own promotion.
 *
 * Two granted lots (one expiring sooner) and one lot already swept EXPIRED.
 * The credits page shows the spendable total and the two live lots, soonest
 * expiry first, each with its campaign's name; the ledger names the grant
 * and the expiry in Turkish rather than by code; the screen fits at 320,
 * 768, 1024 and 1440 with no horizontal overflow. Another provider's page
 * shows none of it.
 */

const WIDTHS = [320, 768, 1024, 1440] as const;
const SCREENSHOT_DIR = resolve(artifactsDir, 'provider-promo-credits');
const DAY = 86_400_000;

test.describe('provider promo credits', () => {
  test('shows the spendable promotion, soonest expiry first, with the campaign name, and fits every width', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Promosyon' });
    const provider = await createProvider({ categoryId: category.id, location, credits: 5 });
    const stranger = await createProvider({ categoryId: category.id, location, credits: 1 });
    const seeded = await seedActiveCampaign(adminAccount.id, `e2e-promo-${Date.now().toString(36)}`);
    const later = await seedGrantedLot(seeded, provider.id, 10, 0, { expiresAt: new Date(Date.now() + 30 * DAY) });
    const sooner = await seedGrantedLot(seeded, provider.id, 3, 0, { expiresAt: new Date(Date.now() + 5 * DAY) });
    // A lot the sweeper already expired: its remainder left the wallet through CAMPAIGN_EXPIRE.
    const dead = await seedGrantedLot(seeded, provider.id, 2, 0, { expiresAt: new Date(Date.now() - DAY) });
    const latest = await prisma().providerCreditTransaction.findFirstOrThrow({ where: { providerId: provider.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const expiry = await prisma().providerCreditTransaction.create({
      data: { providerId: provider.id, type: 'CAMPAIGN_EXPIRE', amount: -2, balanceAfter: latest.balanceAfter - 2, reason: 'PROMO_LOT_EXPIRED', referenceType: 'PromoCreditLot', referenceId: dead.lot.id },
    });
    await prisma().promoCreditLot.update({ where: { id: dead.lot.id }, data: { status: 'EXPIRED', remainingCredits: 0, expiryTransactionId: expiry.id } });
    await prisma().campaignRedemption.update({ where: { id: dead.redemption.id }, data: { status: 'EXPIRED' } });
    const campaignName = (await prisma().campaign.findUniqueOrThrow({ where: { id: seeded.campaign.id } })).name;

    const actor = await Actor.open(browser, 'provider', primaryRuntime);
    const page = actor.page;
    try {
      await actor.loginToWeb(provider.email, provider.password);
      await actor.gotoWeb(`/providers/${provider.id}/credits`);
      await assertNoErrorScreen(page);

      const promo = page.getByTestId('promo-credits');
      await expect(promo).toBeVisible();
      await expect(promo.getByTestId('promo-credits-total')).toHaveText(/13/);
      const rows = promo.getByTestId('promo-lot');
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toHaveAttribute('data-lot', sooner.lot.id);
      await expect(rows.nth(0)).toContainText('3 kredi');
      await expect(rows.nth(1)).toHaveAttribute('data-lot', later.lot.id);
      await expect(rows.nth(1)).toContainText('10 kredi');
      await expect(rows.nth(0)).toContainText(campaignName);
      // The wallet still counts the swept lot's history, but the total does not.
      await expect(page.locator('.credit-balance')).toContainText('18');

      // The ledger speaks Turkish, not code.
      const history = page.locator('.pdash-table');
      await expect(history).toContainText('Promosyon kredisi');
      await expect(history).toContainText('Promosyon süresi doldu');
      const html = await page.content();
      expect(html).not.toContain('PROMO_LOT_EXPIRED');
      expect(html).not.toContain('CAMPAIGN_GRANT');
      expect(html).not.toContain(stranger.businessName);

      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 960 });
        await actor.gotoWeb(`/providers/${provider.id}/credits`);
        await assertNoErrorScreen(page);
        await expect(page.getByTestId('promo-credits')).toBeVisible();
        await expectNoHorizontalOverflow(page, `credits @${width}`);
        const tooTall = await page.evaluate(() => document.documentElement.scrollHeight * window.devicePixelRatio > 32000);
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, `credits-${width}.png`), fullPage: !tooTall });
      }
    } finally {
      await actor.close();
    }

    // Another provider: no promotion block, and the first provider's id is refused.
    const other = await Actor.open(browser, 'stranger', primaryRuntime);
    try {
      await other.loginToWeb(stranger.email, stranger.password);
      await other.gotoWeb(`/providers/${stranger.id}/credits`);
      await assertNoErrorScreen(other.page);
      await expect(other.page.getByTestId('promo-credits')).toHaveCount(0);
      await other.gotoWeb(`/providers/${provider.id}/credits`);
      await expect(other.page.getByTestId('promo-credits')).toHaveCount(0);
      expect(await other.page.content()).not.toContain(campaignName);
    } finally {
      await other.close();
    }
  });
});
