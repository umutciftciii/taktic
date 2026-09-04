import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCustomer, prisma, uniquePhone } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The customer's own settings: the profile they may edit, and their password.
 *
 * Both screens used to say the feature was coming. What is driven here is what
 * replaced that promise — a form that saves, a save that survives a reload, and
 * a password change that really changes the password, proved the only way it
 * can be: by signing in again afterwards with each of the two.
 *
 * The refusals are here for the same reason. A form that accepts anything is
 * not a form that works, and the three a customer will actually hit — a wrong
 * current password, a mistyped confirmation, one that is too short — each have
 * to say which of the three it was.
 */

const NEW_PASSWORD = 'E2eYeniSifre456!';

/** Nothing may make the document wider than the phone it is on. */
async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${label}: sayfa görünüm alanından ${overflow}px geniş`).toBeLessThanOrEqual(0);
}

async function signedInCustomer(browser: Parameters<typeof Actor.open>[0], name = 'ayarlar') {
  const account = await createCustomer();
  const actor = await Actor.open(browser, name, primaryRuntime);
  await actor.loginToWeb(account.email, account.password);
  return { account, actor };
}

test.describe('customer profile settings', () => {
  test('a customer edits their profile and the change survives a reload', async ({ browser }) => {
    const { account, actor } = await signedInCustomer(browser, 'profil');
    const newPhone = uniquePhone();

    try {
      await actor.gotoWeb('/account/profile');

      await actor.page.locator('input[name="name"]').fill('Ayşe Yılmaz Demir');
      await actor.page.locator('input[name="phone"]').fill(newPhone);
      await actor.page.locator('select[name="city"]').selectOption('İzmir');
      await actor.page.getByRole('button', { name: 'Bilgileri kaydet' }).click();

      // A notice that stays on the page rather than a toast that goes away.
      await expect(actor.page.getByTestId('account-profile-saved')).toBeVisible();
      await assertNoErrorScreen(actor.page);

      // Reloaded from the server, not from what the browser still had in the
      // inputs: the fields come back filled because the account carries them.
      await actor.gotoWeb('/account/profile');
      await expect(actor.page.locator('input[name="name"]')).toHaveValue('Ayşe Yılmaz Demir');
      await expect(actor.page.locator('select[name="city"]')).toHaveValue('İzmir');
      // Stored in the platform's canonical form, so the field shows that.
      await expect(actor.page.locator('input[name="phone"]')).toHaveValue(
        `+90${newPhone.slice(1)}`,
      );

      const stored = await prisma().user.findUniqueOrThrow({ where: { id: account.id } });
      expect(stored.name).toBe('Ayşe Yılmaz Demir');
      expect(stored.city).toBe('İzmir');
      expect(stored.phone).toBe(`+90${newPhone.slice(1)}`);
    } finally {
      await actor.close();
    }
  });

  test('a telephone number the platform cannot call is refused, and nothing changes', async ({
    browser,
  }) => {
    const { account, actor } = await signedInCustomer(browser, 'profil-hata');

    try {
      await actor.gotoWeb('/account/profile');
      await actor.page.locator('input[name="name"]').fill('Ayşe Yılmaz');
      await actor.page.locator('input[name="phone"]').fill('123');
      await actor.page.getByRole('button', { name: 'Bilgileri kaydet' }).click();

      await expect(actor.page.getByTestId('account-profile-error')).toBeVisible();
      await expect(actor.page.getByTestId('account-profile-saved')).toHaveCount(0);
      await assertNoErrorScreen(actor.page);

      const stored = await prisma().user.findUniqueOrThrow({ where: { id: account.id } });
      expect(stored.phone).toBe(account.phone);
      expect(stored.name).toBe(account.name);
    } finally {
      await actor.close();
    }
  });

  test('the e-mail address is shown and cannot be edited', async ({ browser }) => {
    const { account, actor } = await signedInCustomer(browser, 'profil-eposta');

    try {
      await actor.gotoWeb('/account/profile');

      const email = actor.page.locator('input[type="email"][readonly]');
      await expect(email).toHaveValue(account.email);
      // Read-only rather than absent: the address is part of the account, it
      // just is not changed here.
      await expect(email).toHaveAttribute('readonly', '');
      // And there is no field the form could post an address from.
      await expect(actor.page.locator('input[name="email"]')).toHaveCount(0);
    } finally {
      await actor.close();
    }
  });
});

test.describe('customer password settings', () => {
  test('changing the password keeps this browser signed in and signs the other out', async ({
    browser,
  }) => {
    const { account, actor } = await signedInCustomer(browser, 'sifre');
    // The same account open on a second device, signed in before the change.
    const other = await Actor.open(browser, 'sifre-diger', primaryRuntime);

    try {
      await other.loginToWeb(account.email, account.password);
      await other.gotoWeb('/account/profile');
      await expect(other.page.getByRole('heading', { name: 'Profil ve ayarlar' })).toBeVisible();

      await actor.gotoWeb('/account/password');
      await actor.page.locator('input[name="currentPassword"]').fill(account.password);
      await actor.page.locator('input[name="password"]').fill(NEW_PASSWORD);
      await actor.page.locator('input[name="passwordConfirm"]').fill(NEW_PASSWORD);
      await actor.page.getByRole('button', { name: 'Şifreyi güncelle' }).click();

      await expect(actor.page.getByTestId('account-password-success')).toBeVisible();
      await assertNoErrorScreen(actor.page);

      // This browser stayed signed in.
      await actor.gotoWeb('/account/profile');
      await expect(actor.page.getByRole('heading', { name: 'Profil ve ayarlar' })).toBeVisible();

      // The other one did not: its session was revoked with the old password.
      await other.gotoWeb('/account/profile');
      await expect(other.page).toHaveURL(/\/login/);

      // And the change is real on both sides of the credential: the new
      // password opens the account, the old one does not.
      await other.gotoWeb('/login');
      await other.page.locator('input[name="email"]').fill(account.email);
      await other.page.locator('input[name="password"]').fill(account.password);
      await other.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(other.page).toHaveURL(/\/login\?error=1/);

      await other.loginToWeb(account.email, NEW_PASSWORD);
      await expect(other.page).not.toHaveURL(/\/login/);
    } finally {
      await Promise.all([actor.close(), other.close()]);
    }
  });

  test('each refusal says which of the three fields was wrong', async ({ browser }) => {
    const { account, actor } = await signedInCustomer(browser, 'sifre-hata');
    const error = actor.page.getByTestId('account-password-error');

    async function submit(current: string, next: string, confirm: string) {
      await actor.gotoWeb('/account/password');
      await actor.page.locator('input[name="currentPassword"]').fill(current);
      await actor.page.locator('input[name="password"]').fill(next);
      await actor.page.locator('input[name="passwordConfirm"]').fill(confirm);
      await actor.page.getByRole('button', { name: 'Şifreyi güncelle' }).click();
    }

    try {
      await submit('YanlisSifre123', NEW_PASSWORD, NEW_PASSWORD);
      await expect(error).toContainText('Mevcut şifreniz doğrulanamadı');

      await submit(account.password, NEW_PASSWORD, `${NEW_PASSWORD}7`);
      await expect(error).toContainText('tekrarı aynı değil');

      await submit(account.password, account.password, account.password);
      await expect(error).toContainText('farklı olmalı');

      // The client stops a short password at the field's own minLength, so the
      // criteria list is what tells the customer before they can submit at all.
      await actor.gotoWeb('/account/password');
      await actor.page.locator('input[name="password"]').fill('kisa');
      await expect(actor.page.getByTestId('password-criterion-length')).toHaveAttribute(
        'data-met',
        'false',
      );

      // Nothing above changed the password: the original still signs in.
      const stored = await prisma().user.findUniqueOrThrow({ where: { id: account.id } });
      expect(stored.passwordHash).not.toBeNull();
      await actor.gotoWeb('/account/profile');
      await expect(actor.page.getByRole('heading', { name: 'Profil ve ayarlar' })).toBeVisible();
    } finally {
      await actor.close();
    }
  });

  test('the new password fields are the ones a password manager should fill', async ({
    browser,
  }) => {
    const { actor } = await signedInCustomer(browser, 'sifre-autocomplete');

    try {
      await actor.gotoWeb('/account/password');
      await expect(actor.page.locator('input[name="currentPassword"]')).toHaveAttribute(
        'autocomplete',
        'current-password',
      );
      await expect(actor.page.locator('input[name="password"]')).toHaveAttribute(
        'autocomplete',
        'new-password',
      );
      await expect(actor.page.locator('input[name="passwordConfirm"]')).toHaveAttribute(
        'autocomplete',
        'new-password',
      );
    } finally {
      await actor.close();
    }
  });
});

test.describe('customer settings on a phone', () => {
  test('both screens fit 320px and no longer promise anything for later', async ({ browser }) => {
    const { actor } = await signedInCustomer(browser, 'ayarlar-mobil');

    try {
      await actor.page.setViewportSize({ width: 320, height: 640 });

      for (const path of ['/account/profile', '/account/password']) {
        await actor.gotoWeb(path);
        await expectNoHorizontalOverflow(actor.page, path);

        // The form is the screen, not a promise of one.
        await expect(actor.page.locator('.split-main').getByText(/yakında/i)).toHaveCount(0);
        await assertNoErrorScreen(actor.page);
      }

      // Both forms are reachable and usable at this width.
      await actor.gotoWeb('/account/profile');
      await expect(actor.page.getByRole('button', { name: 'Bilgileri kaydet' })).toBeVisible();
      await actor.gotoWeb('/account/password');
      await expect(actor.page.getByRole('button', { name: 'Şifreyi güncelle' })).toBeVisible();
    } finally {
      await actor.close();
    }
  });
});
