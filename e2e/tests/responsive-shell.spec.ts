import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { Actor } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createEntitlement,
  createOfferPackage,
  createProvider,
  recordCreditTransaction,
  uniqueLocation,
} from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * The three panel shells on a phone.
 *
 * All three were built as a fixed sidebar beside a wide main column. The admin
 * panel already turned its sidebar into a drawer; the customer and provider
 * panels did not — below 900px the aside simply became `flex-basis: 100%`, so a
 * phone opened the panel onto a full-width column of brand, credit box and
 * eight nav items and put the screen that was actually asked for underneath all
 * of it, with the page overflowing sideways on top.
 *
 * What is asserted here is the contract, not the styling: at every width a
 * phone actually reports, the document is no wider than the viewport, the first
 * thing on screen is the screen, and the navigation is reachable through a
 * drawer that opens, traps nothing it should not, and closes on Escape. The
 * desktop case is here for the same reason — the two-column layout at 1280px is
 * what these changes must not have touched.
 */

/** The widths in the brief: iPhone SE through iPhone Plus, plus a 320px floor. */
const MOBILE_WIDTHS = [320, 360, 375, 390, 414] as const;
/** The three the brief names for the content case, a subset of the above. */
const CONTENT_WIDTHS = [320, 375, 390] as const;
const DESKTOP = { width: 1280, height: 900 } as const;

const SHOTS = resolve(artifactsDir, 'responsive');

const CATEGORY_COST = 2;
const STARTING_CREDITS = 69;

/**
 * The measurement the brief names: nothing may make the document wider than the
 * window it is in. `scrollWidth` on the documentElement is the whole page, so a
 * card, a table or a grid track that sticks out anywhere is caught here rather
 * than only where somebody thought to look.
 */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/**
 * The elements that are actually sticking out, if any. Only used to make a
 * failure readable — an assertion that says "the page is 84px too wide" and
 * nothing else is a bug report you have to start over from.
 */
async function overflowingSelectors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = window.innerWidth;
    const names: string[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.right <= limit + 1) continue;
      // A scroll container is allowed to hold something wider than itself; that
      // is the point of it. What matters is whether it lets the page scroll.
      const style = getComputedStyle(element);
      if (style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'hidden') continue;
      const id = element.id ? `#${element.id}` : '';
      const cls = element.className && typeof element.className === 'string'
        ? `.${element.className.trim().split(/\s+/).join('.')}`
        : '';
      names.push(`${element.tagName.toLowerCase()}${id}${cls} (right: ${Math.round(box.right)})`);
      if (names.length >= 8) break;
    }
    return names;
  });
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await horizontalOverflow(page);
  if (overflow > 0) {
    const culprits = await overflowingSelectors(page);
    throw new Error(
      `${label}: the page is ${overflow}px wider than the viewport.\n` +
        (culprits.length ? `Overflowing: ${culprits.join('\n            ')}` : 'No single element found; check a grid track or a min-width.'),
    );
  }
  expect(overflow, label).toBeLessThanOrEqual(0);
}

/**
 * The content the person asked for is on the first screen, not below a menu.
 * Measured against the viewport rather than the document: an element pushed to
 * y=900 on a 320×640 phone is off screen no matter how tall the page is.
 */
async function expectVisibleWithoutScrolling(page: Page, selector: string, label: string) {
  const top = await page.locator(selector).first().evaluate((element) => element.getBoundingClientRect().top);
  expect(top, `${label}: "${selector}" starts ${Math.round(top)}px down, below the first screen`).toBeLessThan(
    600,
  );
}

/**
 * An open drawer has finished sliding in. The transform animates over 200ms, so
 * without this both the screenshots and any geometry assertion would be reading
 * a frame from the middle of it — which is how the first run produced a drawer
 * apparently hanging 95px off the left edge of the screen.
 */
async function expectDrawerFullyOpen(page: Page, selector: string, label: string) {
  await expect
    .poll(
      () => page.locator(selector).evaluate((element) => Math.round(element.getBoundingClientRect().left)),
      { message: `${label}: the drawer never reached the left edge` },
    )
    .toBe(0);
}

/**
 * A specific element is inside the viewport on both sides.
 *
 * The page-level overflow check above is the headline, but it only says the
 * document is not too wide. An element can be clipped by an ancestor's
 * `overflow: hidden` and never widen the document while still being half off
 * the screen, which is its own defect and the one worth naming per element.
 */
async function expectWithinViewport(page: Page, selector: string, label: string) {
  const box = await page.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
  });
  const limit = page.viewportSize()?.width ?? 0;

  expect(box.width, `${label}: "${selector}" has no width`).toBeGreaterThan(0);
  expect(box.left, `${label}: "${selector}" starts ${box.left}px off the left edge`).toBeGreaterThanOrEqual(-1);
  expect(box.right, `${label}: "${selector}" ends ${box.right - limit}px past the right edge`).toBeLessThanOrEqual(
    limit + 1,
  );
}

test.describe('panel shells on a phone', () => {
  test('the provider panel fits, opens and closes at every phone width', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const account = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });

    for (const width of MOBILE_WIDTHS) {
      const provider = await Actor.open(browser, `provider-${width}`, primaryRuntime, {
        viewport: { width, height: 780 },
      });

      try {
        await provider.loginToWeb(account.email, account.password);
        // The screen from the recording: the provider's credits and packages.
        await provider.gotoWeb(`/providers/${account.id}/credits`);
        await expect(provider.page.locator('.pdash-shell')).toBeVisible();

        await expectNoHorizontalOverflow(provider.page, `provider credits @${width}`);

        // The drawer is shut, so the sidebar is out of the tab order entirely.
        const drawer = provider.page.locator('#pdash-drawer');
        await expect(drawer).toBeHidden();

        const toggle = provider.page.getByTestId('panel-drawer-toggle');
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');

        // The screen itself is on the first screen, not under the navigation.
        await expectVisibleWithoutScrolling(
          provider.page,
          '.pdash-main > *:nth-child(2)',
          `provider credits @${width}`,
        );

        await provider.page.screenshot({
          path: resolve(SHOTS, `provider-credits-${width}.png`),
          fullPage: false,
        });

        // Open it: the nav is reachable, and the page still does not widen.
        await toggle.click();
        await expect(drawer).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expectDrawerFullyOpen(provider.page, '#pdash-drawer', `provider @${width}`);
        await expect(provider.page.getByRole('link', { name: /Krediler/ })).toBeVisible();
        await expectNoHorizontalOverflow(provider.page, `provider drawer open @${width}`);

        if (width === 375) {
          await provider.page.screenshot({
            path: resolve(SHOTS, 'provider-credits-375-drawer-open.png'),
            fullPage: false,
          });
        }

        // Escape closes it and hands focus back to the control that opened it.
        await provider.page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(toggle).toBeFocused();
      } finally {
        await provider.close();
      }
    }
  });

  test('the customer panel fits, opens and closes at every phone width', async ({ browser }) => {
    const account = await createCustomer();

    for (const width of MOBILE_WIDTHS) {
      const customer = await Actor.open(browser, `customer-${width}`, primaryRuntime, {
        viewport: { width, height: 780 },
      });

      try {
        await customer.loginToWeb(account.email, account.password);
        await customer.gotoWeb('/requests/my');
        await expect(customer.page.locator('.cdash-shell')).toBeVisible();

        await expectNoHorizontalOverflow(customer.page, `customer dashboard @${width}`);

        const drawer = customer.page.locator('#cdash-drawer');
        await expect(drawer).toBeHidden();

        const toggle = customer.page.getByTestId('panel-drawer-toggle');
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');

        await expectVisibleWithoutScrolling(
          customer.page,
          '.cdash-main > *:nth-child(2)',
          `customer dashboard @${width}`,
        );

        await customer.page.screenshot({
          path: resolve(SHOTS, `customer-dashboard-${width}.png`),
          fullPage: false,
        });

        await toggle.click();
        await expect(drawer).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expectDrawerFullyOpen(customer.page, '#cdash-drawer', `customer @${width}`);
        await expect(customer.page.getByRole('link', { name: /Taleplerim/ })).toBeVisible();
        await expectNoHorizontalOverflow(customer.page, `customer drawer open @${width}`);

        if (width === 375) {
          await customer.page.screenshot({
            path: resolve(SHOTS, 'customer-dashboard-375-drawer-open.png'),
            fullPage: false,
          });
        }

        await customer.page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
        await expect(toggle).toBeFocused();
      } finally {
        await customer.close();
      }
    }
  });

  test('the admin panel fits, opens and closes at every phone width', async ({ browser }) => {
    const account = await createAdmin();

    for (const width of MOBILE_WIDTHS) {
      const admin = await Actor.open(browser, `admin-${width}`, primaryRuntime, {
        viewport: { width, height: 780 },
      });

      try {
        await admin.loginToAdmin(account.email, account.password);
        await admin.gotoAdmin('/');
        await expect(admin.page.locator('.admin-shell')).toBeVisible();

        await expectNoHorizontalOverflow(admin.page, `admin dashboard @${width}`);

        const drawer = admin.page.locator('#admin-sidebar');
        await expect(drawer).toBeHidden();

        const toggle = admin.page.getByTestId('panel-drawer-toggle');
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');

        await expectVisibleWithoutScrolling(admin.page, '.admin-content', `admin dashboard @${width}`);

        await admin.page.screenshot({
          path: resolve(SHOTS, `admin-dashboard-${width}.png`),
          fullPage: false,
        });

        await toggle.click();
        await expect(drawer).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expectDrawerFullyOpen(admin.page, '#admin-sidebar', `admin @${width}`);
        await expectNoHorizontalOverflow(admin.page, `admin drawer open @${width}`);

        if (width === 375) {
          await admin.page.screenshot({
            path: resolve(SHOTS, 'admin-dashboard-375-drawer-open.png'),
            fullPage: false,
          });
        }

        await admin.page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
        await expect(toggle).toBeFocused();
      } finally {
        await admin.close();
      }
    }
  });

  /**
   * The screen in the bug recording, with the content that was actually on it.
   *
   * The case above proves the shell: it signs in a provider who has never
   * bought anything, so the credits screen renders its emptiest form — no
   * package bar, no counters, no catalogue. The recording showed the opposite:
   * a 50-credit package with 69 left of it, a full progress bar, a "69 / 50"
   * counter, spent and refunded totals, and a grid of purchasable packages
   * underneath. None of that was under test, so nothing stopped the real
   * overflow from coming back.
   *
   * The ledger below is the recording's, row for row: grant 30, buy 50, spend
   * 15, refund 4 — which lands on a balance of 69 against a last purchase of
   * 50, and on "Harcanan 15 / İade edilen 4 / Son yükleme 50" beneath it.
   */
  test('the provider credits screen fits with an active package and a full ledger', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const account = await createProvider({ categoryId: category.id, location, credits: 30 });

    await recordCreditTransaction({
      providerId: account.id,
      type: 'PACKAGE_PURCHASE',
      amount: 50,
      reason: 'E2E paket alımı',
    });
    await recordCreditTransaction({ providerId: account.id, type: 'OFFER_SPEND', amount: -15 });
    await recordCreditTransaction({ providerId: account.id, type: 'OFFER_REFUND', amount: 4 });

    // The catalogue under the panel: three cards with prices, a note field and
    // a submit button each, which is the widest content on the screen.
    for (const credits of [25, 50, 100]) {
      await createOfferPackage({
        type: 'ONE_TIME_CREDITS',
        name: 'E2E Kredi Paketi',
        creditAmount: credits,
        priceAmount: credits * 4_900,
      });
    }

    // And a period the provider already holds, so "Paketlerim" has the long
    // remaining-quota counter on it rather than an empty state.
    const quotaPackage = await createOfferPackage({
      type: 'MONTHLY_QUOTA',
      name: 'E2E Aylık Kota',
      quotaCredits: 120,
    });
    await createEntitlement({
      providerId: account.id,
      packageId: quotaPackage.id,
      packageName: quotaPackage.name,
      type: 'MONTHLY_QUOTA',
      quotaCredits: 120,
      remainingQuota: 87,
    });

    for (const width of CONTENT_WIDTHS) {
      const provider = await Actor.open(browser, `credits-${width}`, primaryRuntime, {
        viewport: { width, height: 780 },
      });

      try {
        await provider.loginToWeb(account.email, account.password);
        await provider.gotoWeb(`/providers/${account.id}/credits`);

        // The fixture really did reproduce the recording — if this drifts, the
        // widths below are measuring some other screen.
        await expect(provider.page.locator('.credit-bar-head')).toContainText('69 / 50');

        await expectNoHorizontalOverflow(provider.page, `credits content @${width}`);
        await expectVisibleWithoutScrolling(
          provider.page,
          '.pdash-page-title',
          `credits content @${width}`,
        );

        // Every piece the recording showed, each measured on its own.
        await expectWithinViewport(provider.page, '.credit-panel', `credits @${width}`);
        await expectWithinViewport(provider.page, '.databar', `progress bar @${width}`);
        await expectWithinViewport(provider.page, '.credit-bar-head', `69 / 50 counter @${width}`);
        await expectWithinViewport(provider.page, '.credit-balance', `balance @${width}`);
        await expectWithinViewport(provider.page, '.credit-panel-foot', `metric row @${width}`);
        await expectWithinViewport(provider.page, '.pkg-grid', `package grid @${width}`);
        await expectWithinViewport(provider.page, '.pkg-card', `package card @${width}`);

        const cta = provider.page.locator('.credit-panel').getByRole('link', { name: /Kredi yükle/ });
        await expect(cta).toBeVisible();
        await expectWithinViewport(
          provider.page,
          '.credit-panel .pdash-btn-block',
          `Kredi yükle CTA @${width}`,
        );

        // The catalogue is really on the page, so the two assertions above are
        // measuring cards rather than passing on an empty grid.
        expect(await provider.page.locator('.pkg-card').count(), `packages @${width}`).toBeGreaterThan(0);

        if (width === 375) {
          await provider.page.screenshot({
            path: resolve(SHOTS, 'provider-credits-content-375.png'),
            fullPage: false,
          });
          await provider.page.screenshot({
            path: resolve(SHOTS, 'provider-credits-content-375-full.png'),
            fullPage: true,
          });
        }

        // The drawer still behaves with this much content behind it.
        const drawer = provider.page.locator('#pdash-drawer');
        const toggle = provider.page.getByTestId('panel-drawer-toggle');
        await expect(drawer).toBeHidden();
        await toggle.click();
        await expect(drawer).toBeVisible();
        await expectDrawerFullyOpen(provider.page, '#pdash-drawer', `credits @${width}`);
        await expectNoHorizontalOverflow(provider.page, `credits drawer open @${width}`);
        await provider.page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
        await expect(toggle).toBeFocused();

        // "Paketlerim": the held period and its remaining-quota counter, which
        // is the longest single string either screen renders.
        await provider.gotoWeb(`/providers/${account.id}/subscriptions`);
        await expect(provider.page.locator('.pkg-credits').first()).toContainText('87');
        await expect(provider.page.locator('.pkg-credits').first()).toContainText('120 kredi kaldı');
        await expectNoHorizontalOverflow(provider.page, `subscriptions @${width}`);
        await expectWithinViewport(provider.page, '.pkg-credits', `quota counter @${width}`);

        if (width === 375) {
          await provider.page.screenshot({
            path: resolve(SHOTS, 'provider-subscriptions-375.png'),
            fullPage: false,
          });
        }
      } finally {
        await provider.close();
      }
    }
  });

  /**
   * The regression half. At 1280px every rule added for the drawer is out of
   * range, so the sidebar is a column of the layout again and no hamburger
   * exists to press.
   */
  test('the desktop layout is unchanged at 1280px', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();

    const provider = await Actor.open(browser, 'provider-desktop', primaryRuntime, { viewport: DESKTOP });
    const customer = await Actor.open(browser, 'customer-desktop', primaryRuntime, { viewport: DESKTOP });
    const admin = await Actor.open(browser, 'admin-desktop', primaryRuntime, { viewport: DESKTOP });

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb(`/providers/${providerAccount.id}/credits`);
      // Visible without opening anything, and beside the content rather than
      // over it: a drawer would be at x=0 with the main column underneath.
      await expect(provider.page.locator('#pdash-drawer')).toBeVisible();
      await expect(provider.page.getByTestId('panel-drawer-toggle')).toBeHidden();
      await expectNoHorizontalOverflow(provider.page, 'provider credits @1280');
      await provider.page.screenshot({ path: resolve(SHOTS, 'provider-credits-1280.png') });

      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoWeb('/requests/my');
      await expect(customer.page.locator('#cdash-drawer')).toBeVisible();
      await expect(customer.page.getByTestId('panel-drawer-toggle')).toBeHidden();
      await expectNoHorizontalOverflow(customer.page, 'customer dashboard @1280');
      await customer.page.screenshot({ path: resolve(SHOTS, 'customer-dashboard-1280.png') });

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/');
      await expect(admin.page.locator('#admin-sidebar')).toBeVisible();
      await expect(admin.page.getByTestId('panel-drawer-toggle')).toBeHidden();
      await expectNoHorizontalOverflow(admin.page, 'admin dashboard @1280');
      await admin.page.screenshot({ path: resolve(SHOTS, 'admin-dashboard-1280.png') });
    } finally {
      await provider.close();
      await customer.close();
      await admin.close();
    }
  });
});
