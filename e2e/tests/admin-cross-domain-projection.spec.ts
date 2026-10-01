import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createLemonSqueezyCreditPackage,
  createProvider,
  createStaffAdmin,
  prisma,
  uniqueLocation,
} from '../src/fixtures';
import { seedOffer } from '../src/offer-fixtures';
import { seedCustomerRequest } from '../src/request-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-001 through the real screens.
 *
 * The API now leaves another domain's block out of an admin response for a
 * session that cannot read that domain: a provider's balance, offers and
 * purchases; a customer's requests and offers; a request owner's contact on
 * an offer; the customer account behind a request. These pin that the
 * screens follow — no column, figure, tab or row for a block that was not
 * sent, no error screen where a response got smaller — and that SUPER_ADMIN
 * still sees every block.
 */

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.page.setViewportSize({ width: 1440, height: 1200 });
  await actor.loginToAdmin(account.email, account.password);
  return actor;
}

async function expectOpen(page: Page) {
  await assertNoErrorScreen(page);
  await expect(page).not.toHaveURL(/\/yetkisiz$/);
}

const header = (page: Page, name: string) => page.getByRole('columnheader', { name, exact: true });

/** One provider with a balance, an offer on one customer's request and a paid purchase. */
async function seedWorld() {
  const location = uniqueLocation();
  const category = await createCategory(3);
  const customer = await createCustomer('E2E Projeksiyon');
  const provider = await createProvider({ categoryId: category.id, location, credits: 40 });
  const request = await seedCustomerRequest({ customerId: customer.id, categoryId: category.id, location, content: 'full' });
  const offer = await seedOffer({ requestId: request.id, providerId: provider.id });
  const pkg = await createLemonSqueezyCreditPackage({ creditAmount: 10, priceAmount: 10_000 });
  await prisma().packagePurchase.create({
    data: {
      providerId: provider.id,
      packageId: pkg.id,
      status: 'PAID',
      creditAmountSnapshot: 10,
      priceAmountSnapshot: 10_000,
      packageNameSnapshot: pkg.name,
      paidAt: new Date(),
    },
  });
  const stored = await prisma().serviceRequest.findUniqueOrThrow({
    where: { id: request.id },
    select: { customerName: true, customerPhone: true, customerEmail: true },
  });
  const account = await prisma().user.findUniqueOrThrow({ where: { id: customer.id }, select: { email: true } });
  const profile = await prisma().providerProfile.findUniqueOrThrow({
    where: { id: provider.id },
    select: { contactName: true },
  });
  return { category, customer, provider, request, offer, stored, account, profile };
}

test.describe('provider screens', () => {
  test('the list and the page draw no balance, offer or purchase figure the session cannot read', async ({ browser }) => {
    const { provider } = await seedWorld();
    const reader = await openAs(browser, ['PROVIDERS_READ', 'PROVIDERS_READ_DETAIL']);
    const offers = await openAs(browser, ['PROVIDERS_READ', 'PROVIDERS_READ_DETAIL', 'OFFERS_READ']);
    const admin = await openAs(browser, 'super');

    try {
      const search = `/providers?q=${encodeURIComponent(provider.businessName)}`;

      await reader.gotoAdmin(search);
      await expectOpen(reader.page);
      await expect(reader.page.getByTestId('provider-row')).toHaveCount(1);
      for (const name of ['Kredi', 'Açık teklif', 'Paket']) await expect(header(reader.page, name)).toHaveCount(0);
      await expect(reader.page.getByTestId('provider-credit')).toHaveCount(0);

      await reader.gotoAdmin(`/providers/${provider.id}`);
      await expectOpen(reader.page);
      const readerTabs = reader.page.getByRole('navigation', { name: 'Hizmet veren sekmeleri' });
      await expect(readerTabs.getByRole('link')).toHaveText(['İşletme bilgileri']);
      for (const testId of ['provider-fact-credit', 'provider-fact-open-offers', 'provider-fact-purchases']) {
        await expect(reader.page.getByTestId(testId)).toHaveCount(0);
      }
      // A hand-written tab it has nothing for falls back to the first tab.
      await reader.gotoAdmin(`/providers/${provider.id}?tab=teklifler`);
      await expect(reader.page.getByTestId('provider-panel-teklifler')).toHaveCount(0);

      // OFFERS_READ opens the offers — and only them.
      await offers.gotoAdmin(search);
      await expect(header(offers.page, 'Açık teklif')).toBeVisible();
      await expect(header(offers.page, 'Kredi')).toHaveCount(0);
      await offers.gotoAdmin(`/providers/${provider.id}?tab=teklifler`);
      await expectOpen(offers.page);
      await expect(offers.page.getByTestId('provider-tab-teklifler')).toContainText('Teklifler');
      await expect(offers.page.getByTestId('provider-tab-teklifler')).not.toContainText('paketler');
      await expect(offers.page.getByTestId('provider-recent-offers').locator('tbody tr')).toHaveCount(1);
      await expect(offers.page.getByText('Son paket alımları')).toHaveCount(0);
      await expect(offers.page.getByTestId('provider-fact-credit')).toHaveCount(0);
      await expect(offers.page.getByTestId('provider-fact-open-offers')).toContainText('1');

      // SUPER_ADMIN: every column, figure and card.
      await admin.gotoAdmin(search);
      for (const name of ['Kredi', 'Açık teklif', 'Paket']) await expect(header(admin.page, name)).toBeVisible();
      await expect(admin.page.getByTestId('provider-credit')).toContainText('37');
      await admin.gotoAdmin(`/providers/${provider.id}?tab=teklifler`);
      await expect(admin.page.getByTestId('provider-tab-teklifler')).toContainText('Teklifler ve paketler');
      await expect(admin.page.getByTestId('provider-fact-credit')).toContainText('37');
      await expect(admin.page.getByTestId('provider-fact-purchases')).toContainText('1');
      await expect(admin.page.getByTestId('provider-recent-purchases').locator('tbody tr')).toHaveCount(1);
    } finally {
      await reader.close();
      await offers.close();
      await admin.close();
    }
  });
});

test.describe('customer screens', () => {
  test('the account alone: no request or offer column, sort, filter, figure or tab', async ({ browser }) => {
    const { customer, account } = await seedWorld();
    const reader = await openAs(browser, ['CUSTOMERS_READ']);
    const requests = await openAs(browser, ['CUSTOMERS_READ', 'REQUESTS_READ']);
    const admin = await openAs(browser, 'super');

    try {
      const search = `/customers?q=${encodeURIComponent(account.email!)}`;

      await reader.gotoAdmin(search);
      await expectOpen(reader.page);
      await expect(reader.page.getByTestId('customer-row')).toHaveCount(1);
      for (const name of ['Şehir', 'Talep', 'Teklif', 'Kabul', 'Son talep']) {
        await expect(header(reader.page, name)).toHaveCount(0);
      }
      await expect(reader.page.locator('#customer-city')).toHaveCount(0);
      await expect(reader.page.locator('#customer-sort option')).toHaveText(['İsim', 'Kayıt tarihi']);
      // A bookmarked sort it may not use falls back instead of failing.
      await reader.gotoAdmin('/customers?sortBy=requestCount&city=%C4%B0stanbul');
      await expectOpen(reader.page);

      await reader.gotoAdmin(`/customers/${customer.id}`);
      await expectOpen(reader.page);
      const tabs = reader.page.getByRole('navigation', { name: 'Müşteri sekmeleri' });
      await expect(tabs.getByRole('link')).toHaveText(['Profil ve iletişim']);
      await expect(reader.page.getByTestId('customer-fact-requests')).toHaveCount(0);
      await expect(reader.page.getByTestId('customer-fact-offers')).toHaveCount(0);

      // REQUESTS_READ adds the requests and nothing of the offers.
      await requests.gotoAdmin(search);
      await expect(header(requests.page, 'Talep')).toBeVisible();
      await expect(header(requests.page, 'Teklif')).toHaveCount(0);
      await expect(requests.page.getByTestId('customer-request-count')).toContainText('1');
      await requests.gotoAdmin(`/customers/${customer.id}`);
      const requestTabs = requests.page.getByRole('navigation', { name: 'Müşteri sekmeleri' });
      await expect(requestTabs.getByRole('link')).toHaveText(['Profil ve iletişim', /Talep geçmişi/]);
      await expect(requests.page.getByTestId('customer-fact-requests')).toContainText('1');

      await admin.gotoAdmin(`/customers/${customer.id}`);
      const adminTabs = admin.page.getByRole('navigation', { name: 'Müşteri sekmeleri' });
      await expect(adminTabs.getByRole('link')).toHaveText([
        'Profil ve iletişim',
        /Talep geçmişi/,
        /Aldığı teklifler/,
        /Notlar/,
      ]);
      await expect(admin.page.getByTestId('customer-fact-offers')).toContainText('1');
    } finally {
      await reader.close();
      await requests.close();
      await admin.close();
    }
  });
});

test.describe('offer and request screens', () => {
  test('an offer names its request and provider without either contact', async ({ browser }) => {
    const { offer, stored, provider, profile, request } = await seedWorld();
    const reader = await openAs(browser, ['OFFERS_READ']);
    const admin = await openAs(browser, 'super');

    try {
      await reader.gotoAdmin(`/offers?requestId=${request.id}`);
      await expectOpen(reader.page);
      await expect(reader.page.locator(`[data-testid="offer-row"][data-offer-id="${offer.id}"]`)).toHaveCount(1);
      await expect(header(reader.page, 'Müşteri')).toHaveCount(0);

      for (const tab of ['', '?tab=talep']) {
        await reader.gotoAdmin(`/offers/${offer.id}${tab}`);
        await expectOpen(reader.page);
        const body = reader.page.locator('main');
        for (const secret of [stored.customerPhone, stored.customerEmail!, stored.customerName, provider.phone, profile.contactName]) {
          await expect(body).not.toContainText(secret);
        }
      }
      await expect(reader.page.getByText(provider.businessName).first()).toBeVisible();

      await admin.gotoAdmin(`/offers/${offer.id}?tab=talep`);
      await expect(admin.page.locator('main')).toContainText(stored.customerPhone);
    } finally {
      await reader.close();
      await admin.close();
    }
  });

  test('a request reads as linked to an account the session cannot open', async ({ browser }) => {
    const { request, account } = await seedWorld();
    const reader = await openAs(browser, ['REQUESTS_READ']);
    const withCustomers = await openAs(browser, ['REQUESTS_READ', 'CUSTOMERS_READ']);

    try {
      await reader.gotoAdmin(`/requests/${request.id}`);
      await expectOpen(reader.page);
      await expect(reader.page.getByTestId('request-account-linked')).toHaveText('Müşteri hesabına bağlı');
      await expect(reader.page.locator('main')).not.toContainText(account.email!);

      await withCustomers.gotoAdmin(`/requests/${request.id}`);
      await expect(withCustomers.page.getByTestId('request-account-linked')).toHaveCount(0);
      await expect(withCustomers.page.locator('main')).toContainText(account.email!);
    } finally {
      await reader.close();
      await withCustomers.close();
    }
  });
});
