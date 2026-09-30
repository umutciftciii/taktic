import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
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

/**
 * ADMIN-DESIGN-001 Faz 4 — the matrix, one read permission at a time.
 *
 * Written from the menu's side, independently of `lib/nav.ts`, so a drift in
 * either shows up as a disagreement: for every read permission a sidebar row
 * asks for, a staff account holding that permission alone
 * - lands on its first row from `/`, not on /yetkisiz;
 * - is given exactly the rows that permission opens, and nothing else — no
 *   other group, no dashboard row, no root row;
 * - opens every one of them (a row that lands on /yetkisiz is the drift this
 *   menu exists to prevent);
 * - is shown no write control there: no server-action form, no POST form
 *   (sign-out excepted) — a read permission renders a read screen;
 * - and is refused a screen of another area with /yetkisiz.
 */
const READ_MATRIX: Array<{ permission: string; rows: string[]; refused: string; decides?: true }> = [
  { permission: 'DASHBOARD_READ', rows: ['/'], refused: '/requests' },
  { permission: 'REQUESTS_READ', rows: ['/requests'], refused: '/requests/reports' },
  { permission: 'REQUEST_REPORTS_READ', rows: ['/requests/reports'], refused: '/requests' },
  { permission: 'OFFERS_READ', rows: ['/offers'], refused: '/requests' },
  { permission: 'PROVIDERS_READ', rows: ['/providers'], refused: '/customers' },
  { permission: 'CUSTOMERS_READ', rows: ['/customers'], refused: '/providers' },
  { permission: 'SUPPORT_READ', rows: ['/support'], refused: '/customers' },
  { permission: 'FINANCE_READ', rows: ['/finance', '/finance/providers'], refused: '/finance/credit-ledger' },
  {
    permission: 'FINANCE_LEDGER_READ',
    rows: ['/finance/credit-ledger', '/finance/manual-adjustments'],
    refused: '/finance',
  },
  { permission: 'PACKAGE_PURCHASES_READ', rows: ['/package-purchases'], refused: '/package-refunds' },
  { permission: 'PACKAGE_REFUND_READ', rows: ['/package-refunds'], refused: '/package-purchases' },
  { permission: 'OFFER_REFUND_SCAN_READ', rows: ['/refund-scan'], refused: '/offers' },
  { permission: 'SHOWCASE_REVIEW_READ', rows: ['/showcase/reviews'], refused: '/showcase/placements' },
  { permission: 'SHOWCASE_PLACEMENTS_READ', rows: ['/showcase/placements'], refused: '/showcase/reviews' },
  { permission: 'SHOWCASE_LEADS_READ', rows: ['/showcase/leads'], refused: '/showcase/cards' },
  { permission: 'PROVIDER_REVIEWS_READ', rows: ['/provider-reviews/reports'], refused: '/showcase/reviews' },
  { permission: 'SHOWCASE_CARDS_READ', rows: ['/showcase/cards'], refused: '/showcase/leads' },
  {
    permission: 'SHOWCASE_TERMS_ACCEPTANCES_READ',
    rows: ['/showcase/price-terms'],
    refused: '/showcase/packages',
  },
  { permission: 'CATALOG_READ', rows: ['/categories'], refused: '/credit-packages' },
  { permission: 'SHOWCASE_PACKAGES_READ', rows: ['/showcase/packages'], refused: '/categories' },
  { permission: 'CREDIT_PACKAGES_READ', rows: ['/credit-packages'], refused: '/showcase/packages' },
  { permission: 'OPERATIONS_SETTINGS_READ', rows: ['/operations-settings'], refused: '/campaigns' },
  { permission: 'CAMPAIGNS_READ', rows: ['/campaigns'], refused: '/promotion-eligibility' },
  // The one row whose permission is a decision, not a read: its queue is where
  // the decisions are taken, so its forms are expected (and gated by it).
  {
    permission: 'PROMOTION_ELIGIBILITY_REVIEW',
    rows: ['/promotion-eligibility'],
    refused: '/campaigns',
    decides: true,
  },
  { permission: 'NOTIFICATION_LOGS_READ', rows: ['/notifications'], refused: '/operations-settings' },
  { permission: 'ADMIN_USERS_READ', rows: ['/users'], refused: '/company-settings' },
  { permission: 'COMPANY_SETTINGS_READ', rows: ['/company-settings'], refused: '/users' },
];

/** POST forms and server-action forms on the page, the sign-out form aside. */
async function writeControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    for (const form of Array.from(document.querySelectorAll('form'))) {
      if (form.getAttribute('action') === '/logout') continue;
      const method = (form.getAttribute('method') ?? 'get').toLowerCase();
      const serverAction = form.querySelector('input[name^="$ACTION"]') !== null;
      if (method === 'post' || serverAction) {
        const label = form.getAttribute('aria-label') ?? form.getAttribute('data-testid') ?? form.className;
        found.push(`form(${label})`);
      }
    }
    for (const button of Array.from(document.querySelectorAll('button[formaction]'))) {
      found.push(`button[formaction](${button.textContent?.trim() ?? ''})`);
    }
    return found;
  });
}

test.describe('admin RBAC matrix (ADMIN-DESIGN-001 Faz 4)', () => {
  for (const { permission, rows, refused, decides } of READ_MATRIX) {
    test(`${permission} alone: its rows, nothing else, and no write control`, async ({ browser }) => {
      const staff = await createStaffAdmin([permission]);
      const admin = await Actor.open(browser, 'staff', primaryRuntime);

      try {
        await admin.loginToAdmin(staff.email, staff.password);
        const [first] = rows as [string, ...string[]];
        // `/` — where signing in, the brand mark and "Panele dön" lead — opens
        // the dashboard for its reader and the first held row for anyone else,
        // never /yetkisiz (which "Panele dön" used to loop back to).
        await admin.gotoAdmin('/');
        await expect(admin.page).toHaveURL((url) => url.pathname === first);
        await assertNoErrorScreen(admin.page);

        const sidebar = admin.page.locator('#admin-sidebar');
        const hrefs = await sidebar
          .locator('.admin-sidebar-link')
          .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
        expect(hrefs, `${permission}: sidebar rows`).toEqual(rows);
        await expect(sidebar.getByRole('link', { name: 'Roller ve izinler' })).toHaveCount(0);
        await expect(admin.page.getByTestId('admin-account-role')).toHaveText('Yetkili personel · 1 yetki');

        for (const row of rows) {
          await admin.gotoAdmin(row);
          await expect(admin.page, row).not.toHaveURL(/\/(yetkisiz|login)(\?|$)/);
          await assertNoErrorScreen(admin.page);
          if (!decides) {
            expect(await writeControls(admin.page), `${permission} on ${row}: write controls`).toEqual([]);
          }
        }

        await admin.gotoAdmin(refused);
        await expect(admin.page, refused).toHaveURL(/\/yetkisiz$/);
        await expect(admin.page.getByRole('heading', { name: /yetkiniz yok/i })).toBeVisible();
        // Root screens stay root whatever a role holds.
        await admin.gotoAdmin('/roles');
        await expect(admin.page).toHaveURL(/\/yetkisiz$/);
      } finally {
        await admin.close();
      }
    });
  }
});
