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
import { fillRequestForm, openRequestFormContactStep } from '../src/journeys';

const NEIGHBORHOODS_ROUTE = '**/api/locations/neighborhoods?**';

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
      await openRequestFormContactStep(customer, category);

      // A signed-in customer's contact step has nothing to type and no gate;
      // the location lives on the third step.
      const form = customer.page.locator('form.form-card');
      const nextStep = customer.page.getByRole('button', { name: 'Devam et' });
      await nextStep.click();
      await form.locator('textarea[name="description"]').fill('Klima montajı gerekiyor.');
      await nextStep.click();

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

      // The neighbourhood list arrives for the chosen district, and an
      // on-site request has to pick from it (SERVICE-AREA-001).
      await expect(neighborhood).toBeEnabled();
      await expect(neighborhood.locator('option').nth(1)).toBeAttached();
      const kadikoyNeighborhoods = await neighborhood.locator('option').allTextContents();
      expect(kadikoyNeighborhoods.length).toBeGreaterThan(1);
      await expect(neighborhood).toHaveAttribute('required', '');
      await expect(form.getByText('Mahalle *', { exact: true })).toBeVisible();

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
      await openRequestFormContactStep(customer, category);

      // Contact, details, then province and district from the journey; the
      // form is left on its last step with the location chosen.
      await fillRequestForm(customer, values);
      const form = customer.page.locator('form.form-card');
      await expect(form.getByTestId('request-district')).toHaveValue(values.district);

      // The journey picked the first neighbourhood the district's list offered.
      const chosenNeighborhood = await form.getByTestId('request-neighborhood').inputValue();
      expect(chosenNeighborhood).not.toBe('');

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

  test('SERVICE-AREA-001: a neighbourhood list that fails to load blocks the request until a retry loads it', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(2);
    const customerAccount = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await openRequestFormContactStep(customer, category);

      const page = customer.page;
      const form = page.locator('form.form-card');
      const nextStep = page.getByRole('button', { name: 'Devam et' });
      await nextStep.click();
      await form.locator('textarea[name="description"]').fill('Klima montajı gerekiyor.');
      await nextStep.click();
      await expect(page.locator('#request-step-place')).toBeVisible();

      // The list endpoint is down while the district is chosen.
      await page.route(NEIGHBORHOODS_ROUTE, (route) => route.fulfill({ status: 503, body: '' }));
      await form.getByTestId('request-city').selectOption(location.city);
      await form.getByTestId('request-district').selectOption(location.district);

      const neighborhood = form.getByTestId('request-neighborhood');
      const retry = form.getByTestId('request-neighborhood-retry');
      await expect(retry).toBeVisible();
      await expect(form.getByTestId('request-neighborhood-help')).toContainText(
        'Talebi göndermek için listeyi yeniden yükleyin',
      );
      // No pointing at the address note instead: the request needs the field.
      await expect(form.getByTestId('request-neighborhood-help')).not.toContainText('Adres notuna');
      // Enabled and required, so the browser's own validation holds the submit.
      await expect(neighborhood).toBeEnabled();
      await expect(neighborhood).toHaveAttribute('required', '');
      expect(await neighborhood.evaluate((select: HTMLSelectElement) => select.validationMessage)).toContain(
        'Mahalle listesi getirilemedi',
      );

      const requestsBefore = await prisma().serviceRequest.count({ where: { customerId: customerAccount.id } });
      await page.getByRole('button', { name: 'Talebi Gönder' }).click();
      await expect(page).not.toHaveURL(/\/requests\/success/);
      expect(await prisma().serviceRequest.count({ where: { customerId: customerAccount.id } })).toBe(requestsBefore);

      // The endpoint recovers; "Tekrar dene" loads the list for the same pair.
      await page.unroute(NEIGHBORHOODS_ROUTE);
      await retry.click();
      await expect(retry).toHaveCount(0);
      await expect(neighborhood.locator('option').nth(1)).toBeAttached();
      expect(await neighborhood.evaluate((select: HTMLSelectElement) => select.validationMessage)).not.toContain(
        'Mahalle listesi',
      );

      // A neighbourhood the list does not have: the customer is told not to
      // pick a nearby one, and where to go instead.
      const missing = form.getByTestId('request-neighborhood-missing');
      await missing.locator('summary').click();
      await expect(missing).toContainText('yakın bir mahalle seçmeyin');
      await expect(missing.getByRole('link', { name: 'Destek ekibimize yazın' })).toHaveAttribute(
        'href',
        '/destek/yeni',
      );

      const chosen = (await neighborhood.locator('option').nth(1).getAttribute('value'))!;
      await neighborhood.selectOption(chosen);
      await page.getByRole('button', { name: 'Talebi Gönder' }).click();
      await expect(page).toHaveURL(/\/requests\/success\?id=/);
      await assertNoErrorScreen(page);

      const requestId = new URL(page.url()).searchParams.get('id')!;
      const stored = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { neighborhood: true, deliveryMode: true },
      });
      expect(stored).toEqual({ neighborhood: chosen, deliveryMode: 'ON_SITE' });
    } finally {
      await customer.close();
    }
  });
});
