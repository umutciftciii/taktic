import { expect, test, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createStaffAdmin } from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * ADMIN-SYSTEM-HEALTH-001 — "Sistem sağlığı", end to end.
 *
 * The probes here are real: the API of this runtime is pointed at this
 * runtime's own web and admin servers (playwright.config.ts), so a HEALTHY
 * web and admin row means the compiled Next servers answered /robots.txt and
 * /login with 200 — no redirect — inside 1.5 seconds. The database row is the
 * readiness probe against the suite's database.
 *
 * And the access split: OPERATIONS_SETTINGS_READ opens the screen without the
 * e-mail section and without the link to Bildirim ayarları (OBS-ALERT-002);
 * NOTIFICATION_LOGS_READ alone opens nothing.
 */

const SHOTS = resolve(artifactsDir, 'system-health');
function shot(testInfo: TestInfo, name: string): string {
  mkdirSync(SHOTS, { recursive: true });
  return resolve(SHOTS, `${testInfo.project.name}-${name}.png`);
}

test.describe('system health (ADMIN-SYSTEM-HEALTH-001)', () => {
  test('a super admin sees every measured section, refreshes by hand, and the page fits a phone', async ({ browser }, testInfo) => {
    const account = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime, { viewport: { width: 1440, height: 900 } });
    try {
      await admin.loginToAdmin(account.email, account.password);
      const page = admin.page;
      const sidebar = page.locator('#admin-sidebar');
      await sidebar.getByRole('link', { name: 'Sistem sağlığı' }).click();
      await expect(page).toHaveURL(/\/system-health$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Sistem sağlığı' })).toBeVisible();
      await assertNoErrorScreen(page);

      const status = (testId: string) => page.getByTestId(testId).locator('[data-status]').first();
      await expect(status('system-health-row-api')).toHaveAttribute('data-status', 'HEALTHY');
      await expect(status('system-health-row-database')).toHaveAttribute('data-status', 'HEALTHY');
      await expect(status('system-health-row-web')).toHaveAttribute('data-status', 'HEALTHY');
      await expect(status('system-health-row-admin')).toHaveAttribute('data-status', 'HEALTHY');
      await expect(page.getByTestId('system-health-scope')).toContainText('dışarıdan erişebildiği anlamına gelmez');

      // The deployment is named on the screen (this runtime declares none, so it says so).
      await expect(page.getByTestId('system-health-environment')).toHaveAttribute(
        'data-environment',
        /^(local|staging|production|unset)$/,
      );
      await expect(page.getByTestId('system-health-environment')).not.toBeEmpty();

      await expect(page.getByTestId('system-health-job-request-expiry')).toBeVisible();
      // A job reads in its own words; switched off is "Kapalı", not a health state.
      await expect(page.getByTestId('system-health-job-request-expiry').locator('[data-job-state]')).toHaveAttribute(
        'data-job-state',
        /^(OK|RUNNING|FAILED|LATE|OFF|NO_DATA)$/,
      );
      await expect(page.getByTestId('system-health-email')).toBeVisible();
      // OBS-ALERT-001: the alert engine's own state and the channels, never their values.
      await expect(page.getByTestId('system-health-alerts')).toBeVisible();
      await expect(page.getByTestId('system-health-alerts-status')).toHaveAttribute('data-status', /^(HEALTHY|DEGRADED|DOWN|UNKNOWN)$/);
      await expect(page.getByTestId('system-health-alert-channels')).toContainText('Telegram');
      await expect(page.getByTestId('system-health-alerts')).toContainText('Son başarılı değerlendirme');
      // OBS-ALERT-002: the alerts card leads to the recipients screen (OPS_ALERT_RECIPIENTS_READ).
      await expect(page.getByTestId('system-health-notification-settings-link')).toHaveAttribute(
        'href',
        '/system-health/notification-settings',
      );
      await expect(page.getByTestId('system-health-not-measured')).toContainText('Dışarıdan erişilebilirlik');
      // Nothing on the screen acts: no form, no write button beyond "Yenile".
      await expect(page.locator('main form')).toHaveCount(0);
      await page.screenshot({ path: shot(testInfo, 'system-health-1440'), fullPage: false });

      await page.getByTestId('system-health-refresh').click();
      await expect(page.getByTestId('system-health-generated-at')).toContainText('Son ölçüm');
      await assertNoErrorScreen(page);

      await page.setViewportSize({ width: 320, height: 800 });
      await admin.gotoAdmin('/system-health');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      await page.screenshot({ path: shot(testInfo, 'system-health-320'), fullPage: false });
    } finally {
      await admin.close();
    }
  });

  test('OPERATIONS_SETTINGS_READ opens it without the e-mail section', async ({ browser }) => {
    const staff = await createStaffAdmin(['OPERATIONS_SETTINGS_READ']);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    try {
      await admin.loginToAdmin(staff.email, staff.password);
      await admin.gotoAdmin('/system-health');
      await expect(admin.page).toHaveURL(/\/system-health$/);
      await expect(admin.page.getByTestId('system-health-services')).toBeVisible();
      await expect(admin.page.getByTestId('system-health-email')).toHaveCount(0);
      await expect(admin.page.getByTestId('system-health-email-hidden')).toBeVisible();
      await expect(admin.page.getByTestId('system-health-alerts')).toBeVisible();
      await expect(admin.page.getByTestId('system-health-alerts-email-hidden')).toBeVisible();
      await expect(admin.page.getByTestId('system-health-notification-settings-link')).toHaveCount(0);
      await expect(admin.page.locator('a[href^="/notifications/"]')).toHaveCount(0);
    } finally {
      await admin.close();
    }
  });

  test('NOTIFICATION_LOGS_READ alone does not open it', async ({ browser }) => {
    const staff = await createStaffAdmin(['NOTIFICATION_LOGS_READ']);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    try {
      await admin.loginToAdmin(staff.email, staff.password);
      await expect(admin.page.locator('#admin-sidebar').getByRole('link', { name: 'Sistem sağlığı' })).toHaveCount(0);
      await admin.gotoAdmin('/system-health');
      await expect(admin.page).toHaveURL(/\/yetkisiz$/);
    } finally {
      await admin.close();
    }
  });
});
