import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createCategory,
  createCustomer,
  prisma,
  requestFormValues,
  uniqueLocation,
} from '../src/fixtures';
import {
  expectReviewPendingSuccess,
  fillRequestForm,
  openRequestFormContactStep,
  submitRequestForm,
} from '../src/journeys';
import { primaryRuntime } from '../src/runtime';

/**
 * The contact-details filter on the request form.
 *
 * A description carrying a phone number is refused by the API, and the form
 * shows the refusal under the field it is about — back on the step that holds
 * it — instead of a success page. Corrected in place, the same form goes
 * through. The detector itself is covered on the API side; what a browser
 * proves is that the refusal is legible, lands on the right step, and that
 * nothing was created behind it.
 */

const CATEGORY_COST = 2;
const PHONE_IN_TEXT = '0532 123 45 67';
const CLEAN_DESCRIPTION = 'Salon klimasının montajı ve ilk bakımı gerekiyor.';

test.describe('request contact-details filter', () => {
  test('a phone number in the description is refused, the corrected form is sent', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();

    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const values = requestFormValues(location, customerAccount.name, {
        description: `Klima montajı için beni arayın: ${PHONE_IN_TEXT}. Salon klimasıdır.`,
      });

      // ---- the refusal, on the description's own step ------------------
      await openRequestFormContactStep(customer, category);
      await fillRequestForm(customer, values);
      await customer.page.getByRole('button', { name: 'Talebi Gönder' }).click();

      const error = customer.page.getByTestId('contact-details-error');
      await expect(error).toBeVisible();
      await expect(customer.page).not.toHaveURL(/\/requests\/success/);
      await expect(customer.page.locator('#request-step-detail')).toBeVisible();
      await expect(customer.page.locator('textarea[name="description"]')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      await assertNoErrorScreen(customer.page);

      // Nothing was created behind the refusal.
      expect(
        await prisma().serviceRequest.count({
          where: { customerEmail: values.customerEmail },
        }),
      ).toBe(0);

      // ---- corrected in place, the form goes through -------------------
      await customer.page.locator('textarea[name="description"]').fill(CLEAN_DESCRIPTION);
      await customer.page.getByRole('button', { name: 'Devam et' }).click();
      await expect(customer.page.locator('#request-step-place')).toBeVisible();
      // The place step kept what was typed before the refusal.
      await expect(customer.page.locator('select[name="district"]')).toHaveValue(values.district);

      await submitRequestForm(customer);
      await expectReviewPendingSuccess(customer);

      const requestId = new URL(customer.page.url()).searchParams.get('id');
      expect(requestId).toBeTruthy();
      const stored = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId as string },
        select: { description: true, status: true, customerEmail: true },
      });
      expect(stored.description).toBe(CLEAN_DESCRIPTION);
      expect(stored.description).not.toContain(PHONE_IN_TEXT);
      expect(stored.customerEmail).toBe(values.customerEmail);
      expect(stored.status).toBe('SUBMITTED');
    } finally {
      await customer.close();
    }
  });
});
