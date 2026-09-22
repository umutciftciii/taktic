import { expect, test } from '@playwright/test';
import { Actor } from '../src/actors';
import { createStaffAdmin } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * PR-0 — the panel shows exactly what the API would allow.
 *
 * The API specs prove the guards; this proves the *screens* answer from the
 * same source (design D13). Three things have to agree for a staff account:
 * the sidebar it is given, the page it can open, and the page it cannot. If
 * any of them drifted, one of these assertions would catch it — a row that is
 * visible but refused, or a page that is reachable but hidden.
 */
test.describe('admin RBAC', () => {
  test('a staff account sees only the sections its role opens', async ({ browser }) => {
    const staff = await createStaffAdmin(['DASHBOARD_READ', 'CUSTOMERS_READ']);
    const admin = await Actor.open(browser, 'staff', primaryRuntime);

    try {
      await admin.loginToAdmin(staff.email, staff.password);
      await admin.gotoAdmin('/');

      const sidebar = admin.page.locator('#admin-sidebar');
      // Held: the dashboard and the customer queue.
      await expect(sidebar.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: 'Hizmet Alanlar' })).toBeVisible();
      // Not held: everything else, including the whole Finans group, which is
      // dropped rather than left as an empty heading.
      await expect(sidebar.getByRole('link', { name: 'Teklifler' })).toHaveCount(0);
      await expect(sidebar.getByRole('link', { name: 'Kredi Hareketleri' })).toHaveCount(0);
      await expect(sidebar.getByText('Finans', { exact: true })).toHaveCount(0);
      // Root: no permission reveals it.
      await expect(sidebar.getByRole('link', { name: 'Roller ve İzinler' })).toHaveCount(0);

      // A held page opens…
      await admin.gotoAdmin('/customers');
      await expect(admin.page).toHaveURL(/\/customers$/);

      // …and one the role does not cover explains itself instead of bouncing
      // the person to a sign-in form they are already past.
      await admin.gotoAdmin('/offers');
      await expect(admin.page).toHaveURL(/\/yetkisiz$/);
      await expect(admin.page.getByRole('heading', { name: /yetkiniz yok/i })).toBeVisible();
    } finally {
      await admin.close();
    }
  });

  test('a staff account with no role cannot get past the door', async ({ browser }) => {
    const staff = await createStaffAdmin([]);
    const admin = await Actor.open(browser, 'staff', primaryRuntime);

    try {
      await admin.loginToAdmin(staff.email, staff.password);
      await admin.gotoAdmin('/');

      // Signing in succeeds — the account is real — and the panel still does
      // not open: an account nobody has given anything has not been given the
      // panel either. It lands on the explanation rather than back on the
      // sign-in form, which it is already past (ADMIN_ACCESS_DENIED, not
      // NOT_STAFF).
      await expect(admin.page).toHaveURL(/\/yetkisiz$/);
      await expect(admin.page.getByRole('heading', { name: /yetkiniz yok/i })).toBeVisible();
    } finally {
      await admin.close();
    }
  });
});
