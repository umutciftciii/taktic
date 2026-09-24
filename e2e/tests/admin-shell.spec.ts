import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createStaffAdmin } from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESIGN-001 / Faz 1 — the Modernist shell around every signed-in screen.
 *
 * What is pinned here is the contract the redesign had to keep, not the
 * pixels: the menu a session is given is exactly what its permissions open
 * (the design's eight groups, the five rows it had no place for, `/roles` for
 * a super admin only, and no empty heading), the top bar names only a row the
 * session holds, the account block never calls a staff account "tam yetkili",
 * the phone drawer still opens, traps, closes on Escape and hands focus back,
 * and icon mode survives a reload.
 *
 * Run under Chromium and WebKit (see playwright.config.ts). The reference
 * screenshots go to .artifacts/admin-design/ at 1440×900 and 390×844, and are
 * viewport shots on purpose: WebKit's fullPage capture multiplies by the
 * device pixel ratio and the picture stops being the size it says it is.
 */

type Viewport = { width: number; height: number };
const DESKTOP: Viewport = { width: 1440, height: 900 };
const PHONE: Viewport = { width: 390, height: 844 };
const SHOTS = resolve(artifactsDir, 'admin-design');

/** The full menu, in order, as a super admin sees it. */
const FULL_MENU: Array<[group: string, rows: string[]]> = [
  ['Panel', ['Genel görünüm']],
  ['Talepler', ['Tüm talepler', 'Şikayet edilen talepler']],
  ['Teklifler', ['Tüm teklifler']],
  ['Kişiler', ['Hizmet verenler', 'Hizmet alanlar', 'Destek talepleri']],
  [
    'Finans',
    [
      'Finans özeti',
      'Kredi hareketleri',
      'Elle kredi işlemleri',
      'İşletme bakiyeleri',
      'Paket satışları',
      'Paket iadeleri',
      'İade kontrolü',
    ],
  ],
  [
    'Vitrin',
    [
      'Onay bekleyen kartlar',
      'Yayında olan kartlar',
      'Vitrinden gelen talepler',
      'Şikayet edilen yorumlar',
      'Vitrin kartları',
      'Vitrin metin onayları',
    ],
  ],
  ['Katalog', ['Hizmet kategorileri', 'Vitrin paketleri', 'Kredi paketleri']],
  ['Operasyon', ['Operasyon ayarları', 'Kampanyalar', 'Kampanya uygunluk incelemesi', 'Gönderilen bildirimler']],
  ['Yönetim', ['Yönetici hesapları', 'Roller ve izinler', 'Şirket ve e-posta bilgileri']],
];

function shot(name: string) {
  mkdirSync(SHOTS, { recursive: true });
  return resolve(SHOTS, `${name}.png`);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function sidebarRowLabels(page: Page): Promise<string[]> {
  return page.locator('#admin-sidebar .admin-sidebar-link').allTextContents();
}

async function sidebarGroupTitles(page: Page): Promise<string[]> {
  return page.locator('#admin-sidebar .admin-sidebar-group-title').allTextContents();
}

async function openAs(browser: Parameters<typeof Actor.open>[0], who: string[] | 'super', viewport = DESKTOP) {
  const account = who === 'super' ? await createAdmin() : await createStaffAdmin(who);
  const actor = await Actor.open(browser, `shell-${who === 'super' ? 'super' : 'staff'}`, primaryRuntime, { viewport });
  await actor.loginToAdmin(account.email, account.password);
  return actor;
}

test.describe('admin shell (ADMIN-DESIGN-001)', () => {
  test('a super admin gets every group and row, root included, and "Süper yönetici"', async ({ browser }) => {
    const admin = await openAs(browser, 'super');

    try {
      await admin.gotoAdmin('/');
      await expect(admin.page.locator('#admin-sidebar')).toBeVisible();

      expect(await sidebarRowLabels(admin.page)).toEqual(FULL_MENU.flatMap(([, rows]) => rows));
      // The bare "Genel görünüm" group has no heading of its own.
      expect(await sidebarGroupTitles(admin.page)).toEqual(FULL_MENU.slice(1).map(([group]) => group));
      await expect(admin.page.getByTestId('admin-account-role')).toHaveText('Süper yönetici');
      await expect(admin.page.locator('#admin-sidebar')).not.toContainText(/tam yetkili/i);

      // No search, no bell, no counters (K2, K3): the bar is where you are and
      // the way out.
      await expect(admin.page.getByTestId('admin-topbar-context')).toHaveText(/Panel\s*\/\s*Genel görünüm/);
      await expect(admin.page.locator('.admin-topbar').getByRole('searchbox')).toHaveCount(0);
      await expect(admin.page.locator('.admin-topbar').getByRole('button')).toHaveText(['Çıkış']);

      // The active row: the most specific one, and only one.
      await admin.gotoAdmin('/showcase/cards');
      await expect(admin.page.locator('#admin-sidebar [aria-current="page"]')).toHaveText(['Vitrin kartları']);
      await expect(admin.page.getByTestId('admin-topbar-context')).toHaveText(/Vitrin\s*\/\s*Vitrin kartları/);
      await admin.gotoAdmin('/package-refunds');
      await expect(admin.page.locator('#admin-sidebar [aria-current="page"]')).toHaveText(['Paket iadeleri']);
      await admin.gotoAdmin('/roles');
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.locator('#admin-sidebar [aria-current="page"]')).toHaveText(['Roller ve izinler']);

      await admin.gotoAdmin('/');
      expect(await horizontalOverflow(admin.page)).toBeLessThanOrEqual(0);
      await admin.page.screenshot({ path: shot('super-admin-dashboard-1440'), fullPage: false });
    } finally {
      await admin.close();
    }
  });

  test('a limited staff account sees its rows only, and every one of them opens', async ({ browser }) => {
    const held = ['DASHBOARD_READ', 'CUSTOMERS_READ', 'PACKAGE_REFUND_READ', 'SHOWCASE_CARDS_READ'];
    const staff = await openAs(browser, held);

    try {
      await staff.gotoAdmin('/');
      expect(await sidebarRowLabels(staff.page)).toEqual([
        'Genel görünüm',
        'Hizmet alanlar',
        'Paket iadeleri',
        'Vitrin kartları',
      ]);
      // A group with nothing the session holds is dropped, heading and all.
      expect(await sidebarGroupTitles(staff.page)).toEqual(['Kişiler', 'Finans', 'Vitrin']);
      const sidebar = staff.page.locator('#admin-sidebar');
      for (const absent of ['Talepler', 'Teklifler', 'Katalog', 'Operasyon', 'Yönetim']) {
        await expect(sidebar.getByRole('button', { name: absent, exact: true })).toHaveCount(0);
      }
      await expect(sidebar.getByRole('link', { name: 'Roller ve izinler' })).toHaveCount(0);
      await expect(staff.page.getByTestId('admin-account-role')).toHaveText(`Yetkili personel · ${held.length} yetki`);
      await expect(sidebar).not.toContainText(/tam yetkili/i);
      await staff.page.screenshot({ path: shot('limited-admin-dashboard-1440'), fullPage: false });

      // Every row it was given opens — a visible row that lands on /yetkisiz is
      // exactly the drift this menu exists to prevent.
      const hrefs = await sidebar.locator('.admin-sidebar-link').evaluateAll((links) =>
        links.map((link) => link.getAttribute('href') ?? ''),
      );
      expect(hrefs).toEqual(['/', '/customers', '/package-refunds', '/showcase/cards']);
      for (const href of hrefs) {
        await staff.gotoAdmin(href);
        await expect(staff.page, href).not.toHaveURL(/\/yetkisiz$/);
        await assertNoErrorScreen(staff.page);
      }

      // A screen it does not hold: /yetkisiz, and the top bar names no row the
      // menu hides (F18).
      await staff.gotoAdmin('/requests/reports');
      await expect(staff.page).toHaveURL(/\/yetkisiz$/);
      await expect(staff.page.getByRole('heading', { name: /yetkiniz yok/i })).toBeVisible();
      await expect(staff.page.getByTestId('admin-topbar-context')).toHaveText('TakTick Yönetim');
      await staff.page.screenshot({ path: shot('yetkisiz-1440'), fullPage: false });
    } finally {
      await staff.close();
    }
  });

  test('the 404 and the sign-in screen are in the design, and still behave', async ({ browser }) => {
    const admin = await openAs(browser, 'super');
    const visitor = await Actor.open(browser, 'shell-visitor', primaryRuntime, { viewport: DESKTOP });

    try {
      await admin.gotoAdmin('/offers/does-not-exist');
      await expect(admin.page.getByRole('heading', { name: 'Kayıt bulunamadı' })).toBeVisible();
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.locator('#admin-sidebar')).toBeVisible();
      await admin.page.screenshot({ path: shot('not-found-1440'), fullPage: false });

      await visitor.gotoAdmin('/login');
      await expect(visitor.page.getByRole('heading', { name: 'TakTick Yönetim' })).toBeVisible();
      // The mark is drawn on its red tile, from the new asset; the form is the
      // same fixed HTML post it was (BUG-AUTH-STALE-ACTION-001).
      await expect(visitor.page.locator('.auth-card .brand-tile img')).toHaveAttribute('src', '/brand/mark-white.png');
      await expect(visitor.page.locator('form.auth-card')).toHaveAttribute('action', '/login/submit');
      await expect(visitor.page.locator('form.auth-card')).toHaveAttribute('method', 'post');
      await expect(visitor.page.locator('#admin-sidebar')).toHaveCount(0);
      await visitor.page.screenshot({ path: shot('login-1440'), fullPage: false });

      await visitor.page.setViewportSize(PHONE);
      await visitor.gotoAdmin('/login?error=1');
      await expect(visitor.page.locator('.error-message')).toBeVisible();
      expect(await horizontalOverflow(visitor.page)).toBeLessThanOrEqual(0);
      await visitor.page.screenshot({ path: shot('login-error-390'), fullPage: false });
    } finally {
      await admin.close();
      await visitor.close();
    }
  });

  test('keyboard focus is visible on the menu', async ({ browser }) => {
    const admin = await openAs(browser, 'super');

    try {
      await admin.gotoAdmin('/');
      const row = admin.page.locator('#admin-sidebar').getByRole('link', { name: 'Tüm talepler' });
      // Keyboard modality first, then focus: that is what makes :focus-visible
      // apply. Not Tab onto the link itself — WebKit, like Safari, leaves links
      // out of the Tab order unless the user turns that on.
      await admin.page.keyboard.press('Shift');
      await row.focus();
      await expect(row).toBeFocused();
      expect(await row.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
      const outline = await row.evaluate((element) => {
        const style = getComputedStyle(element);
        return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
      });
      expect(outline.style).toBe('solid');
      expect(outline.width).toBe('2px');
      expect(outline.color).toBe('rgb(236, 48, 19)');
    } finally {
      await admin.close();
    }
  });

  test('icon mode narrows the menu, survives a reload, and a group icon widens it again', async ({ browser }) => {
    const admin = await openAs(browser, 'super');
    const sidebar = admin.page.locator('#admin-sidebar');
    const width = () => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width));

    try {
      await admin.gotoAdmin('/finance');
      await expect.poll(width).toBe(256);

      await admin.page.getByTestId('admin-rail-toggle').click();
      await expect(admin.page.locator('.admin-shell')).toHaveClass(/is-rail/);
      await expect.poll(width).toBe(64);
      // The rows fold away; the group buttons keep their names for a screen reader.
      await expect(sidebar.getByRole('link', { name: 'Finans özeti' })).toBeHidden();
      await expect(sidebar.getByRole('button', { name: 'Finans' })).toBeVisible();
      expect(await horizontalOverflow(admin.page)).toBeLessThanOrEqual(0);
      await admin.page.screenshot({ path: shot('rail-1440'), fullPage: false });

      await admin.page.reload({ waitUntil: 'domcontentloaded' });
      await expect(admin.page.locator('.admin-shell')).toHaveClass(/is-rail/);
      await expect.poll(width).toBe(64);

      await sidebar.getByRole('button', { name: 'Finans' }).click();
      await expect(admin.page.locator('.admin-shell')).not.toHaveClass(/is-rail/);
      await expect.poll(width).toBe(256);
      await expect(sidebar.getByRole('button', { name: 'Finans' })).toHaveAttribute('aria-expanded', 'true');
      await expect(sidebar.getByRole('link', { name: 'Finans özeti' })).toBeVisible();

      await admin.page.reload({ waitUntil: 'domcontentloaded' });
      await expect(admin.page.getByTestId('admin-rail-toggle')).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(width).toBe(256);

      // A phone never gets icon mode, whatever the desktop remembered.
      await admin.page.getByTestId('admin-rail-toggle').click();
      await expect.poll(width).toBe(64);
      await admin.page.setViewportSize(PHONE);
      await admin.page.reload({ waitUntil: 'domcontentloaded' });
      await expect(admin.page.locator('.admin-shell')).not.toHaveClass(/is-rail/);
      await admin.page.getByTestId('panel-drawer-toggle').click();
      await expect(sidebar.getByRole('link', { name: 'Finans özeti' })).toBeVisible();
      await admin.page.keyboard.press('Escape');
    } finally {
      await admin.close();
    }
  });

  test('the phone drawer opens, keeps Tab inside, closes on Escape and returns focus', async ({ browser }) => {
    const admin = await openAs(browser, 'super', PHONE);
    const sidebar = admin.page.locator('#admin-sidebar');
    const toggle = admin.page.getByTestId('panel-drawer-toggle');

    try {
      await admin.gotoAdmin('/');
      await expect(sidebar).toBeHidden();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(await horizontalOverflow(admin.page)).toBeLessThanOrEqual(0);
      await admin.page.screenshot({ path: shot('dashboard-390-closed'), fullPage: false });

      await toggle.click();
      await expect(sidebar).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(admin.page.locator('body')).toHaveClass(/has-drawer-open/);
      await expect
        .poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().left)))
        .toBe(0);
      // Icon mode is a desktop control; the drawer does not offer it.
      await expect(admin.page.getByTestId('admin-rail-toggle')).toBeHidden();
      await expect(admin.page.getByRole('button', { name: 'Menüyü kapat' }).first()).toBeFocused();
      expect(await horizontalOverflow(admin.page)).toBeLessThanOrEqual(0);
      await admin.page.screenshot({ path: shot('dashboard-390-drawer-open'), fullPage: false });

      // Shift+Tab from the first control wraps to the last one inside the drawer.
      await admin.page.keyboard.press('Shift+Tab');
      const insideAfterWrap = await admin.page.evaluate(() =>
        Boolean(document.getElementById('admin-sidebar')?.contains(document.activeElement)),
      );
      expect(insideAfterWrap).toBe(true);

      await admin.page.keyboard.press('Escape');
      await expect(sidebar).toBeHidden();
      await expect(toggle).toBeFocused();
      await expect(admin.page.locator('body')).not.toHaveClass(/has-drawer-open/);
    } finally {
      await admin.close();
    }
  });
});
