import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  storedPhone,
  uniqueLocation,
  uniquePhone,
} from '../src/fixtures';
import { seedCustomerRequest } from '../src/request-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * ADMIN-SEARCH-NORMALIZATION-001: the operator's search box on the providers
 * and requests lists finds a phone number in a different spelling from the one
 * stored.
 *
 * The provider's profile number is stored in E.164 and searched with the
 * grouped national spelling people copy from a card; the request's number is
 * an older digits-only snapshot (`0555…`) and searched with the E.164 form.
 * Neither is a substring of the other, so both missed before the search moved
 * to the API's phone canonicaliser. The API spec proves every endpoint and
 * spelling; this proves the two screens send the box there.
 */

/** `05551234567` → `0555 123 45 67`, as written on a business card. */
function grouped(national: string): string {
  return `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7, 9)} ${national.slice(9)}`;
}

test.describe('admin search: phone spellings', () => {
  test('providers and requests lists find a number typed in another spelling', async ({ browser }) => {
    const category = await createCategory(3);
    const provider = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 0 });
    const customer = await createCustomer('E2E Arama Müşteri');
    const historicalPhone = uniquePhone();
    const seeded = await seedCustomerRequest({
      customerId: customer.id,
      categoryId: category.id,
      location: uniqueLocation(),
      customerPhone: historicalPhone,
      content: 'empty',
    });

    const account = await createAdmin();
    const admin = await Actor.open(browser, 'staff', primaryRuntime);
    const page = admin.page;

    try {
      await admin.loginToAdmin(account.email, account.password);

      await admin.gotoAdmin('/providers');
      await page.locator('#provider-search').fill(grouped(provider.phone));
      await page.getByRole('button', { name: 'Filtrele' }).click();
      await expect(page).toHaveURL(/q=/);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('provider-row')).toHaveCount(1);
      await expect(page.getByTestId('provider-row')).toContainText(provider.businessName);

      await admin.gotoAdmin('/requests');
      await page.locator('#request-search').fill(storedPhone(historicalPhone));
      await page.getByRole('button', { name: 'Filtrele' }).click();
      await expect(page).toHaveURL(/q=/);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('request-row')).toHaveCount(1);
      await expect(page.getByTestId('request-row')).toHaveAttribute('data-request-id', seeded.id);
    } finally {
      await admin.close();
    }
  });
});
