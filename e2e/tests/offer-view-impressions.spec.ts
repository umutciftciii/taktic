import { expect, test, type Locator, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCategory, createCustomer, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { seedOffer } from '../src/offer-fixtures';
import { seedCustomerRequest } from '../src/request-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * OFFER-VIEW-001: an offer counts as viewed when the customer's screen really
 * showed its price and content — on the list, in the comparison table or on
 * its detail — and not because the page holding it was opened.
 *
 * - **Only what was on screen.** Opening the list stamps the cards at least
 *   half visible for a second, and none below the fold; a card scrolled past
 *   quickly, or shown while the tab was in the background, does not count.
 * - **The comparison table counts by its amount cell.** On a phone the table
 *   scrolls sideways, and a column off to the right is not counted until it
 *   is scrolled into view.
 * - **A failed report is retried,** and the screen never shows it.
 * - **History is not a view (A-1),** and neither is a look after the refund
 *   moment (A-2): opening a closed rival, or an offer whose window is over,
 *   leaves `viewedAt` empty.
 * - **A prefetch of the detail page is not a view.**
 */

const DWELL_MS = 1000;
/** Comfortably past the dwell time plus the batch delay. */
const SETTLE_MS = 2500;

/** The item at `index` (negative counts from the end), or a failed test. */
function at<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) {
    throw new Error(`no item at ${index} of ${items.length}`);
  }
  return item;
}

async function viewedAt(offerId: string) {
  const offer = await prisma().offer.findUniqueOrThrow({ where: { id: offerId }, select: { viewedAt: true } });
  return offer.viewedAt;
}

async function expectViewed(offerId: string, label: string) {
  await expect.poll(() => viewedAt(offerId), { message: `${label} viewed`, timeout: 15_000 }).not.toBeNull();
}

async function expectNotViewedAfterSettling(page: Page, offerId: string, label: string) {
  await page.waitForTimeout(SETTLE_MS);
  expect(await viewedAt(offerId), `${label} not viewed`).toBeNull();
}

/** Whether at least half of an element is inside the viewport right now. */
async function halfVisible(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    return rect.width > 0 && rect.height > 0 && (width * height) / (rect.width * rect.height) >= 0.5;
  });
}

function card(page: Page, offerId: string) {
  return page.locator(`article[data-impression-offer-id="${offerId}"]`);
}

function amountCell(page: Page, offerId: string) {
  return page.locator(`td[data-impression-offer-id="${offerId}"]`);
}

/** Puts the page's tab in the background, or back, as far as the page can tell. */
async function setTabVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

async function seedScene(offerCount: number, refund: 'pending' | 'eligible' = 'pending') {
  const location = uniqueLocation();
  const category = await createCategory(2);
  const customer = await createCustomer();
  const serviceRequest = await seedCustomerRequest({
    customerId: customer.id,
    categoryId: category.id,
    location,
    content: 'empty',
    phoneVerifiedAt: new Date(),
  });
  const offerIds: string[] = [];
  for (let index = 0; index < offerCount; index += 1) {
    const provider = await createProvider({ categoryId: category.id, location, credits: 10 });
    const offer = await seedOffer({
      requestId: serviceRequest.id,
      providerId: provider.id,
      creditCost: 2,
      // Distinct amounts, so the list's price order is the seeding order.
      priceAmount: 100_000 + index * 10_000,
      refund,
    });
    offerIds.push(offer.id);
  }
  return { customer, requestId: serviceRequest.id, offerIds };
}

test.describe('offer view semantics', () => {
  test('the list counts only cards shown for a second in the foreground; a failed report is retried', async ({
    browser,
  }) => {
    const { customer: account, requestId, offerIds } = await seedScene(8);
    const customer = await Actor.open(browser, 'customer', primaryRuntime, { viewport: { width: 1280, height: 560 } });

    // The first report fails once; the screen must try again by itself.
    let failuresLeft = 1;
    await customer.page.route('**/api/requests/*/offer-impressions', async (route) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        await route.fulfill({ status: 503, body: '{"error":"unreachable"}', contentType: 'application/json' });
        return;
      }
      await route.continue();
    });

    try {
      await customer.loginToWeb(account.email, account.password);
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(card(customer.page, at(offerIds, 0))).toBeAttached();
      await assertNoErrorScreen(customer.page);

      // Opening the page shows nothing that is below the fold.
      const atLoad = await Promise.all(offerIds.map((offerId) => halfVisible(card(customer.page, offerId))));
      await customer.page.waitForTimeout(SETTLE_MS);
      for (const [index, offerId] of offerIds.entries()) {
        if (!atLoad[index]) {
          expect(await viewedAt(offerId), `below the fold at load ${offerId}`).toBeNull();
        }
      }

      // Bring the list's top to the screen: what is on it now counts, the rest
      // does not.
      await card(customer.page, at(offerIds, 0)).evaluate((element) => element.scrollIntoView({ block: 'start' }));
      const onScreen = await Promise.all(offerIds.map((offerId) => halfVisible(card(customer.page, offerId))));
      const shown = offerIds.filter((_, index) => onScreen[index]);
      const offscreen = offerIds.filter((_, index) => !onScreen[index]);
      expect(shown.length, 'the first card is on screen').toBeGreaterThanOrEqual(1);
      expect(offscreen.length, 'the last cards are below the fold').toBeGreaterThanOrEqual(2);

      for (const offerId of shown) {
        await expectViewed(offerId, `card shown at load ${offerId}`);
      }
      for (const offerId of offscreen) {
        expect(await viewedAt(offerId), `offscreen ${offerId}`).toBeNull();
      }
      expect(failuresLeft, 'the failed report was retried').toBe(0);

      // A card scrolled past in less than a second is not counted.
      const quick = at(offscreen, -2);
      const slow = at(offscreen, -1);
      await card(customer.page, quick).scrollIntoViewIfNeeded();
      await customer.page.waitForTimeout(DWELL_MS / 4);
      await card(customer.page, at(offerIds, 0)).evaluate((element) => element.scrollIntoView({ block: 'start' }));
      await expectNotViewedAfterSettling(customer.page, quick, 'quick scroll');

      // Nor is one on screen while the tab is in the background…
      await setTabVisibility(customer.page, 'hidden');
      await card(customer.page, slow).scrollIntoViewIfNeeded();
      await expectNotViewedAfterSettling(customer.page, slow, 'background tab');

      // …until the tab comes back and it stays a second.
      await setTabVisibility(customer.page, 'visible');
      await expectViewed(slow, 'card in the foreground');
      expect((await prisma().offer.findUniqueOrThrow({ where: { id: slow } })).status).toBe('VIEWED');
    } finally {
      await customer.close();
    }
  });

  test('the comparison table on a phone counts the amount cell that is actually on screen', async ({ browser }) => {
    const { customer: account, requestId, offerIds } = await seedScene(4);
    const customer = await Actor.open(browser, 'customer', primaryRuntime, {
      viewport: { width: 390, height: 844 },
      isMobile: browser.browserType().name() !== 'firefox',
      hasTouch: true,
    });

    try {
      await customer.loginToWeb(account.email, account.password);
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      // Straight to the table, before any card had its second on the list.
      await customer.page.getByRole('tab', { name: 'Karşılaştırma tablosu' }).click();
      const table = customer.page.locator('.compare-table');
      await expect(table).toBeVisible();
      await table.scrollIntoViewIfNeeded();
      await customer.page.waitForTimeout(SETTLE_MS);

      const visibleNow = await Promise.all(offerIds.map((offerId) => halfVisible(amountCell(customer.page, offerId))));
      const hiddenColumns = offerIds.filter((_, index) => !visibleNow[index]);
      expect(hiddenColumns.length, 'some columns start off to the right').toBeGreaterThanOrEqual(1);
      for (const [index, offerId] of offerIds.entries()) {
        if (visibleNow[index]) {
          await expectViewed(offerId, `column on screen ${offerId}`);
        } else {
          expect(await viewedAt(offerId), `column off screen ${offerId}`).toBeNull();
        }
      }

      // Scrolling the table sideways brings the last column in, and it counts.
      const last = at(hiddenColumns, -1);
      await amountCell(customer.page, last).scrollIntoViewIfNeeded();
      expect(await halfVisible(amountCell(customer.page, last))).toBe(true);
      await expectViewed(last, 'column scrolled into view');
    } finally {
      await customer.close();
    }
  });

  test('a closed rival and an offer past its refund moment stay unviewed, from the list and from the detail (A-1, A-2)', async ({
    browser,
  }) => {
    const { customer: account, requestId, offerIds } = await seedScene(1);
    const live = at(offerIds, 0);
    const location = uniqueLocation();
    const extraCategory = await prisma().serviceRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { categoryId: true },
    });
    const rivalProvider = await createProvider({ categoryId: extraCategory.categoryId, location, credits: 10 });
    const lateProvider = await createProvider({ categoryId: extraCategory.categoryId, location, credits: 10 });
    const rival = await seedOffer({
      requestId,
      providerId: rivalProvider.id,
      creditCost: 2,
      priceAmount: 120_000,
      status: 'REJECTED',
      refund: 'pending',
    });
    const late = await seedOffer({
      requestId,
      providerId: lateProvider.id,
      creditCost: 2,
      priceAmount: 130_000,
      refund: 'eligible',
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime, { viewport: { width: 1280, height: 2000 } });
    try {
      await customer.loginToWeb(account.email, account.password);
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      for (const offerId of [live, rival.id, late.id]) {
        await expect(card(customer.page, offerId)).toBeVisible();
      }
      await expectViewed(live, 'live offer on the list');
      await customer.page.waitForTimeout(SETTLE_MS);
      expect(await viewedAt(rival.id), 'closed rival on the list').toBeNull();
      expect(await viewedAt(late.id), 'offer past its refund moment on the list').toBeNull();

      for (const offerId of [rival.id, late.id]) {
        await customer.gotoWeb(`/requests/${requestId}/offers/${offerId}`);
        await assertNoErrorScreen(customer.page);
        await expect(customer.page.getByRole('link', { name: 'Tekliflere dön' })).toBeVisible();
        expect(await viewedAt(offerId), `detail of ${offerId}`).toBeNull();
      }
      const lateRow = await prisma().offer.findUniqueOrThrow({ where: { id: late.id }, select: { status: true } });
      expect(lateRow.status).toBe('SUBMITTED');
    } finally {
      await customer.close();
    }
  });

  test('a prefetch of the detail page is not a view; opening it is', async ({ browser }) => {
    const { customer: account, requestId, offerIds } = await seedScene(1);
    const offerId = at(offerIds, 0);
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(account.email, account.password);
      // Stay off the list: its card would count on its own.
      await customer.gotoWeb('/requests/my');

      // The request the router sends when it prefetches a link.
      const status = await customer.page.evaluate(async (path) => {
        const response = await fetch(path, { headers: { RSC: '1', 'Next-Router-Prefetch': '1' } });
        await response.text();
        return response.status;
      }, `/requests/${requestId}/offers/${offerId}`);
      expect(status).toBeLessThan(500);
      await customer.page.waitForTimeout(SETTLE_MS);
      expect(await viewedAt(offerId), 'after a prefetch').toBeNull();

      await customer.gotoWeb(`/requests/${requestId}/offers/${offerId}`);
      await expect(customer.page.getByRole('button', { name: 'Kabul Et' })).toBeVisible();
      expect(await viewedAt(offerId), 'after opening the detail').not.toBeNull();
    } finally {
      await customer.close();
    }
  });
});
