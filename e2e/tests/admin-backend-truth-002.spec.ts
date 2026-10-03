import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createOfferPackage,
  createProvider,
  createStaffAdmin,
  prisma,
  uniqueLocation,
  uniqueSuffix,
} from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * ADMIN-BACKEND-TRUTH-002 — the admin lists page on the server with a real
 * total, and the operations screen shows a hand-run and a recovered run as
 * what they are. Through the real Next screens against the real API.
 *
 * The suite shares one database, so every count is pinned to this spec's own
 * rows (a provider pin) or compared with the database at that moment.
 */

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.loginToAdmin(account.email, account.password);
  return { actor, account };
}

async function expectOpen(page: Page, path: RegExp) {
  await expect(page).toHaveURL(path);
  await assertNoErrorScreen(page);
  await expect(page.getByRole('heading', { name: /yetkiniz yok/i })).toHaveCount(0);
}

async function rowIds(page: Page, testId: string, attribute: string) {
  return page.getByTestId(testId).evaluateAll((rows, name) => rows.map((row) => row.getAttribute(name) ?? ''), attribute);
}

test.describe('ADMIN-BACKEND-TRUTH-002 — server pagination and run records', () => {
  test('package purchases page on the server, keep the filters across pages and restart at page 1', async ({ browser }) => {
    const category = await createCategory(2, { namePrefix: 'E2E BT2' });
    const provider = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 0 });
    const pkg = await createOfferPackage({ type: 'ONE_TIME_CREDITS', name: `E2E BT2 paket ${uniqueSuffix()}`, creditAmount: 10 });
    // Kept off sale: a live package would join every later spec's catalogue.
    await prisma().offerCreditPackage.update({ where: { id: pkg.id }, data: { isActive: false } });
    const base = Date.now() - 60_000;
    for (let i = 0; i < 30; i += 1) {
      await prisma().packagePurchase.create({
        data: {
          providerId: provider.id,
          kind: 'OFFER_PACKAGE',
          packageId: pkg.id,
          status: i < 4 ? 'PENDING' : 'CANCELLED',
          creditAmountSnapshot: 10,
          priceAmountSnapshot: 1000,
          currencySnapshot: 'TRY',
          packageNameSnapshot: pkg.name,
          paymentProvider: 'mock',
          createdAt: new Date(base + i * 1000),
        },
      });
    }

    const reader = await openAs(browser, ['PACKAGE_PURCHASES_READ']);
    try {
      const page = reader.actor.page;
      await reader.actor.gotoAdmin(`/package-purchases?providerId=${provider.id}`);
      await expectOpen(page, /\/package-purchases\?providerId=/);
      await expect(page.getByTestId('purchase-row')).toHaveCount(25);
      await expect(page.getByTestId('purchase-count')).toHaveText('30 kaydın 1–25 arası gösteriliyor');

      const first = await page.getByTestId('purchase-row').evaluateAll((rows) => rows.map((row) => row.textContent ?? ''));
      await page.getByTestId('pagination-next').click();
      await expect(page).toHaveURL(new RegExp(`providerId=${provider.id}.*page=2|page=2.*providerId=${provider.id}`));
      await expect(page.getByTestId('purchase-row')).toHaveCount(5);
      await expect(page.getByTestId('purchase-count')).toHaveText('30 kaydın 26–30 arası gösteriliyor');
      const second = await page.getByTestId('purchase-row').evaluateAll((rows) => rows.map((row) => row.textContent ?? ''));
      // Each row names its own purchase number, so no row repeats across pages.
      expect(new Set([...first, ...second]).size).toBe(30);

      // A filter change keeps the pin and goes back to page 1.
      await page.locator('#purchase-status').selectOption('PENDING');
      await page.getByTestId('purchase-filters').getByRole('button', { name: /uygula|filtrele/i }).click();
      await expect(page).toHaveURL(/status=PENDING/);
      expect(page.url()).not.toMatch(/page=2/);
      expect(page.url()).toContain(`providerId=${provider.id}`);
      await expect(page.getByTestId('purchase-row')).toHaveCount(4);
      await expect(page.getByTestId('purchase-count')).toHaveText('4 kaydın 1–4 arası gösteriliyor');
    } finally {
      await reader.actor.close();
    }
  });

  test('the eligibility queue reaches past 100 holds, with both views counted', async ({ browser }) => {
    const category = await createCategory(2, { namePrefix: 'E2E BT2 uygunluk' });
    const provider = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 0 });
    const base = Date.now() - 3_600_000;
    for (let i = 0; i < 105; i += 1) {
      const event = await prisma().campaignTriggerEvent.create({
        data: {
          triggerEventKey: `PROVIDER_APPROVED:e2e-bt2-${i}-${uniqueSuffix()}`,
          trigger: 'PROVIDER_APPROVED',
          providerId: provider.id,
          status: 'HELD_FOR_REVIEW',
        },
      });
      await prisma().promotionEligibilityHold.create({
        data: {
          triggerEventId: event.id,
          providerId: provider.id,
          signals: { outcome: 'REVIEW', signals: [{ code: 'SHARED_IP' }] },
          snapshotVersion: 1,
          heldAt: new Date(base + i * 1000),
        },
      });
    }
    const openTotal = await prisma().promotionEligibilityHold.count({ where: { review: { is: null } } });
    const decidedTotal = await prisma().promotionEligibilityHold.count({ where: { review: { isNot: null } } });

    const reviewer = await openAs(browser, ['PROMOTION_ELIGIBILITY_REVIEW']);
    try {
      const page = reviewer.actor.page;
      await reviewer.actor.gotoAdmin('/promotion-eligibility');
      await expectOpen(page, /\/promotion-eligibility$/);
      await expect(page.getByTestId('eligibility-row')).toHaveCount(50);
      await expect(page.getByTestId('eligibility-list-summary')).toContainText(`kaydın 1–50 arası`);
      await expect(page.getByTestId('eligibility-view-open')).toContainText(String(openTotal));
      await expect(page.getByTestId('eligibility-view-decided')).toContainText(String(decidedTotal));

      const seen = new Set(await rowIds(page, 'eligibility-row', 'data-event'));
      const pages = Math.ceil(openTotal / 50);
      for (let n = 2; n <= pages; n += 1) {
        await page.getByTestId('pagination-next').click();
        await expect(page).toHaveURL(new RegExp(`page=${n}`));
        await expect(page.getByTestId('eligibility-row').first()).toBeVisible();
        for (const id of await rowIds(page, 'eligibility-row', 'data-event')) {
          expect(seen.has(id), `hold ${id} appeared twice`).toBe(false);
          seen.add(id);
        }
      }
      expect(seen.size).toBe(openTotal);
      await expect(page.getByTestId('pagination-next')).toHaveAttribute('aria-disabled', 'true');

      // Switching view starts again at page 1.
      await page.getByTestId('eligibility-view-decided').click();
      await expect(page).toHaveURL(/filter=decided/);
      expect(page.url()).not.toMatch(/page=/);
    } finally {
      await reviewer.actor.close();
    }
  });

  test('the campaign list shows its real total and walks back as well as forward', async ({ browser }) => {
    const owner = await createAdmin();
    for (let i = 0; i < 27; i += 1) {
      await prisma().campaign.create({
        data: { key: `e2e-bt2-${i}-${uniqueSuffix()}`, name: `E2E BT2 kampanya ${i}`, status: 'DRAFT', createdById: owner.id },
      });
    }
    const total = await prisma().campaign.count();

    const reader = await openAs(browser, ['CAMPAIGNS_READ']);
    try {
      const page = reader.actor.page;
      await reader.actor.gotoAdmin('/campaigns');
      await expectOpen(page, /\/campaigns$/);
      await expect(page.getByTestId('campaign-page-summary')).toHaveText(`Toplam ${total} kampanya · bu sayfada 25`);
      await expect(page.getByTestId('pagination-previous')).toHaveAttribute('aria-disabled', 'true');
      const first = await rowIds(page, 'campaign-row', 'data-campaign-key');

      await page.getByTestId('pagination-next').click();
      await expect(page).toHaveURL(/cursor=/);
      await expect(page.getByTestId('campaign-row').first()).toBeVisible();
      const second = await rowIds(page, 'campaign-row', 'data-campaign-key');
      expect(second.some((key) => first.includes(key))).toBe(false);
      await expect(page.getByTestId('campaign-page-summary')).toContainText(`Toplam ${total} kampanya`);

      await page.getByTestId('pagination-previous').click();
      await expect(page).toHaveURL(/before=/);
      await expect(page.getByTestId('campaign-row').first()).toBeVisible();
      expect(await rowIds(page, 'campaign-row', 'data-campaign-key')).toEqual(first);
      await expect(page.getByTestId('pagination-previous')).toHaveAttribute('aria-disabled', 'true');
    } finally {
      await reader.actor.close();
    }
  });

  test('the operations screen names a hand-run and says a recovered run was interrupted', async ({ browser }) => {
    const operator = await createAdmin();
    // Newer than anything a tick could have written, so each is its job's latest.
    const later = new Date(Date.now() + 120_000);
    await prisma().schedulerRun.create({
      data: {
        jobKey: 'unviewed-offer-refund',
        trigger: 'MANUAL',
        actorId: operator.id,
        status: 'SUCCESS',
        startedAt: later,
        finishedAt: new Date(later.getTime() + 1000),
        summary: 'processed=3 refunded=2 skipped=1 failed=0',
      },
    });
    await prisma().schedulerRun.create({
      data: {
        jobKey: 'showcase-placement-expiry',
        status: 'FAILED',
        startedAt: later,
        finishedAt: new Date(later.getTime() + 600_000),
        errorCode: 'PROCESS_INTERRUPTED',
      },
    });

    const admin = await openAs(browser, 'super');
    try {
      const page = admin.actor.page;
      await admin.actor.gotoAdmin('/operations-settings');
      await expectOpen(page, /\/operations-settings$/);
      const manual = page.getByTestId('scheduler-last-manual-run-unviewed-offer-refund');
      await expect(manual).toContainText('Elle:');
      await expect(manual).toContainText('processed=3 refunded=2 skipped=1 failed=0');
      await expect(manual).toContainText(operator.name);
      // The hand-run is not the scheduler's run.
      await expect(page.getByTestId('scheduler-last-run-unviewed-offer-refund')).not.toContainText('processed=3 refunded=2');
      await expect(page.getByTestId('scheduler-last-run-showcase-placement-expiry')).toContainText('yarıda kaldı');
      await expect(page.getByTestId('scheduler-last-run-showcase-placement-expiry')).not.toContainText('hata verdi');
      await expect(page.getByTestId('scheduler-last-manual-run-request-expiry')).toHaveCount(0);
    } finally {
      await admin.actor.close();
    }
  });
});
