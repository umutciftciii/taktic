import { expect, test } from '@playwright/test';
import { Actor } from '../src/actors';
import { createAdmin, createStaffAdmin, prisma } from '../src/fixtures';
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
      await expect(sidebar.getByRole('link', { name: 'Genel görünüm', exact: true })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: 'Hizmet alanlar' })).toBeVisible();
      // Not held: everything else, including the whole Finans group, which is
      // dropped rather than left as an empty heading.
      await expect(sidebar.getByRole('link', { name: 'Tüm teklifler' })).toHaveCount(0);
      await expect(sidebar.getByRole('link', { name: 'Kredi hareketleri' })).toHaveCount(0);
      await expect(sidebar.getByText('Finans', { exact: true })).toHaveCount(0);
      // Root: no permission reveals it.
      await expect(sidebar.getByRole('link', { name: 'Roller ve izinler' })).toHaveCount(0);
      // The account block counts what the role holds; it never claims more.
      await expect(admin.page.getByTestId('admin-account-role')).toHaveText('Yetkili personel · 2 yetki');

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

  /*
   * ADMIN-DESIGN-001 Faz 3G: the same promise, end to end through the role
   * screens. A super admin defines a role on /roles out of the catalogue,
   * assigns it on the account's page, and the account's panel grows by
   * exactly that section; taking the role back (after the confirmation) takes
   * the section away again on the account's next request.
   */
  test('a role defined on /roles and assigned on the account page opens exactly its sections', async ({ browser }) => {
    test.setTimeout(150_000);
    const staff = await createStaffAdmin(['DASHBOARD_READ']);
    const owner = await createAdmin();
    const root = await Actor.open(browser, 'root', primaryRuntime);
    const member = await Actor.open(browser, 'staff', primaryRuntime);
    const key = `e2e-rbac-${Date.now()}`;

    try {
      await root.loginToAdmin(owner.email, owner.password);
      await root.gotoAdmin('/roles');
      const form = root.page.getByTestId('role-create-form');
      await form.locator('input[name="key"]').fill(key);
      await form.locator('input[name="name"]').fill('E2E Hizmet Alan Okuyucu');
      await form.locator('input[name="permissions"][value="CUSTOMERS_READ"]').check();
      await expect(root.page.getByTestId('permission-matrix-summary')).toContainText('1 tanesi seçili');
      await form.getByRole('button', { name: 'Rolü oluştur' }).click();
      await expect(root.page).toHaveURL(/\/roles\/[^/?]+\?ok=created$/);
      const role = await prisma().adminRole.findUniqueOrThrow({
        where: { key },
        select: { id: true, permissions: { select: { permission: true } } },
      });
      expect(role.permissions.map((row) => row.permission)).toEqual(['CUSTOMERS_READ']);

      // Before the assignment the account has the dashboard only.
      await member.loginToAdmin(staff.email, staff.password);
      await member.gotoAdmin('/');
      const sidebar = member.page.locator('#admin-sidebar');
      await expect(sidebar.getByRole('link', { name: 'Hizmet alanlar' })).toHaveCount(0);

      await root.gotoAdmin(`/users/${staff.id}`);
      await root.page.getByTestId('user-role-assign').locator('select[name="roleId"]').selectOption(role.id);
      await root.page.getByTestId('user-role-assign').getByRole('button', { name: 'Ata' }).click();
      await expect(root.page.getByTestId('role-assignment-ok')).toHaveText('Rol atandı.');

      await member.gotoAdmin('/');
      await expect(sidebar.getByRole('link', { name: 'Hizmet alanlar' })).toBeVisible();
      await member.gotoAdmin('/customers');
      await expect(member.page).toHaveURL(/\/customers$/);

      // Taking it back asks, names the one permission lost, then revokes.
      // The account also holds its fixture role: each row has its own dialog.
      const roleRow = root.page.locator(`[data-testid="user-role-row"][data-role-id="${role.id}"]`);
      const revoke = roleRow.getByTestId('user-role-revoke');
      await expect
        .poll(() => revoke.evaluate((element) => Object.keys(element).some((name) => name.startsWith('__reactProps'))))
        .toBe(true);
      await revoke.click();
      const dialog = roleRow.getByTestId('user-role-revoke-dialog');
      await expect(dialog.getByTestId('user-role-revoke-impact')).toContainText('Bu hesap 1 izni hemen kaybeder');
      await dialog.getByRole('button', { name: 'Evet, geri al' }).click();
      await expect(root.page.getByTestId('role-assignment-ok')).toHaveText('Rol geri alındı.');

      await member.gotoAdmin('/customers');
      await expect(member.page).toHaveURL(/\/yetkisiz$/);
    } finally {
      await Promise.all([root.close(), member.close()]);
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
