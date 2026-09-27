import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCustomer, createStaffAdmin, prisma } from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESIGN-001 Faz 2: "Gönderilen bildirimler" (#46), the reference screen
 * for the shared list components.
 *
 * notification-history.spec.ts proves what the history records and discloses
 * on real sends. This proves the list itself, as an operator drives it: every
 * piece of state is in the URL (saved view, the eight filters, the page), the
 * form filters and clears, the footer pages, the empty state says why it is
 * empty, the ⓘ behaves as a disclosure, and the page never gets wider than a
 * 320px phone — the table scrolls in its own box.
 *
 * And the one write the screen offers: "Yeniden gönder" needs both a row the
 * API calls retryable and a session holding NOTIFICATION_RETRY. The permission
 * is decided on the server; a reader with only NOTIFICATION_LOGS_READ never
 * receives the control.
 *
 * The rows are written directly and belong to one fresh user, so every count
 * here is exact whatever else the suite has sent. Nothing is ever re-sent: no
 * test clicks the retry button.
 */

/**
 * Reference screenshots for the PR, next to Faz 1's: viewport shots (WebKit's
 * fullPage capture multiplies by the device pixel ratio), one set per browser.
 */
const SHOTS = resolve(artifactsDir, 'admin-design');
function shot(testInfo: TestInfo, name: string): string {
  mkdirSync(SHOTS, { recursive: true });
  return resolve(SHOTS, `${testInfo.project.name}-${name}.png`);
}

const SENT_ROWS = 49;
const FAILED_ROWS = 2;
const TOTAL_ROWS = SENT_ROWS + FAILED_ROWS;

async function seedHistory() {
  const customer = await createCustomer('E2E Bildirim Listesi');
  const base = Date.now() - 60 * 60 * 1000;
  const sent = Array.from({ length: SENT_ROWS }, (_, index) => ({
    channel: 'SMS' as const,
    template: 'phone-verification-code',
    maskedRecipient: '+90 ******* 00',
    status: 'SENT' as const,
    userId: customer.id,
    createdAt: new Date(base + index * 1000),
    sentAt: new Date(base + index * 1000),
  }));
  // Retryable by the API's own rule: a failed e-mail of a template it can
  // rebuild, naming its source transition.
  const failed = Array.from({ length: FAILED_ROWS }, (_, index) => ({
    channel: 'EMAIL' as const,
    template: 'request-received',
    maskedRecipient: 'e***@example.test',
    status: 'FAILED' as const,
    errorCode: 'TRANSPORT_UNAVAILABLE',
    userId: customer.id,
    dedupeKey: `e2e-list-${customer.id}-${index}`,
    createdAt: new Date(base + (SENT_ROWS + index) * 1000),
    failedAt: new Date(base + (SENT_ROWS + index) * 1000),
  }));
  await prisma().notificationLog.createMany({ data: [...sent, ...failed] });
  const failedIds = await prisma().notificationLog.findMany({
    where: { userId: customer.id, status: 'FAILED' },
    select: { id: true },
  });
  return { userId: customer.id, failedIds: failedIds.map((row) => row.id) };
}

function rows(page: Page) {
  return page.getByTestId('notification-row');
}

test.describe('notifications list (ADMIN-DESIGN-001 Faz 2)', () => {
  test('saved views, filters, pagination and the empty state live in the URL', async ({ browser }, testInfo) => {
    const { userId } = await seedHistory();
    const account = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime, { viewport: { width: 1440, height: 900 } });

    try {
      await admin.loginToAdmin(account.email, account.password);
      const page = admin.page;

      // ---- page-based pagination, filters carried along ---------------------
      await admin.gotoAdmin(`/notifications?userId=${userId}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Gönderilen bildirimler' })).toBeVisible();
      await assertNoErrorScreen(page);
      await expect(rows(page)).toHaveCount(50);
      await expect(page.getByTestId('notification-count')).toHaveText(`${TOTAL_ROWS} kaydın 1–50 arası gösteriliyor`);
      await expect(page.getByTestId('pagination-previous')).toHaveAttribute('aria-disabled', 'true');
      // At 1440px the whole table — retry controls included — fits its box: it
      // only scrolls sideways on a narrower screen.
      expect(
        await page.evaluate(() => {
          const scroller = document.querySelector('.data-list-scroll');
          return scroller ? scroller.scrollWidth - scroller.clientWidth : -1;
        }),
      ).toBe(0);
      await page.screenshot({ path: shot(testInfo, 'notifications-1440'), fullPage: false });

      await page.getByRole('link', { name: 'Sonraki' }).click();
      await expect(page).toHaveURL(new RegExp(`/notifications\\?userId=${userId}&page=2$`));
      await expect(rows(page)).toHaveCount(1);
      await expect(page.getByTestId('notification-count')).toHaveText(`${TOTAL_ROWS} kaydın 51. kaydı gösteriliyor`);
      await expect(page.getByTestId('pagination-next')).toHaveAttribute('aria-disabled', 'true');

      await page.getByRole('link', { name: 'Önceki' }).click();
      await expect(page).toHaveURL(new RegExp(`/notifications\\?userId=${userId}$`));
      await expect(rows(page)).toHaveCount(50);

      // ---- saved views are links: aria-current, counter, page dropped -------
      const views = page.getByRole('navigation', { name: 'Bildirim görünümleri' });
      await expect(views.getByRole('link', { name: /^Tümü/ })).toHaveAttribute('aria-current', 'page');
      await views.getByRole('link', { name: /^Başarısız/ }).click();
      await expect(page).toHaveURL(new RegExp(`/notifications\\?status=FAILED&userId=${userId}$`));
      const failedView = views.getByRole('link', { name: /^Başarısız/ });
      await expect(failedView).toHaveAttribute('aria-current', 'page');
      await expect(failedView).toContainText(String(FAILED_ROWS));
      await expect(views.getByRole('link', { name: /^Tümü/ })).not.toHaveAttribute('aria-current', 'page');
      await expect(rows(page)).toHaveCount(FAILED_ROWS);
      // The status filter shows the same choice the view made.
      await expect(page.locator('#notification-status')).toHaveValue('FAILED');
      await page.screenshot({ path: shot(testInfo, 'notifications-failed-view-1440'), fullPage: false });

      // ---- the filter form is a GET form: filter, then clear ----------------
      await admin.gotoAdmin('/notifications');
      const filters = page.getByRole('search', { name: 'Bildirim filtreleri' });
      await expect(filters.getByRole('link', { name: 'Temizle' })).toHaveCount(0);
      await filters.getByLabel('Kullanıcı ID').fill(userId);
      await filters.getByLabel('Kanal').selectOption('EMAIL');
      await filters.getByRole('button', { name: 'Filtrele' }).click();
      await expect(page).toHaveURL(/[?&]channel=EMAIL(&|$)/);
      await expect(page).toHaveURL(new RegExp(`[?&]userId=${userId}(&|$)`));
      await expect(rows(page)).toHaveCount(FAILED_ROWS);
      await expect(page.getByTestId('notification-count')).toHaveText(`${FAILED_ROWS} kaydın 1–${FAILED_ROWS} arası gösteriliyor`);

      await filters.getByRole('link', { name: 'Temizle' }).click();
      await expect(page).toHaveURL(/\/notifications$/);
      await expect(filters.getByLabel('Kullanıcı ID')).toHaveValue('');
      await expect(filters.getByLabel('Kanal')).toHaveValue('');

      // ---- the empty state says why it is empty -----------------------------
      await admin.gotoAdmin(`/notifications?userId=${userId}&status=PENDING`);
      await expect(page.getByTestId('notification-table')).toHaveCount(0);
      await expect(page.getByText('Filtreye uygun bildirim kaydı bulunamadı.')).toBeVisible();
      await expect(page.getByTestId('notification-count')).toHaveCount(0);
      await page.getByRole('link', { name: 'Filtreleri temizle' }).click();
      await expect(page).toHaveURL(/\/notifications$/);
    } finally {
      await admin.close();
    }
  });

  test('the ⓘ is a disclosure: one click, Esc, a click outside', async ({ browser }) => {
    const account = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(account.email, account.password);
      await admin.gotoAdmin('/notifications');
      const page = admin.page;
      const trigger = page.getByRole('button', { name: 'Bu ekran ne işe yarar?' });
      const panel = page.getByTestId('page-info').getByTestId('info-popover-panel');

      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(panel).toBeHidden();
      const controls = await trigger.getAttribute('aria-controls');
      expect(controls).toBeTruthy();
      expect(await panel.getAttribute('id')).toBe(controls);

      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('Bu liste silinemez ve düzenlenemez');

      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(panel).toBeHidden();
      await expect(trigger).toBeFocused();

      await page.keyboard.press('Enter');
      await expect(panel).toBeVisible();
      await trigger.click();
      await expect(panel).toBeHidden();

      await trigger.click();
      await expect(panel).toBeVisible();
      await page.getByRole('heading', { level: 1, name: 'Gönderilen bildirimler' }).click();
      await expect(panel).toBeHidden();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    } finally {
      await admin.close();
    }
  });

  test('at 320px the page stays inside the window and the table scrolls in its own box', async ({ browser }, testInfo) => {
    const { userId } = await seedHistory();
    const account = await createAdmin();
    const admin = await Actor.open(browser, 'admin-320', primaryRuntime, { viewport: { width: 320, height: 740 } });

    try {
      await admin.loginToAdmin(account.email, account.password);
      await admin.gotoAdmin(`/notifications?userId=${userId}`);
      const page = admin.page;
      await expect(rows(page)).toHaveCount(50);

      const measure = () =>
        page.evaluate(() => {
          const scroller = document.querySelector('.data-list-scroll');
          return {
            page: document.documentElement.scrollWidth - window.innerWidth,
            tableScrolls: scroller ? scroller.scrollWidth > scroller.clientWidth : false,
          };
        });
      expect(await measure()).toEqual({ page: 0, tableScrolls: true });
      await page.screenshot({ path: shot(testInfo, 'notifications-320'), fullPage: false });
      await page.getByTestId('notification-table').scrollIntoViewIfNeeded();
      await page.screenshot({ path: shot(testInfo, 'notifications-320-table'), fullPage: false });

      // Opening the ⓘ does not widen the page either.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByRole('button', { name: 'Bu ekran ne işe yarar?' }).click();
      await expect(page.getByTestId('page-info').getByTestId('info-popover-panel')).toBeVisible();
      expect((await measure()).page).toBe(0);
      await page.screenshot({ path: shot(testInfo, 'notifications-320-info'), fullPage: false });
    } finally {
      await admin.close();
    }
  });

  test('"Yeniden gönder" needs NOTIFICATION_RETRY as well as a retryable row', async ({ browser }) => {
    const { userId, failedIds } = await seedHistory();
    const cases = [
      { permissions: ['NOTIFICATION_LOGS_READ'], buttons: 0 },
      { permissions: ['NOTIFICATION_LOGS_READ', 'NOTIFICATION_RETRY'], buttons: FAILED_ROWS },
    ];

    for (const { permissions, buttons } of cases) {
      const account = await createStaffAdmin(permissions);
      const staff = await Actor.open(browser, `staff-${buttons}`, primaryRuntime);
      try {
        await staff.loginToAdmin(account.email, account.password);
        await staff.gotoAdmin(`/notifications?userId=${userId}`);
        await expect(staff.page).toHaveURL(/\/notifications\?/);
        await assertNoErrorScreen(staff.page);
        await expect(rows(staff.page)).toHaveCount(50);
        // The retryable rows are the two failed e-mails; SENT SMS rows never
        // carry the control, whoever is looking.
        await expect(staff.page.getByTestId('notification-retry-button')).toHaveCount(buttons);
        await expect(
          rows(staff.page).filter({ has: staff.page.getByTestId('notification-retry-button') }),
        ).toHaveCount(buttons);

        await staff.gotoAdmin(`/notifications/${failedIds[0]}`);
        await assertNoErrorScreen(staff.page);
        await expect(staff.page.getByTestId('notification-retry-button')).toHaveCount(buttons > 0 ? 1 : 0);
      } finally {
        await staff.close();
      }
    }
  });
});
