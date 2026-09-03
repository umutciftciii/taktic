import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCustomer, uniquePhone, uniqueSuffix } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * What somebody actually sees when they try to open the second kind of account
 * under an address they already use.
 *
 * The API specs pin the refusal itself (apps/api/test/account-email-role-conflict.spec.ts);
 * this pins the half of it a person meets. The registration action turns every
 * 409 into a query-string reason, and before this rule existed there was only
 * one — `duplicate`, rendered as "Bu e-posta veya telefon zaten kayıtlı". That
 * sentence sends the visitor to the sign-in screen, where their password cannot
 * work, because the address is not on an account of this kind at all. So the
 * assertion is not merely that *an* error appears: it is that this specific
 * error appears and the duplicate wording does not.
 */

const CONFLICT_MESSAGE = 'Bu e-posta başka türde bir hesap için kullanılıyor.';
const DUPLICATE_MESSAGE = 'Bu e-posta veya telefon zaten kayıtlı.';

/** Fills the hizmet veren registration form with the address handed in. */
async function registerAsProviderWith(actor: Actor, email: string) {
  const suffix = uniqueSuffix();

  await actor.gotoWeb('/register/provider');
  await actor.page.locator('input[name="name"]').fill(`E2E Esnaf ${suffix}`);
  await actor.page.locator('input[name="email"]').fill(email);
  await actor.page.locator('input[name="phone"]').fill(uniquePhone());
  await actor.page.locator('input[name="password"]').fill('E2eConflict123!');
  await actor.page.getByRole('button', { name: 'Hesap Oluştur' }).click();
}

test.describe('a customer’s address cannot open a hizmet veren account', () => {
  test('the form says which rule was hit, not "already registered"', async ({ browser }) => {
    const customer = await createCustomer('E2E Çakışma');
    const actor = await Actor.open(browser, 'role-conflict', primaryRuntime);

    try {
      await registerAsProviderWith(actor, customer.email);

      await expect(actor.page).toHaveURL(/\/register\/provider\?error=role-conflict$/);
      await expect(actor.page.locator('.auth-screen-error')).toHaveText(CONFLICT_MESSAGE);
      await expect(actor.page.getByText(DUPLICATE_MESSAGE)).toHaveCount(0);
      await assertNoErrorScreen(actor.page);
    } finally {
      await actor.close();
    }
  });

  test('a differently-cased variant of that address is refused the same way', async ({
    browser,
  }) => {
    const customer = await createCustomer('E2E Çakışma Varyant');
    const actor = await Actor.open(browser, 'role-conflict-variant', primaryRuntime);

    try {
      // The padding is deliberate even though `input[type=email]` strips it on
      // submit: it proves the whole path tolerates what a person pastes, and
      // the casing is what the browser actually forwards.
      await registerAsProviderWith(actor, `  ${customer.email.toUpperCase()} `);

      await expect(actor.page).toHaveURL(/\/register\/provider\?error=role-conflict$/);
      await expect(actor.page.locator('.auth-screen-error')).toHaveText(CONFLICT_MESSAGE);
      await assertNoErrorScreen(actor.page);
    } finally {
      await actor.close();
    }
  });
});
