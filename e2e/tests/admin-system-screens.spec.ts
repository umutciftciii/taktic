import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCustomer, createStaffAdmin, prisma } from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESIGN-001 Faz 3G — sistem ve yönetim: /company-settings,
 * /notifications/[id], /users/new, /users/[id], /roles and /roles/[id],
 * through the real Next screens against the real API.
 *
 * What the redesign could quietly break, pinned here:
 *
 * - The four writes that now ask first — deactivating an account, taking a
 *   role back, saving a role's permission matrix, deactivating a role — write
 *   nothing when the dialog is cancelled, write exactly once when it is
 *   confirmed, and state the counts the data holds (the role's live holders
 *   and how many of them are active; the permissions an account really loses).
 * - The gates: ADMIN_USERS_STATUS without root sees the status switch and no
 *   invite link or role control; COMPANY_SETTINGS_READ alone sees the footer
 *   as text; /users/new and /roles* stay the super admin's.
 * - The matrix draws the whole catalogue, grouped, with the raw value under
 *   each label.
 * - No page is wider than the window at 320, 390, 768 and 1440 with long
 *   names.
 */

const SCREENS_DIR = resolve(artifactsDir, 'faz-3g-screens');
const WIDTHS = [320, 390, 768, 1440];

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.page.setViewportSize({ width: 1440, height: 1200 });
  await actor.loginToAdmin(account.email, account.password);
  return { actor, account };
}

/**
 * Waits until React owns `locator`'s element. A ConfirmDialog trigger clicked
 * before hydration is a plain submit button — the form would post without
 * asking — so every dialog test waits for this first.
 */
async function hydrated(locator: Locator) {
  await expect
    .poll(() =>
      locator.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps'))),
    )
    .toBe(true);
}

async function expectNoPageOverflow(page: Page, label: string) {
  const { overflow, culprits } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const scrolls = (element: Element | null): boolean => {
      for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll|hidden)/.test(style.overflowX) && node.scrollWidth > node.clientWidth) return true;
      }
      return false;
    };
    const culprits = [...document.querySelectorAll('main *')]
      .filter((element) => element.getBoundingClientRect().right > width + 1 && !scrolls(element))
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`);
    return { overflow: document.documentElement.scrollWidth - width, culprits };
  });
  expect(overflow, `${label}: page overflow (${culprits.join(', ')})`).toBeLessThanOrEqual(1);
}

async function capture(page: Page, name: string) {
  const project = test.info().project.name;
  mkdirSync(SCREENS_DIR, { recursive: true });
  const width = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: resolve(SCREENS_DIR, `${project}-${name}-${width}.png`) });
}

/** A role with `permissions`, held by `holders` (the last `inactive` of them deactivated). */
async function seedRole(options: { name: string; description?: string; permissions: string[]; holders: number; inactive: number }) {
  const db = prisma();
  const owner = await createAdmin();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const role = await db.adminRole.create({
    data: {
      key: `e2e-faz3g-${suffix}`,
      name: options.name,
      description: options.description ?? null,
      createdById: owner.id,
      permissions: { create: options.permissions.map((permission) => ({ permission: permission as never })) },
    },
    select: { id: true, key: true },
  });
  const users = [];
  for (let index = 0; index < options.holders; index += 1) {
    const staff = await createStaffAdmin(['DASHBOARD_READ']);
    await db.adminRoleAssignment.create({ data: { userId: staff.id, roleId: role.id, assignedById: owner.id } });
    if (index >= options.holders - options.inactive) {
      await db.user.update({ where: { id: staff.id }, data: { isActive: false } });
    }
    users.push(staff);
  }
  return { role, users };
}

async function rolePermissions(roleId: string): Promise<string[]> {
  const rows = await prisma().adminRolePermission.findMany({ where: { roleId }, select: { permission: true } });
  return rows.map((row) => row.permission as string).sort();
}

test.describe('ADMIN-DESIGN-001 Faz 3G — sistem ve yönetim', () => {
  test('role detail: the matrix save and the deactivation ask first, with the holders the role really has', async ({ browser }) => {
    test.setTimeout(180_000);
    const { role } = await seedRole({
      name: 'E2E Faz 3G Destek Rolü',
      description: 'Destek taleplerini okur.',
      permissions: ['SUPPORT_READ'],
      holders: 3,
      inactive: 1,
    });
    const catalogueSize = (await prisma().$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM unnest(enum_range(NULL::"AdminPermission"))`,
    ))[0]!.n;
    const { actor } = await openAs(browser, 'super');
    const page = actor.page;

    try {
      // The list counts the same holders.
      await actor.gotoAdmin('/roles');
      await assertNoErrorScreen(page);
      const row = page.locator(`[data-testid="role-row"][data-role-id="${role.id}"]`);
      await expect(row).toContainText('E2E Faz 3G Destek Rolü');
      await expect(row.locator('td').nth(3)).toHaveText('3');
      // The new-role matrix is the whole catalogue, grouped.
      const createMatrix = page.getByTestId('role-create-matrix');
      await expect(createMatrix.locator('input[name="permissions"]')).toHaveCount(catalogueSize);
      await expect(createMatrix.locator('code.admin-permission-code')).toHaveCount(catalogueSize);
      await expect(page.getByTestId('permission-matrix-summary')).toContainText(`${catalogueSize} izinden 0 tanesi seçili`);
      await capture(page, 'roles');

      await actor.gotoAdmin(`/roles/${role.id}`);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('role-fact-holders')).toContainText('3');
      await expect(page.getByTestId('role-fact-holders')).toContainText('2 tanesi aktif');
      await expect(page.getByTestId('role-fact-permissions')).toContainText(`1 / ${catalogueSize}`);
      await expect(page.getByTestId('role-holders').locator('tbody tr')).toHaveCount(3);

      // ---- İzinleri kaydet: closed until something changes ------------------
      const matrix = page.getByTestId('role-permission-matrix');
      const save = page.getByTestId('role-permissions-save');
      await hydrated(save);
      await expect(save).toBeDisabled();
      await matrix.locator('input[value="SUPPORT_WRITE"]').check();
      await matrix.locator('input[value="REQUESTS_READ"]').check();
      await matrix.locator('input[value="SUPPORT_READ"]').uncheck();
      await expect(page.getByTestId('role-permissions-pending')).toHaveText(
        'Kaydedilmemiş değişiklik: 2 izin eklenecek, 1 izin kaldırılacak.',
      );
      await expect(matrix.locator('[data-area="Destek"] [data-testid="permission-group-count"]')).toHaveText('1/2');

      // Vazgeç puts the boxes back and closes the save again.
      await page.getByTestId('role-permissions-form').getByRole('button', { name: 'Vazgeç' }).click();
      await expect(page.getByTestId('role-permissions-pending')).toContainText('Değişiklik yok');
      await expect(save).toBeDisabled();
      await expect(matrix.locator('input[value="SUPPORT_READ"]')).toBeChecked();

      await matrix.locator('input[value="SUPPORT_WRITE"]').check();
      await matrix.locator('input[value="REQUESTS_READ"]').check();
      await matrix.locator('input[value="SUPPORT_READ"]').uncheck();
      await save.click();
      const saveDialog = page.getByTestId('role-permissions-save-dialog');
      await expect(saveDialog).toBeVisible();
      await expect(saveDialog.getByTestId('role-permissions-diff')).toContainText('2 izin eklenecek, 1 izin kaldırılacak');
      await expect(saveDialog.getByTestId('role-permissions-impact')).toContainText('Bu rolü taşıyan 3 hesap (2 tanesi aktif)');
      await expect(saveDialog).toContainText('SUPPORT_WRITE');
      await expect(saveDialog).toContainText('Talepler · okuma');
      await capture(page, 'role-permissions-dialog');
      await saveDialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(saveDialog).toBeHidden();
      expect(await rolePermissions(role.id)).toEqual(['SUPPORT_READ']);

      await save.click();
      await saveDialog.getByRole('button', { name: 'Evet, izinleri kaydet' }).click();
      await expect(page.getByTestId('role-ok')).toHaveText('İzinler güncellendi.');
      await expect.poll(() => rolePermissions(role.id)).toEqual(['REQUESTS_READ', 'SUPPORT_WRITE']);
      // The form starts again from the stored set.
      await expect(page.getByTestId('role-permissions-pending')).toContainText('Değişiklik yok');
      await expect(page.getByTestId('role-permission-matrix').locator('input[value="REQUESTS_READ"]')).toBeChecked();

      // ---- Rolü pasifleştir ------------------------------------------------
      const deactivate = page.getByTestId('role-deactivate');
      await hydrated(deactivate);
      await expect(page.getByTestId('role-status-form').locator('input[name="confirm"]')).toHaveCount(1);
      await deactivate.click();
      const deactivateDialog = page.getByTestId('role-deactivate-dialog');
      await expect(deactivateDialog.getByTestId('role-deactivate-impact')).toContainText(
        'Bu rolü taşıyan 3 hesap (2 tanesi aktif) bu rolün 2 iznini hemen kaybeder',
      );
      await capture(page, 'role-deactivate-dialog');
      await deactivateDialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(deactivateDialog).toBeHidden();
      expect((await prisma().adminRole.findUniqueOrThrow({ where: { id: role.id } })).isActive).toBe(true);

      await deactivate.click();
      await deactivateDialog.getByRole('button', { name: 'Evet, pasifleştir' }).click();
      await expect(page.getByTestId('role-ok')).toContainText('Rol pasifleştirildi');
      await expect(page.getByTestId('role-status')).toHaveText('Pasif');
      await expect.poll(async () => (await prisma().adminRole.findUniqueOrThrow({ where: { id: role.id } })).isActive).toBe(false);

      // Reactivating goes straight through.
      await page.getByTestId('role-activate').click();
      await expect(page.getByTestId('role-status')).toHaveText('Aktif');
      await expect.poll(async () => (await prisma().adminRole.findUniqueOrThrow({ where: { id: role.id } })).isActive).toBe(true);

      // Renaming keeps working, and the key is shown, not sent.
      await page.getByTestId('role-info-card').locator('input[name="name"]').fill('E2E Faz 3G Destek Rolü (yeni ad)');
      await page.getByTestId('role-info-card').getByRole('button', { name: 'Kaydet' }).click();
      await expect(page.getByTestId('role-ok')).toHaveText('Rol bilgileri güncellendi.');
      await expect(page.getByTestId('role-info-card').locator('input[name="key"]')).toHaveCount(0);
      await expect(page.getByTestId('role-info-card')).toContainText(role.key);
    } finally {
      await actor.close();
    }
  });

  test('staff account: deactivation asks first; ADMIN_USERS_STATUS without root gets no invite or role control', async ({ browser }) => {
    test.setTimeout(120_000);
    const target = await createStaffAdmin(['DASHBOARD_READ']);
    // A password-less account, so the super admin sees the invite control.
    await prisma().user.update({ where: { id: target.id }, data: { passwordHash: null } });
    const { actor, account } = await openAs(browser, ['ADMIN_USERS_READ', 'ADMIN_USERS_STATUS']);
    const page = actor.page;

    try {
      await actor.gotoAdmin(`/users/${target.id}`);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('user-status')).toHaveText('Aktif');
      // Root capabilities: neither drawn nor read.
      await expect(page.getByTestId('user-invite-card')).toHaveCount(0);
      await expect(page.getByTestId('user-roles-card')).toContainText('yalnız süper adminlerde');
      await expect(page.getByRole('button', { name: 'Ata' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Geri al' })).toHaveCount(0);
      await expect(page.getByTestId('user-fact-roles')).toHaveCount(0);

      const deactivate = page.getByTestId('user-deactivate');
      await hydrated(deactivate);
      await deactivate.click();
      const dialog = page.getByTestId('user-deactivate-dialog');
      await expect(dialog.getByTestId('user-deactivate-impact')).toContainText('Kullanıcı bir daha giriş yapamaz.');
      await capture(page, 'user-deactivate-dialog');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(dialog).toBeHidden();
      expect((await prisma().user.findUniqueOrThrow({ where: { id: target.id } })).isActive).toBe(true);

      await deactivate.click();
      await dialog.getByRole('button', { name: 'Evet, pasifleştir' }).click();
      await expect(page.getByTestId('user-status')).toHaveText('Pasif');
      await expect.poll(async () => (await prisma().user.findUniqueOrThrow({ where: { id: target.id } })).isActive).toBe(false);

      await page.getByTestId('user-activate').click();
      await expect(page.getByTestId('user-status')).toHaveText('Aktif');
      await expect.poll(async () => (await prisma().user.findUniqueOrThrow({ where: { id: target.id } })).isActive).toBe(true);

      // One's own active account has no switch.
      await actor.gotoAdmin(`/users/${account.id}`);
      await expect(page.getByTestId('user-status-note')).toHaveText('Kendi hesabınızı pasifleştiremezsiniz.');
      await expect(page.getByTestId('user-status-form')).toHaveCount(0);
    } finally {
      await actor.close();
    }

    // Read alone: the page, and no switch.
    const reader = await openAs(browser, ['ADMIN_USERS_READ']);
    try {
      await reader.actor.gotoAdmin(`/users/${target.id}`);
      await assertNoErrorScreen(reader.actor.page);
      await expect(reader.actor.page.getByTestId('user-header')).toBeVisible();
      await expect(reader.actor.page.getByTestId('user-status-form')).toHaveCount(0);
      for (const path of ['/users/new', '/roles', `/roles/${(await prisma().adminRole.findFirstOrThrow()).id}`]) {
        await reader.actor.gotoAdmin(path);
        await expect(reader.actor.page, path).toHaveURL(/\/yetkisiz$/);
      }
    } finally {
      await reader.actor.close();
    }
  });

  test('super admin: a new staff account shows its link once; a role is assigned, and taking it back asks first', async ({ browser }) => {
    test.setTimeout(150_000);
    const { role } = await seedRole({ name: 'E2E Faz 3G Müşteri Rolü', permissions: ['CUSTOMERS_READ', 'DASHBOARD_READ'], holders: 0, inactive: 0 });
    const { actor } = await openAs(browser, 'super');
    const page = actor.page;
    const email = `e2e-faz3g-${Date.now()}@example.test`;

    try {
      await actor.gotoAdmin('/users/new');
      await assertNoErrorScreen(page);
      await capture(page, 'users-new');
      await page.locator('input[name="name"]').fill('E2E Faz 3G Personel');
      await page.locator('input[name="email"]').fill(email);
      await page.getByRole('button', { name: 'Admin Kullanıcısı Oluştur' }).click();
      const link = page.getByTestId('admin-invite-url');
      await expect(link).toContainText('/admin-invite');
      // The link lives in the page, never in the address bar.
      await expect(page).toHaveURL(/\/users\/new$/);
      const created = await prisma().user.findFirstOrThrow({ where: { email }, select: { id: true, role: true } });
      expect(created.role).toBe('ADMIN');
      expect(await prisma().adminRoleAssignment.count({ where: { userId: created.id } })).toBe(0);

      await page.getByRole('link', { name: 'Kullanıcı detayına git' }).click();
      await expect(page).toHaveURL(new RegExp(`/users/${created.id}$`));
      await expect(page.getByTestId('user-invite-card').getByRole('button', { name: 'Davet linki oluştur' })).toBeVisible();

      // Assign.
      await page.getByTestId('user-role-assign').locator('select[name="roleId"]').selectOption(role.id);
      await page.getByTestId('user-role-assign').getByRole('button', { name: 'Ata' }).click();
      await expect(page.getByTestId('role-assignment-ok')).toHaveText('Rol atandı.');
      await expect(page.locator(`[data-testid="user-role-row"][data-role-id="${role.id}"]`)).toBeVisible();
      await expect(page.getByTestId('user-fact-roles')).toContainText('2 izin');

      // Take it back: cancel writes nothing; confirm revokes once.
      const roleRow = page.locator(`[data-testid="user-role-row"][data-role-id="${role.id}"]`);
      const revoke = roleRow.getByTestId('user-role-revoke');
      await hydrated(revoke);
      await revoke.click();
      // Each row carries its own dialog.
      const dialog = roleRow.getByTestId('user-role-revoke-dialog');
      await expect(dialog.getByTestId('user-role-revoke-impact')).toContainText('Bu hesap 2 izni hemen kaybeder');
      await expect(dialog).toContainText('CUSTOMERS_READ');
      await capture(page, 'user-role-revoke-dialog');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(dialog).toBeHidden();
      expect(await prisma().adminRoleAssignment.count({ where: { userId: created.id, revokedAt: null } })).toBe(1);

      await revoke.click();
      await dialog.getByRole('button', { name: 'Evet, geri al' }).click();
      await expect(page.getByTestId('role-assignment-ok')).toHaveText('Rol geri alındı.');
      await expect
        .poll(() => prisma().adminRoleAssignment.count({ where: { userId: created.id, revokedAt: null } }))
        .toBe(0);
      await expect(page.getByText('Geri alınmış roller (1)')).toBeVisible();
    } finally {
      await actor.close();
    }
  });

  test('company settings: read-only role sees the footer as text; the writer gets the form', async ({ browser }) => {
    const reader = await openAs(browser, ['COMPANY_SETTINGS_READ']);
    try {
      await reader.actor.gotoAdmin('/company-settings');
      await assertNoErrorScreen(reader.actor.page);
      await expect(reader.actor.page.getByTestId('company-settings-readonly')).toBeVisible();
      await expect(reader.actor.page.getByTestId('company-settings-form')).toHaveCount(0);
      await expect(reader.actor.page.getByRole('button', { name: /kaydet/i })).toHaveCount(0);
      await expect(reader.actor.page.getByTestId('company-settings-technical')).toContainText('Teknik e-posta ayarları burada değil');
    } finally {
      await reader.actor.close();
    }

    const writer = await openAs(browser, ['COMPANY_SETTINGS_READ', 'COMPANY_SETTINGS_WRITE']);
    try {
      await writer.actor.gotoAdmin('/company-settings');
      await expect(writer.actor.page.getByTestId('company-settings-form')).toBeVisible();
      await expect(writer.actor.page.getByRole('button', { name: 'Değişiklikleri kaydet' })).toBeVisible();
      await capture(writer.actor.page, 'company-settings');
    } finally {
      await writer.actor.close();
    }
  });

  test('notification detail: retry drawn only for a retryable row and NOTIFICATION_RETRY', async ({ browser }) => {
    const customer = await createCustomer('E2E Faz 3G Bildirim');
    const failed = await prisma().notificationLog.create({
      data: {
        channel: 'EMAIL',
        template: 'request-received',
        maskedRecipient: 'e***@example.test',
        status: 'FAILED',
        errorCode: 'TRANSPORT_UNAVAILABLE',
        userId: customer.id,
        dedupeKey: `e2e-faz3g-${customer.id}`,
        failedAt: new Date(),
      },
      select: { id: true },
    });

    for (const [permissions, buttons] of [
      [['NOTIFICATION_LOGS_READ'], 0],
      [['NOTIFICATION_LOGS_READ', 'NOTIFICATION_RETRY'], 1],
    ] as const) {
      const { actor } = await openAs(browser, [...permissions]);
      try {
        await actor.gotoAdmin(`/notifications/${failed.id}`);
        await assertNoErrorScreen(actor.page);
        await expect(actor.page.getByTestId('notification-status')).toHaveText('Başarısız');
        await expect(actor.page.getByTestId('notification-masked-recipient')).toHaveText('e***@example.test');
        await expect(actor.page.getByTestId('notification-retry-button')).toHaveCount(buttons);
        if (buttons) await capture(actor.page, 'notification-detail');
      } finally {
        await actor.close();
      }
    }
  });

  test('no page is wider than the window, with long names', async ({ browser }) => {
    test.setTimeout(240_000);
    const longWord = 'Çokuzunbirkelimeolanrolveyahesapadıdenemesi';
    const { role, users } = await seedRole({
      name: `E2E Faz 3G ${longWord} Rolü`,
      description: `Uzun açıklama ${longWord}${longWord} ile satır kırılımı denetlenir.`,
      permissions: ['SUPPORT_READ', 'SUPPORT_WRITE', 'CATALOG_READ'],
      holders: 1,
      inactive: 0,
    });
    const holder = users[0]!;
    await prisma().user.update({
      where: { id: holder.id },
      data: { name: `E2E ${longWord} Personel`, passwordHash: null },
    });
    const customer = await createCustomer('E2E Faz 3G Taşma');
    const notification = await prisma().notificationLog.create({
      data: {
        channel: 'EMAIL',
        template: 'request-received',
        maskedRecipient: `u${'x'.repeat(40)}***@example.test`,
        status: 'FAILED',
        errorCode: 'TRANSPORT_UNAVAILABLE',
        userId: customer.id,
        dedupeKey: `e2e-faz3g-overflow-${customer.id}`,
        failedAt: new Date(),
      },
      select: { id: true },
    });
    const { actor } = await openAs(browser, 'super');
    const page = actor.page;
    const paths = [
      '/company-settings',
      `/notifications/${notification.id}`,
      '/users/new',
      `/users/${holder.id}`,
      '/roles',
      `/roles/${role.id}`,
    ];

    try {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of paths) {
          await actor.gotoAdmin(path);
          await assertNoErrorScreen(page);
          await expect(page.locator('main h1').first()).toBeVisible();
          await expectNoPageOverflow(page, `${path} @${width}`);
        }
        if (width === 320 || width === 390) {
          await actor.gotoAdmin(`/roles/${role.id}`);
          await capture(page, 'role-detail');
          await actor.gotoAdmin(`/users/${holder.id}`);
          await capture(page, 'user-detail');
        }
      }

      // The dialogs fit a phone too.
      await page.setViewportSize({ width: 320, height: 740 });
      await actor.gotoAdmin(`/roles/${role.id}`);
      const matrix = page.getByTestId('role-permission-matrix');
      await hydrated(page.getByTestId('role-permissions-save'));
      await matrix.locator('input[value="SUPPORT_READ"]').uncheck();
      await page.getByTestId('role-permissions-save').click();
      const dialog = page.getByTestId('role-permissions-save-dialog');
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(321);
      await capture(page, 'role-permissions-dialog');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
      expect(await rolePermissions(role.id)).toEqual(['CATALOG_READ', 'SUPPORT_READ', 'SUPPORT_WRITE']);
    } finally {
      await actor.close();
    }
  });
});
