import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createCategory,
  createCustomer,
  prisma,
  requestFormValues,
  uniqueLocation,
} from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The request form's location step, driven the way a customer drives it.
 *
 * These three fields used to be free text, and a typo there is not cosmetic:
 * provider discovery matches a request's city and district against a provider's
 * service areas as text, so "Kadikoy" produced a request no provider in Kadıköy
 * could ever be shown. The selects make that unreachable from the form; the API
 * refuses the same pair on its own, which `apps/api/test/request-location.spec.ts`
 * covers against a tampered payload.
 */
test.describe('request form location', () => {
  test('province, district and neighbourhood cascade and clear in one direction', async ({
    browser,
  }) => {
    const category = await createCategory(2);
    const customerAccount = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoWeb(`/categories/${category.slug}`);

      const form = customer.page.locator('form.form-card');
      await form.locator('textarea[name="description"]').fill('Klima montajı gerekiyor.');
      await customer.page.getByRole('button', { name: 'Devam et' }).click();

      const city = form.getByTestId('request-city');
      const district = form.getByTestId('request-district');
      const neighborhood = form.getByTestId('request-neighborhood');

      // Nothing below the province can be chosen before the province is.
      await expect(district).toBeDisabled();
      await expect(neighborhood).toBeDisabled();

      await city.selectOption('İstanbul');
      await expect(district).toBeEnabled();

      // The district list is this province's districts, and only those.
      const istanbulDistricts = await district.locator('option').allTextContents();
      expect(istanbulDistricts).toContain('Kadıköy');
      expect(istanbulDistricts).not.toContain('Çankaya');

      await district.selectOption('Kadıköy');

      // The neighbourhood list arrives for the chosen district.
      await expect(neighborhood).toBeEnabled();
      const kadikoyNeighborhoods = await neighborhood.locator('option').allTextContents();
      expect(kadikoyNeighborhoods.length).toBeGreaterThan(1);

      // Changing the province empties what hung off it rather than leaving an
      // İstanbul district under Ankara.
      await city.selectOption('Ankara');
      await expect(district).toHaveValue('');
      await expect(neighborhood).toBeDisabled();

      const ankaraDistricts = await district.locator('option').allTextContents();
      expect(ankaraDistricts).toContain('Çankaya');
      expect(ankaraDistricts).not.toContain('Kadıköy');
    } finally {
      await customer.close();
    }
  });

  test('the request is stored with the canonical names that were chosen', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(2);
    const customerAccount = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);

      const values = requestFormValues(location, customerAccount.name);
      await customer.gotoWeb(`/categories/${category.slug}`);

      const form = customer.page.locator('form.form-card');
      await form.locator('textarea[name="description"]').fill(values.description);
      await customer.page.getByRole('button', { name: 'Devam et' }).click();

      await form.getByTestId('request-city').selectOption(values.city);
      await form.getByTestId('request-district').selectOption(values.district);

      // The optional third field, picked from the list the district produced.
      const neighborhood = form.getByTestId('request-neighborhood');
      await expect(neighborhood).toBeEnabled();
      const chosenNeighborhood = (await neighborhood.locator('option').nth(1).getAttribute('value'))!;
      await neighborhood.selectOption(chosenNeighborhood);

      await customer.page.getByRole('button', { name: 'Devam et' }).click();
      await form.locator('input[name="customerName"]').fill(values.customerName);
      await form.locator('input[name="customerPhone"]').fill(values.customerPhone);
      await form.locator('input[name="customerEmail"]').fill(values.customerEmail);

      await customer.page.getByRole('button', { name: 'Talebi Gönder' }).click();
      await expect(customer.page).toHaveURL(/\/requests\/success\?id=/);
      await assertNoErrorScreen(customer.page);

      const requestId = new URL(customer.page.url()).searchParams.get('id')!;
      const stored = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { city: true, district: true, neighborhood: true },
      });

      expect(stored.city).toBe(values.city);
      expect(stored.district).toBe(values.district);
      expect(stored.neighborhood).toBe(chosenNeighborhood);
    } finally {
      await customer.close();
    }
  });
});
