import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createOfferPackage,
  createStaffAdmin,
  prisma,
} from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * BUG-RBAC-STATUS-001: the category and credit-package screens offer the
 * status control to STATUS holders and the business fields to WRITE holders.
 * Neither control is offered to someone the API would refuse. The API side of
 * the same rule is pinned in apps/api/test/admin-status-permission-delta.spec.ts.
 */

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.loginToAdmin(account.email, account.password);
  return actor;
}

test.describe('status permission on edit screens', () => {
  test('category: WRITE edits the fields with the status locked, STATUS moves only the status', async ({
    browser,
  }) => {
    const category = await createCategory(3, { namePrefix: 'E2E Durum' });
    const writer = await openAs(browser, ['CATALOG_READ', 'CATEGORIES_WRITE']);
    const switcher = await openAs(browser, ['CATALOG_READ', 'CATEGORIES_STATUS']);

    try {
      await writer.gotoAdmin(`/categories/${category.slug}`);
      await assertNoErrorScreen(writer.page);
      const form = writer.page.locator('form', {
        has: writer.page.getByRole('button', { name: 'Kategoriyi kaydet' }),
      });
      // The status select is shown, but cannot be moved, and the status panel
      // is absent.
      await expect(form.locator('select[disabled]:has(option[value="INACTIVE"])')).toHaveCount(1);
      await expect(writer.page.getByRole('heading', { name: 'Kategori durumu' })).toHaveCount(0);
      await form.locator('input[name="name"]').fill(`${category.name} yeni`);
      await form.getByRole('button', { name: 'Kategoriyi kaydet' }).click();
      await expect
        .poll(async () => (await prisma().serviceCategory.findUniqueOrThrow({ where: { id: category.id } })).name)
        .toBe(`${category.name} yeni`);
      await assertNoErrorScreen(writer.page);
      const afterWrite = await prisma().serviceCategory.findUniqueOrThrow({ where: { id: category.id } });
      expect(afterWrite.status).toBe('ACTIVE');

      await switcher.gotoAdmin(`/categories/${category.slug}`);
      await assertNoErrorScreen(switcher.page);
      // No business form: the fields are shown read-only.
      await expect(switcher.page.getByRole('button', { name: 'Kategoriyi kaydet' })).toHaveCount(0);
      await expect(switcher.page.getByTestId('category-read-only')).toBeVisible();
      const panel = switcher.page.locator('.admin-action-panel', {
        has: switcher.page.getByRole('heading', { name: 'Kategori durumu' }),
      });
      await panel.locator('select[name="status"]').selectOption('INACTIVE');
      await panel.getByRole('button', { name: 'Durumu güncelle' }).click();
      await expect
        .poll(async () => (await prisma().serviceCategory.findUniqueOrThrow({ where: { id: category.id } })).status)
        .toBe('INACTIVE');
      const afterStatus = await prisma().serviceCategory.findUniqueOrThrow({ where: { id: category.id } });
      expect(afterStatus.name).toBe(`${category.name} yeni`);
    } finally {
      await writer.close();
      await switcher.close();
    }
  });

  test('credit package: WRITE edits the fields with isActive locked, STATUS only switches it', async ({
    browser,
  }) => {
    const pkg = await createOfferPackage({ type: 'ONE_TIME_CREDITS', name: 'E2E Durum Paketi' });
    const writer = await openAs(browser, ['CREDIT_PACKAGES_READ', 'CREDIT_PACKAGES_WRITE']);
    const switcher = await openAs(browser, ['CREDIT_PACKAGES_READ', 'CREDIT_PACKAGES_STATUS']);

    try {
      await writer.gotoAdmin(`/credit-packages/${pkg.id}`);
      await assertNoErrorScreen(writer.page);
      const form = writer.page.locator('form', {
        has: writer.page.getByRole('button', { name: 'Değişiklikleri kaydet' }),
      });
      await expect(form.locator('select[disabled]:has(option[value="false"])')).toHaveCount(1);
      await expect(writer.page.getByRole('button', { name: /Paketi (pasifleştir|aktifleştir)/ })).toHaveCount(0);
      // The price the page prints (e.g. "1.499,00") must pass the field's own
      // pattern. The pattern was once double-escaped in JSX and refused every
      // price with a thousands separator, so the form never submitted.
      const price = form.locator('input[name="priceAmount"]');
      expect(await price.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
      await form.locator('input[name="name"]').fill(`${pkg.name} yeni`);
      await form.getByRole('button', { name: 'Değişiklikleri kaydet' }).click();
      await expect(writer.page).toHaveURL(/ok=saved/);
      const afterWrite = await prisma().offerCreditPackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(afterWrite.name).toBe(`${pkg.name} yeni`);
      expect(afterWrite.isActive).toBe(true);

      await switcher.gotoAdmin(`/credit-packages/${pkg.id}`);
      await assertNoErrorScreen(switcher.page);
      await expect(switcher.page.getByRole('button', { name: 'Değişiklikleri kaydet' })).toHaveCount(0);
      await expect(switcher.page.getByTestId('credit-package-read-only')).toBeVisible();
      await switcher.page.getByRole('button', { name: 'Paketi pasifleştir' }).click();
      await expect
        .poll(async () => (await prisma().offerCreditPackage.findUniqueOrThrow({ where: { id: pkg.id } })).isActive)
        .toBe(false);
      const afterStatus = await prisma().offerCreditPackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(afterStatus.name).toBe(`${pkg.name} yeni`);
    } finally {
      await writer.close();
      await switcher.close();
    }
  });

  test('a super admin edits fields and status in one save', async ({ browser }) => {
    const category = await createCategory(3, { namePrefix: 'E2E Durum SA' });
    const admin = await openAs(browser, 'super');

    try {
      await admin.gotoAdmin(`/categories/${category.slug}`);
      const form = admin.page.locator('form', {
        has: admin.page.getByRole('button', { name: 'Kategoriyi kaydet' }),
      });
      await form.locator('input[name="name"]').fill(`${category.name} SA`);
      await form.locator('select[name="status"]').selectOption('INACTIVE');
      await form.getByRole('button', { name: 'Kategoriyi kaydet' }).click();
      await expect
        .poll(async () => (await prisma().serviceCategory.findUniqueOrThrow({ where: { id: category.id } })).status)
        .toBe('INACTIVE');
      const after = await prisma().serviceCategory.findUniqueOrThrow({ where: { id: category.id } });
      expect(after.name).toBe(`${category.name} SA`);
    } finally {
      await admin.close();
    }
  });
});
