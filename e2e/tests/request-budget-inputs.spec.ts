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
 * The two budget fields on the public request form, in Turkish lira.
 *
 * Driven through a real browser because the claims are browser claims: that a
 * field rewrites itself under the customer's hands without throwing the caret
 * away, that the keypad a phone offers is the numeric one, and that the amount
 * the database ends up with is the amount that was typed — a hundred times
 * larger, in kuruş, and not a hundred times smaller.
 *
 * `apps/web/test/lira-input.spec.ts` covers the parsing and formatting on their
 * own, and `apps/api/test/request-budget-range.spec.ts` covers the rules the API
 * keeps whatever the browser did.
 */

/** Walks the form to the step the budget fields live on. */
async function openBudgetStep(customer: Actor) {
  const form = customer.page.locator('form.form-card');
  await form.locator('textarea[name="description"]').fill('Klima montajı gerekiyor.');
  await customer.page.getByRole('button', { name: 'Devam et' }).click();
  return form;
}

test.describe('request form budget fields', () => {
  test('reads what is typed as lira, and completes it when the field is left', async ({
    browser,
  }) => {
    const category = await createCategory(2);
    const customerAccount = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoWeb(`/categories/${category.slug}`);

      const form = await openBudgetStep(customer);
      const min = form.getByTestId('request-budget-min');
      const max = form.getByTestId('request-budget-max');

      // A phone has to offer a keypad that can produce a comma.
      await expect(min).toHaveAttribute('inputmode', 'decimal');
      await expect(max).toHaveAttribute('inputmode', 'decimal');

      // Grouping arrives as the digits do, keystroke by keystroke.
      await min.pressSequentially('5000');
      await expect(min).toHaveValue('5.000');

      // And the kuruş are filled in once the customer moves on — five thousand
      // lira, which is the whole point: not fifty.
      await min.blur();
      await expect(min).toHaveValue('5.000,00');

      // Kuruş the customer types are kept, and padded rather than invented.
      await max.pressSequentially('5000,5');
      await expect(max).toHaveValue('5.000,5');
      await max.blur();
      await expect(max).toHaveValue('5.000,50');

      // Deleting regroups instead of stranding a separator.
      await min.click();
      await min.press('End');
      for (let index = 0; index < 3; index += 1) {
        await min.press('Backspace');
      }
      await expect(min).toHaveValue('5.000');
      await min.press('Backspace');
      await expect(min).toHaveValue('500');

      // Typing carries on from where the caret was left, not from the end. The
      // caret is walked with arrow keys rather than Home, which does not move a
      // caret inside a field on macOS and would make this pass for the wrong
      // reason on one of the two platforms the suite runs on.
      await min.fill('');
      await min.pressSequentially('1234');
      await expect(min).toHaveValue('1.234');
      await min.press('ArrowLeft', { delay: 10 });
      await min.pressSequentially('9');
      // Inserted one place from the end — 1.2394 regrouped — not appended.
      await expect(min).toHaveValue('12.394');

      // And the caret survived the regrouping that insert caused: the next
      // digit lands beside the one just typed, not at the end of the field.
      await min.pressSequentially('8');
      await expect(min).toHaveValue('123.984');

      // A paste of a fully written price, currency sign and spaces included.
      await min.fill('₺ 1.500,00');
      await expect(min).toHaveValue('1.500,00');

      // Characters that are not part of a number never land in the field.
      await min.fill('abc');
      await expect(min).toHaveValue('');

      // An empty field stays empty: both fields are optional.
      await min.blur();
      await expect(min).toHaveValue('');

      // Leading zeros collapse to the one that means something.
      await min.fill('00');
      await expect(min).toHaveValue('0');
    } finally {
      await customer.close();
    }
  });

  test('refuses a minimum above the maximum and accepts them equal', async ({ browser }) => {
    const category = await createCategory(2);
    const customerAccount = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoWeb(`/categories/${category.slug}`);

      const form = await openBudgetStep(customer);
      const min = form.getByTestId('request-budget-min');
      const max = form.getByTestId('request-budget-max');

      await min.fill('7500');
      await max.fill('5000');
      await max.blur();
      expect(
        await max.evaluate((field: HTMLInputElement) => field.validationMessage),
      ).toContain('Maksimum bütçe');

      // Equal ends are a range, and the message goes as soon as it holds.
      await max.fill('7500');
      await max.blur();
      expect(await max.evaluate((field: HTMLInputElement) => field.validationMessage)).toBe('');

      // Under one lira is what the API refuses, so the field says so first.
      await min.fill('0');
      await min.blur();
      expect(
        await min.evaluate((field: HTMLInputElement) => field.validationMessage),
      ).toContain('En az 1,00 TL');
    } finally {
      await customer.close();
    }
  });

  test('stores the typed lira as the kuruş the API expects', async ({ browser }) => {
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
      await form.getByTestId('request-budget-min').fill('5000');
      await form.getByTestId('request-budget-max').fill('7500,5');

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
        select: { budgetMin: true, budgetMax: true },
      });

      // Five thousand lira and seven thousand five hundred lira fifty kuruş, in
      // the minor unit the column has always held.
      expect(stored.budgetMin).toBe(500000);
      expect(stored.budgetMax).toBe(750050);
    } finally {
      await customer.close();
    }
  });

  test('both fields and their help text stay inside a narrow phone', async ({ browser }) => {
    const category = await createCategory(2);
    const customerAccount = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime, {
      viewport: { width: 320, height: 720 },
    });

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoWeb(`/categories/${category.slug}`);

      const form = await openBudgetStep(customer);

      // The widest either field ever gets: twelve lira digits, grouped.
      await form.getByTestId('request-budget-min').fill('999999999999');
      await form.getByTestId('request-budget-max').fill('999999999999');
      await expect(form.getByTestId('request-budget-max')).toHaveValue('999.999.999.999');

      const overflow = await customer.page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, 'the budget step made the page wider than the phone').toBeLessThanOrEqual(0);

      for (const testId of ['request-budget-min', 'request-budget-max']) {
        const box = await form.getByTestId(testId).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: Math.round(rect.left), right: Math.round(rect.right) };
        });
        expect(box.left, `${testId} starts off the left edge`).toBeGreaterThanOrEqual(-1);
        expect(box.right, `${testId} runs past the right edge`).toBeLessThanOrEqual(321);
      }
    } finally {
      await customer.close();
    }
  });
});
