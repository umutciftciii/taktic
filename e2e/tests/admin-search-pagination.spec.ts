import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  prisma,
  uniqueLocation,
  uniquePhone,
  uniqueSuffix,
} from '../src/fixtures';
import { seedOffer } from '../src/offer-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * ADMIN-SEARCH-PAGINATION-001 — the customer and offer lists are paged by the
 * API, through the real Next screens.
 *
 * The suite shares one database, so each list is pinned to this spec's own
 * rows: the offers by their provider, the customers by a search token only
 * they carry.
 */

async function openAsSuper(browser: Parameters<typeof Actor.open>[0]) {
  const account = await createAdmin();
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.loginToAdmin(account.email, account.password);
  return actor;
}

async function rowIds(page: Page, testId: string, attribute: string) {
  return page.getByTestId(testId).evaluateAll((rows, name) => rows.map((row) => row.getAttribute(name) ?? ''), attribute);
}

test.describe('ADMIN-SEARCH-PAGINATION-001 — /offers and /customers page on the server', () => {
  test('offers: 55 pinned offers are 50 + 5, history keeps the page, a filter restarts at page 1', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Sayfa' });
    const provider = await createProvider({ categoryId: category.id, location, credits: 0 });
    const offerIds: string[] = [];
    for (let i = 0; i < 55; i += 1) {
      const suffix = uniqueSuffix();
      const request = await prisma().serviceRequest.create({
        data: {
          categoryId: category.id,
          customerId: null,
          requestNumber: `TR-E2E-PG-${suffix}`,
          customerName: `E2E Sayfa Misafir ${suffix}`,
          customerPhone: uniquePhone(),
          customerEmail: `e2e-page-${suffix}@example.test`,
          city: location.city,
          district: location.district,
          status: 'APPROVED',
          approvedAt: new Date(),
          qualityScore: 60,
        },
        select: { id: true },
      });
      const offer = await seedOffer({ requestId: request.id, providerId: provider.id, status: i < 5 ? 'VIEWED' : 'SUBMITTED' });
      offerIds.push(offer.id);
    }

    const actor = await openAsSuper(browser);
    const page = actor.page;
    try {
      await actor.gotoAdmin(`/offers?providerId=${provider.id}`);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('offer-row')).toHaveCount(50);
      await expect(page.getByTestId('offer-count')).toHaveText('55 kaydın 1–50 arası gösteriliyor');
      // The figures are the API's counts over the whole match, not this page's.
      await expect(page.getByTestId('offer-stat-total')).toContainText('55');
      await expect(page.getByTestId('offer-pins')).toContainText(provider.businessName);
      const first = await rowIds(page, 'offer-row', 'data-offer-id');

      await page.getByTestId('pagination-next').click();
      await expect(page).toHaveURL(/[?&]page=2(&|$)/);
      await expect(page.getByTestId('offer-row')).toHaveCount(5);
      await expect(page.getByTestId('offer-count')).toHaveText('55 kaydın 51–55 arası gösteriliyor');
      await expect(page.getByTestId('pagination-next')).toHaveAttribute('aria-disabled', 'true');
      const second = await rowIds(page, 'offer-row', 'data-offer-id');
      expect(new Set([...first, ...second])).toEqual(new Set(offerIds));

      // Back and forward are plain URL state.
      await page.goBack();
      await expect(page).not.toHaveURL(/[?&]page=/);
      await expect(page.getByTestId('offer-row')).toHaveCount(50);
      await page.goForward();
      await expect(page).toHaveURL(/[?&]page=2(&|$)/);
      await expect(page.getByTestId('offer-row')).toHaveCount(5);

      // A filter from page 2 keeps the pin and starts again at page 1.
      await page.locator('#offer-status').selectOption('VIEWED');
      await page.getByRole('search', { name: 'Teklif filtreleri' }).getByRole('button', { name: 'Filtrele' }).click();
      await expect(page).toHaveURL(/[?&]status=VIEWED(&|$)/);
      expect(page.url()).toContain(`providerId=${provider.id}`);
      expect(page.url()).not.toMatch(/[?&]page=/);
      await expect(page.getByTestId('offer-row')).toHaveCount(5);
      await expect(page.getByTestId('offer-count')).toHaveText('5 kaydın 1–5 arası gösteriliyor');

      // Nothing matches: the empty state, and no pager.
      const filters = page.getByRole('search', { name: 'Teklif filtreleri' });
      await filters.getByLabel('Ara').fill(`yok-${uniqueSuffix()}-boyle-bir-teklif`);
      await filters.getByRole('button', { name: 'Filtrele' }).click();
      await expect(page.getByText('Filtrelere uygun teklif bulunamadı.')).toBeVisible();
      await expect(page.getByTestId('offer-row')).toHaveCount(0);
      await expect(page.getByTestId('offer-count')).toHaveCount(0);
    } finally {
      await actor.close();
    }
  });

  test('customers: 25 matches are 20 + 5, history keeps the page, a new search restarts at page 1', async ({ browser }) => {
    const token = `sayfa${uniqueSuffix()}x`;
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      ids.push((await createCustomer(`E2E ${token}`)).id);
    }

    const actor = await openAsSuper(browser);
    const page = actor.page;
    try {
      await actor.gotoAdmin(`/customers?q=${token}`);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('customer-row')).toHaveCount(20);
      await expect(page.getByTestId('customer-count')).toHaveText('25 kaydın 1–20 arası gösteriliyor');
      const first = await rowIds(page, 'customer-row', 'data-customer-id');

      await page.getByTestId('pagination-next').click();
      await expect(page).toHaveURL(/[?&]page=2(&|$)/);
      await expect(page.getByTestId('customer-row')).toHaveCount(5);
      await expect(page.getByTestId('customer-count')).toHaveText('25 kaydın 21–25 arası gösteriliyor');
      const second = await rowIds(page, 'customer-row', 'data-customer-id');
      expect(new Set([...first, ...second])).toEqual(new Set(ids));

      await page.goBack();
      await expect(page).not.toHaveURL(/[?&]page=/);
      await expect(page.getByTestId('customer-row')).toHaveCount(20);
      await page.goForward();
      await expect(page).toHaveURL(/[?&]page=2(&|$)/);
      await expect(page.getByTestId('customer-row')).toHaveCount(5);

      // A new search from page 2 starts again at page 1.
      const filters = page.getByRole('search', { name: 'Müşteri filtreleri' });
      await filters.getByLabel('Ara').fill(`yok-${token}`);
      await filters.getByRole('button', { name: 'Filtrele' }).click();
      expect(page.url()).not.toMatch(/[?&]page=/);
      await expect(page.getByText('Filtreye uygun müşteri bulunamadı.')).toBeVisible();
      await expect(page.getByTestId('customer-row')).toHaveCount(0);
    } finally {
      await actor.close();
    }
  });
});
