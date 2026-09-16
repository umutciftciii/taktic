import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  prisma,
  requestFormValues,
  uniqueLocation,
} from '../src/fixtures';
import {
  approveRequest,
  createRequest,
  fillOfferForm,
  openRequestAsProvider,
  readProviderOfferId,
  submitOffer,
} from '../src/journeys';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * The offer experience, on both sides of one request.
 *
 * - **The customer is told about a cancellation they would otherwise not
 *   notice.** An offer they opened and the provider then withdrew carries one
 *   sentence on the list and on its detail — about the offer only, nothing
 *   about credits or refunds — and no accept control anywhere near it. The
 *   live offer beside it is untouched.
 * - **The provider's price field speaks lira.** `4500` becomes `4.500,00` when
 *   the field is left, the API receives 450000 kuruş, and every screen shows
 *   `₺4.500,00`.
 * - **The provider's panels fit the screen.** The offer panel on a request and
 *   the "Tekliflerim" list have no horizontal overflow at 320, 768, 1024 and
 *   1440 pixels; the refund badge stays inside its card; the action area has
 *   the primary button on every row whether or not the row has secondary ones.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;
const WIDTHS = [320, 768, 1024, 1440] as const;
const SCREENSHOT_DIR = resolve(artifactsDir, 'screens');

async function overflowOf(page: Page): Promise<number> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) {
    // Name the culprits, so a failure says which element grew past the viewport.
    const widest = await page.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .map((el) => ({ el, right: el.getBoundingClientRect().right }))
        .filter(({ right }) => right > window.innerWidth + 0.5)
        .sort((a, b) => b.right - a.right)
        .slice(0, 8)
        .map(({ el, right }) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return `${el.tagName.toLowerCase()}.${(el as HTMLElement).className} left=${Math.round(r.left)} width=${Math.round(r.width)} right=${Math.round(right)} display=${cs.display} minWidth=${cs.minWidth} parent=${el.parentElement?.tagName.toLowerCase()}.${el.parentElement?.className} parentWidth=${Math.round(el.parentElement?.getBoundingClientRect().width ?? 0)} parentDisplay=${el.parentElement ? getComputedStyle(el.parentElement).display : ''}`;
        }),
    );
    console.log(`overflow ${overflow}px @ ${page.viewportSize()?.width}px:\n  ${widest.join('\n  ')}`);
  }
  return overflow;
}

async function innerOverflowOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.scrollWidth - el.clientWidth : 0;
  }, selector);
}

async function capture(page: Page, name: string, width: number) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, `${name}-${width}.png`), fullPage: false });
}

test.describe('offer experience', () => {
  test('a viewed offer withdrawn by its provider is announced to the customer; the price field speaks lira; panels fit every width', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const leavingProvider = await createProvider({ categoryId: category.id, location, credits: STARTING_CREDITS });
    const stayingProvider = await createProvider({ categoryId: category.id, location, credits: STARTING_CREDITS });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const leaving = await Actor.open(browser, 'leaving-provider', primaryRuntime);
    const staying = await Actor.open(browser, 'staying-provider', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const requestId = await createRequest(customer, category, requestFormValues(location, customerAccount.name));
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);

      // ---- the provider's price field: lira in, kuruş on the wire ----------
      await leaving.loginToWeb(leavingProvider.email, leavingProvider.password);
      await openRequestAsProvider(leaving, leavingProvider.id, requestId);
      const price = leaving.page.getByTestId('offer-price-input');
      await price.fill('4500');
      await expect(price).toHaveValue('4.500');
      await price.blur();
      await expect(price).toHaveValue('4.500,00');
      // A letter and a second comma are not part of a number and never land.
      await price.fill('4500,5a');
      await expect(price).toHaveValue('4.500,5');
      await price.blur();
      await expect(price).toHaveValue('4.500,50');
      await price.fill('4.500,00');
      await leaving.page.locator('textarea[name="message"]').fill('Hemen başlayabiliriz.');
      await leaving.page.getByRole('button', { name: 'Teklifi Gönder' }).click();
      await expect(leaving.page.getByText('Bu talebe daha önce teklif gönderdiniz')).toBeVisible();
      await assertNoErrorScreen(leaving.page);

      const withdrawnOfferId = await readProviderOfferId(leaving, leavingProvider.id, requestId);
      const storedPrice = await prisma().offer.findUniqueOrThrow({
        where: { id: withdrawnOfferId },
        select: { priceAmount: true },
      });
      expect(storedPrice.priceAmount).toBe(450000);
      await expect(leaving.page.getByText('₺4.500,00').first()).toBeVisible();

      // The panel with the offer on it, at every width: the refund badge is
      // inside the card and nothing runs off the right edge.
      for (const width of WIDTHS) {
        await leaving.page.setViewportSize({ width, height: 1000 });
        await openRequestAsProvider(leaving, leavingProvider.id, requestId);
        expect(await overflowOf(leaving.page), `offer panel @ ${width}px`).toBeLessThanOrEqual(0);
        const badge = leaving.page.locator('.cdash-meta-list dd .pdash-badge', {
          hasText: 'Görüntülenme bekleniyor',
        });
        await expect(badge).toBeVisible();
        const [badgeBox, cardBox] = await Promise.all([
          badge.boundingBox(),
          badge.locator('xpath=ancestor::section[1]').boundingBox(),
        ]);
        expect(badgeBox && cardBox && badgeBox.x + badgeBox.width <= cardBox.x + cardBox.width + 0.5).toBe(true);
        await capture(leaving.page, 'provider-offer-panel', width);
      }
      await leaving.page.setViewportSize({ width: 1280, height: 900 });

      await staying.loginToWeb(stayingProvider.email, stayingProvider.password);
      await submitOffer(staying, {
        providerId: stayingProvider.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '3900,00',
        message: 'Montaj ve bakım dahil.',
      });
      const survivingOfferId = await readProviderOfferId(staying, stayingProvider.id, requestId);

      // ---- the customer opens the offer, then the provider takes it back ---
      await customer.gotoWeb(`/requests/${requestId}/offers/${withdrawnOfferId}`);
      await expect(customer.page.getByRole('button', { name: 'Kabul Et' })).toBeVisible();
      await expect(customer.page.getByTestId('offer-withdrawn-notice')).toHaveCount(0);
      const viewed = await prisma().offer.findUniqueOrThrow({ where: { id: withdrawnOfferId } });
      expect(viewed.viewedAt).not.toBeNull();
      expect(viewed.status).toBe('VIEWED');

      await leaving.gotoWeb(`/providers/${leavingProvider.id}/offers/${withdrawnOfferId}`);
      await leaving.page.getByTestId('withdraw-open').click();
      await leaving.page.getByTestId('withdraw-confirm').click();
      await expect(leaving.page.getByTestId('offer-status')).toHaveText('Geri çekildi');

      // ---- the list: one sentence on the withdrawn row, none on the live one --
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await assertNoErrorScreen(customer.page);
      const history = customer.page.getByTestId('withdrawn-offers');
      const row = history.locator('[data-testid="withdrawn-offer"]');
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute('data-viewed', 'true');
      await expect(row.getByTestId('offer-withdrawn-notice')).toHaveText(
        'Bu teklif hizmet veren tarafından iptal edilmiştir.',
      );
      const historyText = (await history.innerText()).toLowerCase();
      expect(historyText).not.toContain('iade');
      expect(historyText).not.toContain('kredi');
      expect(historyText).not.toContain('4.500,00');
      // The live offer is still a live offer.
      await expect(customer.page.getByRole('link', { name: 'Teklifi İncele' })).toHaveCount(1);
      await expect(customer.page.getByText('₺3.900,00')).toBeVisible();

      // ---- the detail: the sentence first, no way to accept ----------------
      await customer.gotoWeb(`/requests/${requestId}/offers/${withdrawnOfferId}`);
      await assertNoErrorScreen(customer.page);
      await expect(customer.page.getByTestId('offer-withdrawn-notice')).toHaveText(
        'Bu teklif hizmet veren tarafından iptal edilmiştir.',
      );
      await expect(customer.page.getByTestId('offer-status')).toHaveText('Geri çekildi');
      await expect(customer.page.getByRole('button', { name: 'Kabul Et' })).toHaveCount(0);
      await expect(customer.page.getByRole('button', { name: 'Reddet' })).toHaveCount(0);

      // The live one still can be accepted.
      await customer.gotoWeb(`/requests/${requestId}/offers/${survivingOfferId}`);
      await expect(customer.page.getByTestId('offer-withdrawn-notice')).toHaveCount(0);
      await expect(customer.page.getByRole('button', { name: 'Kabul Et' })).toBeVisible();

      // ---- "Tekliflerim": no horizontal scroll, the primary button on every row --
      // The staying provider's row is fully actionable (Talep + Geri çek +
      // detail); the leaving provider's withdrawn row has the detail only.
      for (const [actor, providerId, name] of [
        [staying, stayingProvider.id, 'offers-table-live'],
        [leaving, leavingProvider.id, 'offers-table-withdrawn'],
      ] as const) {
        for (const width of WIDTHS) {
          await actor.page.setViewportSize({ width, height: 1000 });
          await actor.gotoWeb(`/providers/${providerId}/offers`);
          await expect(actor.page.getByTestId('offers-table')).toBeVisible();
          expect(await overflowOf(actor.page), `${name} @ ${width}px (document)`).toBeLessThanOrEqual(0);
          expect(
            await innerOverflowOf(actor.page, '[data-testid="offers-table-wrap"]'),
            `${name} @ ${width}px (table wrapper)`,
          ).toBeLessThanOrEqual(0);
          const rows = actor.page.getByTestId('offer-row');
          await expect(rows).toHaveCount(1);
          await expect(rows.first().getByTestId('offer-row-detail-link')).toBeVisible();
          await capture(actor.page, name, width);
        }
      }
      const liveRow = staying.page.getByTestId('offer-row').first();
      await expect(liveRow.getByTestId('offer-row-request-link')).toBeVisible();
      await expect(liveRow.getByTestId('offer-row-withdraw-link')).toBeVisible();
      const withdrawnRow = leaving.page.getByTestId('offer-row').first();
      await expect(withdrawnRow.getByTestId('offer-row-request-link')).toBeVisible();
      await expect(withdrawnRow.getByTestId('offer-row-withdraw-link')).toHaveCount(0);
      await expect(withdrawnRow.getByTestId('offer-row-detail-link')).toBeVisible();
    } finally {
      await Promise.all([customer.close(), admin.close(), leaving.close(), staying.close()]);
    }
  });

  test('the price field refuses an empty or sub-lira amount before it is sent', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const providerAccount = await createProvider({ categoryId: category.id, location, credits: STARTING_CREDITS });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const requestId = await createRequest(customer, category, requestFormValues(location, customerAccount.name));
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);

      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await openRequestAsProvider(provider, providerAccount.id, requestId);
      const page = provider.page;
      const price = page.getByTestId('offer-price-input');

      // Empty: the browser's own "required" stops the submit.
      await fillOfferForm(provider, '', 'Boş fiyat denemesi.');
      await page.getByRole('button', { name: 'Teklifi Gönder' }).click();
      expect(await price.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);

      // Below one lira: a custom validity, the same sentence the budget uses.
      await price.fill('0,50');
      await page.getByRole('button', { name: 'Teklifi Gönder' }).click();
      expect(await price.evaluate((el: HTMLInputElement) => el.validationMessage)).toBe('En az 1,00 TL girin.');

      // A minus sign is not part of a number here.
      await price.fill('-1500');
      await expect(price).toHaveValue('1.500');

      expect(await prisma().offer.count({ where: { requestId } })).toBe(0);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });
});
