import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { clickBeforeHydration, confirmThrough, waitForHydration } from '../src/confirm-dialog';
import { createAdmin, createStaffAdmin, prisma, uniqueSuffix } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Faz 1, in the browser.
 *
 * The confirmations that need a real session to be meaningful, and the server
 * rules behind them driven the way a curious staff member would — through the
 * screen, and then straight at the API with the same cookie:
 *
 * - a super admin's account: no switch for an ADMIN holding
 *   ADMIN_USERS_STATUS, and the API refuses that ADMIN too; a super admin
 *   reactivating one is told plainly what comes back;
 * - reactivating an ADMIN, seen by a super admin, lists the roles and the
 *   critical permissions that return;
 * - creating a credit package or a category: without the status permission
 *   the form offers the inactive / DRAFT state only, and the API refuses the
 *   live one when the form is bypassed.
 *
 * The other screens of this phase (credit grant, role assign and reactivate,
 * the first vitrin approval, the offer-accept recharge, the placement-cancel
 * reason) are asserted in the specs that already drive those screens.
 */

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.page.setViewportSize({ width: 1440, height: 1200 });
  await actor.loginToAdmin(account.email, account.password);
  return { actor, account };
}

function api(page: Page) {
  return {
    patch: (path: string, data: unknown) => page.request.patch(`${primaryRuntime.apiUrl}${path}`, { data }),
    post: (path: string, data: unknown) => page.request.post(`${primaryRuntime.apiUrl}${path}`, { data }),
  };
}

async function isActive(userId: string) {
  return (await prisma().user.findUniqueOrThrow({ where: { id: userId }, select: { isActive: true } })).isActive;
}

test.describe('ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Faz 1', () => {
  test('a super admin account: no switch for an ADMIN with ADMIN_USERS_STATUS, and the API refuses it too', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    // A deactivated super admin: the escalation an ADMIN used to be able to undo.
    const target = await createAdmin();
    await prisma().user.update({ where: { id: target.id }, data: { isActive: false } });
    const { actor } = await openAs(browser, ['ADMIN_USERS_READ', 'ADMIN_USERS_STATUS']);
    const page = actor.page;

    try {
      await actor.gotoAdmin(`/users/${target.id}`);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('user-status')).toHaveText('Pasif');
      await expect(page.getByTestId('user-status-form')).toHaveCount(0);
      await expect(page.getByTestId('user-status-note')).toHaveText(
        'Süper yönetici hesabının durumunu yalnız bir süper yönetici değiştirebilir.',
      );

      // Straight at the API with the same session: refused, in both directions.
      const reactivate = await api(page).patch(`/users/${target.id}/status`, { isActive: true });
      expect(reactivate.status()).toBe(403);
      expect((await reactivate.json()).code).toBe('SUPER_ADMIN_TARGET_REQUIRES_SUPER_ADMIN');
      expect(await isActive(target.id)).toBe(false);

      const live = await createAdmin();
      const deactivate = await api(page).patch(`/users/${live.id}/status`, { isActive: false });
      expect(deactivate.status()).toBe(403);
      expect(await isActive(live.id)).toBe(true);

      // An ADMIN target is still this account's to switch.
      const colleague = await createStaffAdmin(['DASHBOARD_READ']);
      const ordinary = await api(page).patch(`/users/${colleague.id}/status`, { isActive: false });
      expect(ordinary.status()).toBe(200);
      expect(await isActive(colleague.id)).toBe(false);
    } finally {
      await actor.close();
    }

    // A super admin may, and is told what comes back before it does.
    const root = await openAs(browser, 'super');
    try {
      const page = root.actor.page;
      await root.actor.gotoAdmin(`/users/${target.id}`);
      const trigger = page.getByTestId('user-activate');
      await waitForHydration(trigger);
      await trigger.click();
      const dialog = page.getByTestId('user-activate-dialog');
      await expect(dialog.getByRole('heading')).toHaveText('Süper yönetici hesabı aktifleştirilsin mi?');
      await expect(dialog.getByRole('button', { name: 'Vazgeç' })).toBeFocused();
      await expect(dialog.getByTestId('user-activate-super-admin')).toContainText('Bu bir süper yönetici hesabı.');
      await expect(dialog.getByTestId('user-activate-super-admin')).toContainText('Tüm izinleri');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(dialog).toBeHidden();
      await page.waitForTimeout(300);
      expect(await isActive(target.id)).toBe(false);

      await confirmThrough(trigger, 'Evet, aktifleştir');
      await expect(page.getByTestId('user-status')).toHaveText('Aktif');
      await expect.poll(() => isActive(target.id)).toBe(true);
    } finally {
      await root.actor.close();
    }
  });

  test('reactivating an ADMIN, seen by a super admin, lists the roles and the critical permissions that return', async ({
    browser,
  }) => {
    const target = await createStaffAdmin(['CREDITS_GRANT', 'SUPPORT_READ']);
    await prisma().user.update({ where: { id: target.id }, data: { isActive: false } });
    const { actor } = await openAs(browser, 'super');
    const page = actor.page;

    try {
      await actor.gotoAdmin(`/users/${target.id}`);
      await assertNoErrorScreen(page);
      const trigger = page.getByTestId('user-activate');
      await waitForHydration(trigger);
      await trigger.click();
      const dialog = page.getByTestId('user-activate-dialog');
      await expect(dialog.getByTestId('user-activate-impact')).toContainText(target.name);
      await expect(dialog.getByTestId('user-activate-scope')).toContainText('1 aktif rolden toplam 2 izin');
      await expect(dialog.getByTestId('user-activate-critical')).toContainText('CREDITS_GRANT');
      await expect(dialog.getByTestId('user-activate-critical')).not.toContainText('SUPPORT_READ');
      await dialog.getByRole('button', { name: 'Evet, aktifleştir' }).click();
      await expect(page.getByTestId('user-status')).toHaveText('Aktif');
      await expect.poll(() => isActive(target.id)).toBe(true);
    } finally {
      await actor.close();
    }
  });

  test('a credit package: WRITE alone offers and creates an inactive package; the API refuses an active one', async ({
    browser,
  }) => {
    const suffix = uniqueSuffix();
    const slug = `e2e-r4-paket-${suffix}`;
    const writer = await openAs(browser, ['CREDIT_PACKAGES_READ', 'CREDIT_PACKAGES_WRITE']);
    const both = await openAs(browser, ['CREDIT_PACKAGES_READ', 'CREDIT_PACKAGES_WRITE', 'CREDIT_PACKAGES_STATUS']);

    try {
      let page = writer.actor.page;
      await writer.actor.gotoAdmin('/credit-packages/new');
      await assertNoErrorScreen(page);
      const status = page.getByTestId('credit-package-new-status');
      await expect(status).toBeDisabled();
      await expect(status).toHaveValue('false');
      await expect(status.locator('option')).toHaveText(['Pasif (satışa kapalı)']);
      await expect(page.getByTestId('credit-package-new-status-help')).toContainText('Paket pasif oluşturulur');

      await page.locator('input[name="name"]').fill(`E2E R4 Paket ${suffix}`);
      await page.locator('input[name="slug"]').fill(slug);
      await page.locator('input[name="creditAmount"]').fill('10');
      await page.locator('input[name="priceAmount"]').fill('149,90');
      await page.getByRole('button', { name: 'Paketi oluştur' }).click();
      await expect(page).toHaveURL(/\/credit-packages\/[^/?]+\?ok=created$/);
      const created = await prisma().offerCreditPackage.findUniqueOrThrow({ where: { slug } });
      expect(created.isActive).toBe(false);

      // The form bypassed: an active create, and one that relies on the
      // active default, are both refused and write nothing.
      for (const extra of [{ isActive: true }, {}]) {
        const bypassSlug = `e2e-r4-bypass-${uniqueSuffix()}`;
        const response = await api(page).post('/credit-packages', {
          name: 'E2E R4 Bypass',
          slug: bypassSlug,
          creditAmount: 10,
          priceAmount: 10000,
          ...extra,
        });
        expect(response.status()).toBe(403);
        expect(await prisma().offerCreditPackage.count({ where: { slug: bypassSlug } })).toBe(0);
      }

      // With the status permission the choice is there, active by default.
      page = both.actor.page;
      await both.actor.gotoAdmin('/credit-packages/new');
      await expect(page.getByTestId('credit-package-new-status')).toBeEnabled();
      await expect(page.getByTestId('credit-package-new-status')).toHaveValue('true');
    } finally {
      // Left active, a fixture package breaks lemon-checkout's one-package view.
      await prisma().offerCreditPackage.updateMany({ where: { slug: { startsWith: 'e2e-r4-' } }, data: { isActive: false } });
      await Promise.all([writer.actor.close(), both.actor.close()]);
    }
  });

  test('a category: WRITE alone offers and creates a DRAFT; the API refuses a live one and the ACTIVE default', async ({
    browser,
  }) => {
    const suffix = uniqueSuffix();
    const slug = `e2e-r4-kategori-${suffix}`;
    const writer = await openAs(browser, ['CATALOG_READ', 'CATEGORIES_WRITE']);
    const both = await openAs(browser, ['CATALOG_READ', 'CATEGORIES_WRITE', 'CATEGORIES_STATUS']);

    try {
      let page = writer.actor.page;
      await writer.actor.gotoAdmin('/categories/new');
      await assertNoErrorScreen(page);
      const status = page.getByTestId('category-new-status');
      await expect(status).toBeDisabled();
      await expect(status.locator('option')).toHaveCount(1);
      await expect(page.getByTestId('category-new-status-help')).toContainText('kategori durumu yetkisi');

      await page.locator('input[name="name"]').fill(`E2E R4 Kategori ${suffix}`);
      await page.locator('input[name="slug"]').fill(slug);
      await page.getByRole('button', { name: 'Kategoriyi oluştur' }).click();
      await expect(page).toHaveURL(new RegExp(`/categories/${slug}$`));
      expect((await prisma().serviceCategory.findUniqueOrThrow({ where: { slug } })).status).toBe('DRAFT');

      for (const extra of [{ status: 'ACTIVE' }, { status: 'INACTIVE' }, {}]) {
        const bypassSlug = `e2e-r4-bypass-${uniqueSuffix()}`;
        const response = await api(page).post('/categories', {
          name: 'E2E R4 Bypass',
          slug: bypassSlug,
          offerCreditCost: 2,
          ...extra,
        });
        expect(response.status(), JSON.stringify(extra)).toBe(403);
        expect(await prisma().serviceCategory.count({ where: { slug: bypassSlug } })).toBe(0);
      }

      page = both.actor.page;
      await both.actor.gotoAdmin('/categories/new');
      await expect(page.getByTestId('category-new-status')).toBeEnabled();
      await expect(page.getByTestId('category-new-status').locator('option')).toHaveCount(3);
    } finally {
      await Promise.all([writer.actor.close(), both.actor.close()]);
    }
  });

  test.describe('a click before hydration writes nothing (the confirmation proof)', () => {
    test('a new R4 confirmation: "Hesabı aktifleştir" clicked before React hydrates is refused', async ({ browser }) => {
      const target = await createStaffAdmin(['DASHBOARD_READ']);
      await prisma().user.update({ where: { id: target.id }, data: { isActive: false } });
      const { actor } = await openAs(browser, 'super');
      const page = actor.page;

      try {
        const trigger = page.getByTestId('user-activate');
        await clickBeforeHydration(page, `${primaryRuntime.adminUrl}/users/${target.id}`, trigger);

        // React replayed the queued submission to the action, which had no
        // proof: refused before any request, and said so.
        await expect(page.getByTestId('user-status-error')).toContainText('onay penceresinden onay alınamadı');
        await expect(page.getByTestId('user-activate-dialog')).toBeHidden();
        expect(await isActive(target.id)).toBe(false);

        // The same screen, hydrated, still works through the dialog.
        await confirmThrough(page.getByTestId('user-activate'), 'Evet, aktifleştir');
        await expect(page.getByTestId('user-status')).toHaveText('Aktif');
        await expect.poll(() => isActive(target.id)).toBe(true);
      } finally {
        await actor.close();
      }
    });

    test('an older confirmation: "Rolü pasifleştir" clicked before React hydrates is refused', async ({ browser }) => {
      const owner = await createAdmin();
      const role = await prisma().adminRole.create({
        data: {
          key: `e2e-r4-hydration-${uniqueSuffix()}`,
          name: 'E2E Hydration Rolü',
          createdById: owner.id,
          permissions: { create: [{ permission: 'SUPPORT_READ' }] },
        },
        select: { id: true },
      });
      const roleActive = async () =>
        (await prisma().adminRole.findUniqueOrThrow({ where: { id: role.id }, select: { isActive: true } })).isActive;
      const { actor } = await openAs(browser, 'super');
      const page = actor.page;

      try {
        await clickBeforeHydration(page, `${primaryRuntime.adminUrl}/roles/${role.id}`, page.getByTestId('role-deactivate'));
        await expect(page.getByTestId('role-error')).toContainText('onay penceresinden onay alınamadı');
        expect(await roleActive()).toBe(true);

        await confirmThrough(page.getByTestId('role-deactivate'), 'Evet, pasifleştir');
        await expect(page.getByTestId('role-status')).toHaveText('Pasif');
        await expect.poll(roleActive).toBe(false);
      } finally {
        await actor.close();
      }
    });
  });
});
