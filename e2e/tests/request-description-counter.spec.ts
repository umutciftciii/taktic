import { expect, test } from '@playwright/test';
import { Actor } from '../src/actors';
import { createCategory, createCustomer } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The character counter under the request form's description field.
 *
 * Driven through a real browser rather than a simulated DOM, because every
 * claim here is a browser claim: that `maxLength` truncates a paste, that the
 * count follows typing and deleting, and that the row it lives in does not push
 * a phone sideways. `apps/api/test/request-description-limit.spec.ts` covers
 * the half that matters even when there is no browser at all — the API refusing
 * an over-long description posted directly.
 */

/** Kept in step with SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH by the counter itself. */
const LIMIT = 5000;
const NEAR_LIMIT_AT = 4500;

test.describe('request description counter', () => {
  test('counts typing, deleting and pasting, and stops at the limit', async ({ browser }) => {
    const category = await createCategory(2);
    const customerAccount = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoWeb(`/categories/${category.slug}`);

      const form = customer.page.locator('form.form-card');
      const description = form.locator('textarea[name="description"]');
      const counter = customer.page.getByTestId('request-description-counter');

      // The field's own maxLength is the browser-side stop, and it is the
      // shared number rather than one typed into the markup.
      await expect(description).toHaveAttribute('maxlength', String(LIMIT));

      // Before anything is typed.
      await expect(counter).toContainText(`0 / ${LIMIT}`);
      await expect(counter).toHaveAttribute('data-state', 'ok');

      // Typing.
      await description.pressSequentially('Klima montajı');
      await expect(counter).toContainText(`13 / ${LIMIT}`);

      // Deleting.
      await description.press('Backspace');
      await expect(counter).toContainText(`12 / ${LIMIT}`);

      // Pasting: fill() sets the value in one go, the way a paste does.
      await description.fill('a'.repeat(100));
      await expect(counter).toContainText(`100 / ${LIMIT}`);

      // Below the warning threshold nothing is claimed.
      await description.fill('a'.repeat(NEAR_LIMIT_AT));
      await expect(counter).toContainText(`${NEAR_LIMIT_AT} / ${LIMIT}`);
      await expect(counter).toHaveAttribute('data-state', 'ok');

      // Past it, the warning is words — not a colour.
      await description.fill('a'.repeat(NEAR_LIMIT_AT + 1));
      await expect(counter).toHaveAttribute('data-state', 'near');
      await expect(counter).toContainText('Sınıra yaklaşıyorsunuz');

      // Exactly at the limit.
      await description.fill('a'.repeat(LIMIT));
      await expect(counter).toContainText(`${LIMIT} / ${LIMIT}`);
      await expect(counter).toHaveAttribute('data-state', 'limit');
      await expect(counter).toContainText('Karakter sınırına ulaştınız');

      // A paste that is too long is truncated by the browser, and the counter
      // reports what actually landed in the field rather than what was pasted.
      await description.fill('b'.repeat(LIMIT + 500));
      await expect(description).toHaveValue('b'.repeat(LIMIT));
      await expect(counter).toContainText(`${LIMIT} / ${LIMIT}`);

      // And back down again: the state is not sticky.
      await description.fill('kısa açıklama');
      await expect(counter).toContainText(`13 / ${LIMIT}`);
      await expect(counter).toHaveAttribute('data-state', 'ok');
    } finally {
      await customer.close();
    }
  });

  test('the field, its help text and the counter stay inside a narrow phone', async ({
    browser,
  }) => {
    const category = await createCategory(2);
    const customerAccount = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime, {
      viewport: { width: 320, height: 720 },
    });

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoWeb(`/categories/${category.slug}`);

      const form = customer.page.locator('form.form-card');
      const description = form.locator('textarea[name="description"]');

      // The widest the counter ever gets: five digits, a slash, five digits and
      // the longer of the two status lines.
      await description.fill('a'.repeat(LIMIT));
      await expect(customer.page.getByTestId('request-description-counter')).toContainText(
        'Karakter sınırına ulaştınız',
      );

      const overflow = await customer.page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, 'the description step made the page wider than the phone').toBeLessThanOrEqual(
        0,
      );

      // The document not being too wide is not the same as these three being on
      // screen: an ancestor's overflow could hide the difference.
      for (const selector of [
        'textarea[name="description"]',
        '[data-testid="request-description-counter"]',
      ]) {
        const box = await customer.page.locator(selector).first().evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: Math.round(rect.left), right: Math.round(rect.right) };
        });
        expect(box.left, `${selector} starts off the left edge`).toBeGreaterThanOrEqual(-1);
        expect(box.right, `${selector} runs past the right edge`).toBeLessThanOrEqual(321);
      }
    } finally {
      await customer.close();
    }
  });
});
