import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCategory, prisma, requestFormValues, uniqueLocation } from '../src/fixtures';
import { waitForLatestActivationUrl } from '../src/outbox';
import { createRequest } from '../src/journeys';
import { primaryRuntime } from '../src/runtime';

/**
 * The password-set screen's criteria, and what they are not.
 *
 * They are a live reading of the server's policy — at least eight characters,
 * and the two boxes agreeing — shown so a customer is not left guessing why a
 * submit was refused. They are not the validation: the last case turns off the
 * browser's own constraint checking and posts a short password anyway, which is
 * what a tampered client would do, and the account is still left without one.
 */
test.describe('password criteria', () => {
  test('criteria tick as the password is typed, and the server still refuses a short one', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(2);
    const values = requestFormValues(location, 'E2E Misafir');

    const guest = await Actor.open(browser, 'guest', primaryRuntime);

    try {
      // A guest request creates a password-less account and mails the link that
      // leads to the screen under test.
      await createRequest(guest, category, values);
      const activationUrl = await waitForLatestActivationUrl(values.customerEmail);

      await guest.page.goto(activationUrl, { waitUntil: 'domcontentloaded' });
      await expect(guest.page.getByRole('heading', { name: 'Şifre belirleyin' })).toBeVisible();

      const password = guest.page.locator('input[name="password"]');
      const confirm = guest.page.locator('input[name="passwordConfirm"]');
      const lengthCriterion = guest.page.getByTestId('password-criterion-length');
      const matchCriterion = guest.page.getByTestId('password-criterion-match');

      // Only the rules the API actually enforces are listed.
      await expect(guest.page.getByTestId('password-criteria').locator('li')).toHaveCount(2);
      await expect(lengthCriterion).toHaveAttribute('data-met', 'false');
      await expect(matchCriterion).toHaveAttribute('data-met', 'false');

      await password.fill('kisa12');
      await expect(lengthCriterion).toHaveAttribute('data-met', 'false');

      await password.fill('YeterinceUzun1');
      await expect(lengthCriterion).toHaveAttribute('data-met', 'true');
      // Still nothing typed in the second box, so the two do not agree yet.
      await expect(matchCriterion).toHaveAttribute('data-met', 'false');

      await confirm.fill('YeterinceUzun');
      await expect(matchCriterion).toHaveAttribute('data-met', 'false');

      await confirm.fill('YeterinceUzun1');
      await expect(matchCriterion).toHaveAttribute('data-met', 'true');

      // Deleting a character takes the tick away again: the state is read from
      // what is in the box, not remembered from when it was first met.
      await password.fill('YeterinceUzun');
      await expect(matchCriterion).toHaveAttribute('data-met', 'false');
      await expect(lengthCriterion).toHaveAttribute('data-met', 'true');

      // ---- the criteria are not the validation --------------------------
      const form = guest.page.locator('form');
      await form.evaluate((element: HTMLFormElement) => {
        element.noValidate = true;
      });
      await password.fill('kisa12');
      await confirm.fill('kisa12');
      await guest.page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();

      // Scoped to the form's own error: Next renders a route announcer that
      // also carries role="alert".
      await expect(guest.page.locator('.auth-screen-error')).toContainText(
        'Şifre en az 8 karakter olmalıdır.',
      );
      await assertNoErrorScreen(guest.page);

      const customer = await prisma().user.findFirstOrThrow({
        where: { email: values.customerEmail },
        select: { passwordHash: true },
      });
      expect(customer.passwordHash).toBeNull();
    } finally {
      await guest.close();
    }
  });
});
