import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCategory, createProvider, uniqueLocation } from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

const SHOTS = resolve(artifactsDir, 'admin-design', 'faz-4');

/**
 * ADMIN-DESIGN-001 Faz 4 — the keyboard and assistive-technology half of the
 * cross-screen audit.
 *
 * The shell and the shared components each have their own spec; what is
 * pinned here is what only shows up across screens, and the defects the audit
 * found and fixed:
 * - every list screen has one <main>, one <h1>, and no form field without a
 *   name a screen reader can read out;
 * - "Ana içeriğe geç" is the first stop and lands in the content;
 * - the phone drawer, while open, makes the page behind it `inert`;
 * - the two in-page tablists (credit operation, ledger filter) move with the
 *   arrow keys and keep a single Tab stop;
 * - a window at a URL (RouteDialog) starts on its first field and gives focus
 *   back to the link that opened it when Esc closes it.
 */

const LIST_SCREENS = [
  '/',
  '/requests',
  '/requests/reports',
  '/offers',
  '/refund-scan',
  '/providers',
  '/customers',
  '/support',
  '/finance',
  '/finance/credit-ledger',
  '/finance/manual-adjustments',
  '/finance/providers',
  '/package-purchases',
  '/package-refunds',
  '/showcase/reviews',
  '/showcase/placements',
  '/showcase/leads',
  '/showcase/cards',
  '/showcase/price-terms',
  '/showcase/packages',
  '/provider-reviews/reports',
  '/categories',
  '/categories/new',
  '/credit-packages',
  '/credit-packages/new',
  '/operations-settings',
  '/campaigns',
  '/campaigns/new',
  '/promotion-eligibility',
  '/notifications',
  '/users',
  '/users/new',
  '/roles',
  '/company-settings',
  '/seo',
  '/seo/indexing',
  '/seo/slugs',
  '/seo/redirects',
];

type Structure = { mains: number; h1s: string[]; unnamed: string[] };

async function readStructure(page: Page): Promise<Structure> {
  return page.evaluate(() => {
    const unnamed: string[] = [];
    const fields = Array.from(
      document.querySelectorAll<HTMLElement>('input:not([type="hidden"]), select, textarea'),
    );
    for (const field of fields) {
      const style = getComputedStyle(field);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const id = field.getAttribute('id');
      const named =
        Boolean(field.getAttribute('aria-label')?.trim()) ||
        Boolean(field.getAttribute('aria-labelledby')) ||
        Boolean(field.closest('label')) ||
        Boolean(id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) ||
        Boolean(field.getAttribute('title')?.trim());
      if (!named) {
        unnamed.push(`${field.tagName.toLowerCase()}[name=${field.getAttribute('name') ?? '?'}]`);
      }
    }
    return {
      mains: document.querySelectorAll('main').length,
      h1s: Array.from(document.querySelectorAll('h1')).map((h) => h.textContent?.trim() ?? ''),
      unnamed,
    };
  });
}

async function openAsSuper(browser: Parameters<typeof Actor.open>[0], viewport?: { width: number; height: number }) {
  const account = await createAdmin();
  const actor = await Actor.open(browser, 'a11y', primaryRuntime, viewport ? { viewport } : undefined);
  await actor.loginToAdmin(account.email, account.password);
  return actor;
}

/** Hydrated: React has attached its handlers (see admin-system-screens). */
async function waitForHydration(page: Page, selector: string) {
  await expect
    .poll(() =>
      page
        .locator(selector)
        .first()
        .evaluate((element) => Object.keys(element).some((name) => name.startsWith('__react'))),
    )
    .toBe(true);
}

test.describe('admin accessibility (ADMIN-DESIGN-001 Faz 4)', () => {
  test('every list screen: one main, one h1, and every field has a name', async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await openAsSuper(browser);

    try {
      const problems: string[] = [];
      for (const path of LIST_SCREENS) {
        await admin.gotoAdmin(path);
        await assertNoErrorScreen(admin.page);
        const { mains, h1s, unnamed } = await readStructure(admin.page);
        if (mains !== 1) problems.push(`${path}: ${mains} <main>`);
        if (h1s.length !== 1) problems.push(`${path}: ${h1s.length} <h1> (${h1s.join(' | ')})`);
        if (unnamed.length > 0) problems.push(`${path}: unnamed ${unnamed.join(', ')}`);
      }
      expect(problems).toEqual([]);
    } finally {
      await admin.close();
    }
  });

  test('"Ana içeriğe geç" is the first stop and moves into the content', async ({ browser, browserName }) => {
    const admin = await openAsSuper(browser, { width: 1440, height: 900 });

    try {
      await admin.gotoAdmin('/requests');
      const skip = admin.page.getByRole('link', { name: 'Ana içeriğe geç' });
      await expect(skip).toHaveCount(1);
      if (browserName === 'chromium') {
        // WebKit, like Safari, leaves links out of the Tab order by default.
        await admin.page.locator('body').focus();
        await admin.page.keyboard.press('Tab');
      } else {
        await admin.page.keyboard.press('Shift');
        await skip.focus();
      }
      await expect(skip).toBeFocused();
      // Visible once focused, inside the window.
      const box = await skip.boundingBox();
      expect(box && box.width > 20 && box.x >= 0 && box.y >= 0).toBe(true);

      await admin.page.keyboard.press('Enter');
      await expect
        .poll(() => admin.page.evaluate(() => document.getElementById('admin-content')?.contains(document.activeElement) ?? false))
        .toBe(true);
      // Focusable for the jump only: once focus moves on, the content column
      // is not a focus target again (a permanent one swallowed WebKit clicks).
      await admin.page.getByRole('heading', { level: 1 }).click();
      await admin.page.keyboard.press('Tab');
      await expect(admin.page.locator('#admin-content')).not.toHaveAttribute('tabindex', /.*/);
    } finally {
      await admin.close();
    }
  });

  test('the open phone drawer makes the page behind it inert', async ({ browser }) => {
    const admin = await openAsSuper(browser, { width: 390, height: 844 });

    try {
      await admin.gotoAdmin('/customers');
      const main = admin.page.locator('.admin-main');
      await expect(main).not.toHaveAttribute('inert', /.*/);
      await admin.page.getByTestId('panel-drawer-toggle').click();
      await expect(main).toHaveAttribute('inert', /.*/);
      // Only the drawer's own navigation is exposed while it is open.
      await expect(admin.page.getByRole('navigation', { name: 'Admin navigasyonu' })).toBeVisible();
      await admin.page.keyboard.press('Escape');
      await expect(main).not.toHaveAttribute('inert', /.*/);
      await expect(admin.page.getByTestId('panel-drawer-toggle')).toBeFocused();
    } finally {
      await admin.close();
    }
  });

  test('the credit tablists keep one Tab stop and move with the arrow keys', async ({ browser }) => {
    const category = await createCategory(3);
    const provider = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 5 });
    const admin = await openAsSuper(browser);

    try {
      await admin.gotoAdmin(`/providers/${provider.id}/credits`);
      await assertNoErrorScreen(admin.page);
      const form = admin.page.locator('form.credit-operation-form');
      const grant = form.getByRole('tab', { name: 'Kredi ekle' });
      const deduct = form.getByRole('tab', { name: 'Kredi düş' });
      await waitForHydration(admin.page, 'form.credit-operation-form [role="tab"]');

      await expect(grant).toHaveAttribute('aria-selected', 'true');
      await expect(grant).toHaveAttribute('tabindex', '0');
      await expect(deduct).toHaveAttribute('tabindex', '-1');

      await grant.focus();
      await admin.page.keyboard.press('ArrowRight');
      await expect(deduct).toBeFocused();
      await expect(deduct).toHaveAttribute('aria-selected', 'true');
      await expect(deduct).toHaveAttribute('tabindex', '0');
      await expect(form.getByRole('button', { name: 'Kredi düş' })).toBeVisible();
      await admin.page.keyboard.press('Home');
      await expect(grant).toBeFocused();
      await expect(grant).toHaveAttribute('aria-selected', 'true');

      // The ledger filter: one stop, End reaches the last filter.
      const filters = admin.page.getByRole('tablist', { name: 'İşlem filtresi' }).getByRole('tab');
      await expect(filters.first()).toHaveAttribute('aria-selected', 'true');
      expect(await filters.evaluateAll((tabs) => tabs.filter((tab) => tab.getAttribute('tabindex') === '0').length)).toBe(1);
      await filters.first().focus();
      await admin.page.keyboard.press('End');
      await expect(filters.last()).toBeFocused();
      await expect(filters.last()).toHaveAttribute('aria-selected', 'true');

      // The two raw tables on this screen are named, scrollable regions.
      await expect(admin.page.getByRole('region', { name: 'Kredi işlemleri' })).toHaveCount(
        (await admin.page.locator('.transaction-table').count()) > 0 ? 1 : 0,
      );
    } finally {
      await admin.close();
    }
  });

  test('a window at a URL starts on its first field and Esc hands focus back to its link', async ({ browser }) => {
    const admin = await openAsSuper(browser);

    try {
      await admin.gotoAdmin('/showcase/packages');
      const opener = admin.page.getByTestId('showcase-package-new');
      await waitForHydration(admin.page, '[data-testid="showcase-package-new"]');
      await admin.page.keyboard.press('Shift');
      await opener.focus();
      await admin.page.keyboard.press('Enter');
      await expect(admin.page).toHaveURL(/paket=yeni/);
      const dialog = admin.page.getByTestId('showcase-package-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('input[name="name"]')).toBeFocused();

      await admin.page.keyboard.press('Escape');
      await expect(admin.page).not.toHaveURL(/paket=/);
      await expect(dialog).toHaveCount(0);
      await expect(admin.page.getByTestId('showcase-package-new')).toBeFocused();
    } finally {
      await admin.close();
    }
  });

  test('reference shots: the converted staff list and the skip link', async ({ browser, browserName }) => {
    mkdirSync(SHOTS, { recursive: true });
    for (const width of [1440, 1024, 768, 390, 320]) {
      const admin = await openAsSuper(browser, { width, height: width >= 1024 ? 900 : 844 });
      try {
        await admin.gotoAdmin('/users');
        await expect(admin.page.getByRole('heading', { level: 1, name: 'Yönetici hesapları' })).toBeVisible();
        await expect(admin.page.getByRole('link', { name: 'Yeni yönetici hesabı' })).toBeVisible();
        await expect(admin.page.getByTestId('user-table')).toBeVisible();
        expect(await admin.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        await admin.page.screenshot({ path: resolve(SHOTS, `${browserName}-users-${width}.png`), fullPage: false });
        if (width === 1440) {
          await admin.page.keyboard.press('Shift');
          await admin.page.getByRole('link', { name: 'Ana içeriğe geç' }).focus();
          await admin.page.screenshot({ path: resolve(SHOTS, `${browserName}-skip-link-1440.png`), fullPage: false });
        }
      } finally {
        await admin.close();
      }
    }
  });
});
