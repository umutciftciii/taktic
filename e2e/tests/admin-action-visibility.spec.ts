import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  createStaffAdmin,
  uniqueLocation,
} from '../src/fixtures';
import { seedCustomerRequest } from '../src/request-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESIGN-000: a role opens what it holds, and no more than that.
 *
 * The API guards were already right. What these cases pin is the screen side
 * of the same contract (design D13):
 * - a page opens on its own read permission, even when a block on it belongs
 *   to another permission the role does not hold;
 * - that block is absent, not empty, and not a redirect to /yetkisiz;
 * - no write control is rendered without the exact permission its route asks
 *   for.
 * The API's refusals themselves are pinned in
 * apps/api/test/admin-provider-credits-read.spec.ts and admin-rbac-access.spec.ts.
 */

async function seedRequest() {
  const category = await createCategory(3);
  const customer = await createCustomer('E2E Yetki Müşteri');
  const request = await seedCustomerRequest({
    customerId: customer.id,
    categoryId: category.id,
    location: uniqueLocation(),
    content: 'full',
  });
  return { category, customer, request };
}

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.loginToAdmin(account.email, account.password);
  return actor;
}

async function expectOpen(page: Page, path: RegExp) {
  await expect(page).toHaveURL(path);
  await assertNoErrorScreen(page);
  await expect(page.getByRole('heading', { name: /yetkiniz yok/i })).toHaveCount(0);
}

test.describe('admin action visibility', () => {
  test('REQUESTS_READ alone opens a request, without the blocks it does not hold', async ({ browser }) => {
    const { request } = await seedRequest();
    const admin = await openAs(browser, ['REQUESTS_READ']);

    try {
      await admin.gotoAdmin(`/requests/${request.id}`);
      await expectOpen(admin.page, new RegExp(`/requests/${request.id}$`));
      await expect(admin.page.getByTestId('request-status')).toBeVisible();

      // Offers, reports, the contact-sharing audit and the customer's review
      // each belong to another permission: none is rendered.
      await expect(admin.page.getByTestId('request-offers-panel')).toHaveCount(0);
      await expect(admin.page.locator('#bildirimler')).toHaveCount(0);
      await expect(admin.page.getByTestId('contact-reveal-audit')).toHaveCount(0);
      await expect(admin.page.getByTestId('request-review')).toHaveCount(0);
      await expect(admin.page.getByTestId('request-review-none')).toHaveCount(0);

      // And no write control: status, quality, lifecycle.
      for (const name of [
        'Onayla',
        'İncelemeye al',
        'Talebi reddet',
        'Kaliteyi yeniden hesapla',
        'Hizmeti tamamlandı işaretle',
        'İptal et',
      ]) {
        // includeHidden: the reject button lives in a closed <details>, and a
        // control that is merely folded away still counts as offered.
        await expect(
          admin.page.getByRole('button', { name, includeHidden: true }),
          name,
        ).toHaveCount(0);
      }
      await expect(admin.page.getByRole('link', { name: 'Teklifleri görüntüle' })).toHaveCount(0);
    } finally {
      await admin.close();
    }
  });

  test('REQUESTS_STATUS opens the moderation controls, but never the customer-only lifecycle', async ({
    browser,
  }) => {
    const { request } = await seedRequest();
    const admin = await openAs(browser, ['REQUESTS_READ', 'REQUESTS_STATUS', 'OFFERS_READ']);

    try {
      await admin.gotoAdmin(`/requests/${request.id}`);
      await expectOpen(admin.page, new RegExp(`/requests/${request.id}$`));
      await expect(admin.page.getByRole('button', { name: 'İncelemeye al' })).toBeVisible();
      await expect(admin.page.getByTestId('request-offers-panel')).toBeVisible();
      // Completing and cancelling are CUSTOMER / SUPER_ADMIN routes; no role
      // holds them, so no role is offered them.
      await expect(admin.page.getByRole('button', { name: 'İptal et' })).toHaveCount(0);
      await expect(admin.page.getByRole('button', { name: 'Hizmeti tamamlandı işaretle' })).toHaveCount(0);
      await expect(admin.page.getByRole('button', { name: 'Kaliteyi yeniden hesapla' })).toHaveCount(0);
    } finally {
      await admin.close();
    }
  });

  test('a ledger reader sees a provider’s credits and no write control', async ({ browser }) => {
    const category = await createCategory(3);
    const provider = await createProvider({
      categoryId: category.id,
      location: uniqueLocation(),
      credits: 40,
    });
    const admin = await openAs(browser, ['FINANCE_LEDGER_READ']);

    try {
      await admin.gotoAdmin(`/providers/${provider.id}/credits`);
      await expectOpen(admin.page, new RegExp(`/providers/${provider.id}/credits$`));
      await expect(admin.page.getByText(provider.businessName).first()).toBeVisible();
      await expect(admin.page.getByRole('heading', { name: 'İşlem geçmişi' })).toBeVisible();

      await expect(admin.page.getByRole('heading', { name: 'Manuel kredi işlemi' })).toHaveCount(0);
      await expect(admin.page.getByRole('button', { name: 'Kredi ekle' })).toHaveCount(0);
      await expect(admin.page.getByRole('button', { name: 'Kredi düş' })).toHaveCount(0);
      // Periods carry payment references: PACKAGE_PURCHASES_READ, not held.
      await expect(admin.page.getByRole('heading', { name: 'Dönemsel paketler' })).toHaveCount(0);
      // The provider page is PROVIDERS_READ_DETAIL, not held: no link to it.
      await expect(admin.page.getByRole('link', { name: 'Hizmet veren detayı' })).toHaveCount(0);

      // The manual-operations list is the same ledger, so the same permission
      // opens its sidebar row and the page (F2).
      const sidebar = admin.page.locator('#admin-sidebar');
      await expect(sidebar.getByRole('link', { name: 'Manuel İşlemler' })).toBeVisible();
      await admin.gotoAdmin('/finance/manual-adjustments');
      await expectOpen(admin.page, /\/finance\/manual-adjustments$/);
    } finally {
      await admin.close();
    }
  });

  test('CREDITS_GRANT offers adding and CREDITS_DEDUCT offers deducting, never the other', async ({
    browser,
  }) => {
    const category = await createCategory(3);
    const provider = await createProvider({
      categoryId: category.id,
      location: uniqueLocation(),
      credits: 10,
    });
    const granter = await openAs(browser, ['FINANCE_LEDGER_READ', 'CREDITS_GRANT']);
    const deducter = await openAs(browser, ['FINANCE_LEDGER_READ', 'CREDITS_DEDUCT']);

    try {
      await granter.gotoAdmin(`/providers/${provider.id}/credits`);
      await expectOpen(granter.page, new RegExp(`/providers/${provider.id}/credits$`));
      const grantForm = granter.page.locator('form.credit-operation-form');
      await expect(grantForm.getByRole('button', { name: 'Kredi ekle' })).toBeVisible();
      await expect(grantForm.getByRole('tab')).toHaveCount(0);
      await expect(granter.page.getByRole('button', { name: 'Kredi düş' })).toHaveCount(0);

      await deducter.gotoAdmin(`/providers/${provider.id}/credits`);
      await expectOpen(deducter.page, new RegExp(`/providers/${provider.id}/credits$`));
      const deductForm = deducter.page.locator('form.credit-operation-form');
      await expect(deductForm.getByRole('button', { name: 'Kredi düş' })).toBeVisible();
      await expect(deductForm.getByRole('tab')).toHaveCount(0);
      await expect(deducter.page.getByRole('button', { name: 'Kredi ekle' })).toHaveCount(0);
    } finally {
      await granter.close();
      await deducter.close();
    }
  });

  test('FINANCE_READ alone no longer shows a manual-operations row it cannot open', async ({ browser }) => {
    const admin = await openAs(browser, ['FINANCE_READ']);

    try {
      await admin.gotoAdmin('/finance');
      await expectOpen(admin.page, /\/finance$/);
      const sidebar = admin.page.locator('#admin-sidebar');
      await expect(sidebar.getByRole('link', { name: 'Manuel İşlemler' })).toHaveCount(0);
      await admin.gotoAdmin('/finance/manual-adjustments');
      await expect(admin.page).toHaveURL(/\/yetkisiz$/);
    } finally {
      await admin.close();
    }
  });

  test('root screens are a super admin’s alone', async ({ browser }) => {
    const staff = await openAs(browser, ['ADMIN_USERS_READ']);

    try {
      await staff.gotoAdmin('/users');
      await expectOpen(staff.page, /\/users$/);
      await expect(staff.page.getByRole('link', { name: 'Yeni Admin Kullanıcısı' })).toHaveCount(0);

      for (const path of ['/users/new', '/roles']) {
        await staff.gotoAdmin(path);
        await expect(staff.page, path).toHaveURL(/\/yetkisiz$/);
      }
    } finally {
      await staff.close();
    }
  });

  test('a super admin keeps every screen and control', async ({ browser }) => {
    const { request } = await seedRequest();
    const category = await createCategory(3);
    const provider = await createProvider({
      categoryId: category.id,
      location: uniqueLocation(),
      credits: 5,
    });
    const admin = await openAs(browser, 'super');

    try {
      await admin.gotoAdmin(`/requests/${request.id}`);
      await expectOpen(admin.page, new RegExp(`/requests/${request.id}$`));
      await expect(admin.page.getByTestId('request-offers-panel')).toBeVisible();
      await expect(admin.page.locator('#bildirimler')).toBeVisible();
      await expect(admin.page.getByRole('button', { name: 'İptal et' })).toBeVisible();
      await expect(admin.page.getByRole('button', { name: 'Kaliteyi yeniden hesapla' })).toBeVisible();

      await admin.gotoAdmin(`/providers/${provider.id}/credits`);
      await expectOpen(admin.page, new RegExp(`/providers/${provider.id}/credits$`));
      await expect(admin.page.getByRole('tab', { name: 'Kredi ekle' })).toBeVisible();
      await expect(admin.page.getByRole('tab', { name: 'Kredi düş' })).toBeVisible();
      await expect(admin.page.getByRole('heading', { name: 'Dönemsel paketler' })).toBeVisible();

      for (const path of ['/users/new', '/roles', '/finance/manual-adjustments']) {
        await admin.gotoAdmin(path);
        await expectOpen(admin.page, new RegExp(`${path}$`));
      }
      await expect(admin.page.locator('#admin-sidebar').getByRole('link', { name: 'Roller ve İzinler' })).toBeVisible();
    } finally {
      await admin.close();
    }
  });

  test('an unknown record is a 404, not the error screen', async ({ browser }) => {
    const admin = await openAs(browser, 'super');

    try {
      for (const path of ['/offers/does-not-exist', '/package-purchases/does-not-exist']) {
        await admin.gotoAdmin(path);
        await expect(admin.page.getByRole('heading', { name: 'Kayıt bulunamadı' }), path).toBeVisible();
      }
    } finally {
      await admin.close();
    }
  });
});
