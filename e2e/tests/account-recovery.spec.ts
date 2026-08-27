import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { prisma, uniquePhone, uniqueSuffix } from '../src/fixtures';
import {
  emailCountFor,
  waitForLatestEmailVerificationUrl,
  waitForLatestPasswordResetUrl,
} from '../src/outbox';
import { primaryRuntime } from '../src/runtime';

/**
 * The two account journeys that exist only because a message carries them.
 *
 * Both are driven end to end through the browser — the real registration form,
 * the real link out of the recording transport, the real screen it lands on —
 * because the property under test is precisely that the link a recipient
 * receives works. A unit test can prove the token is single use; only this can
 * prove the URL in the mail resolves to a page that consumes it.
 */

const PASSWORD = 'E2ePassword123!';
const NEW_PASSWORD = 'E2eYeniSifre456!';

async function registerCustomer(actor: Actor) {
  const suffix = uniqueSuffix();
  const email = `kayit-${suffix}@example.test`;

  await actor.gotoWeb('/register/customer');
  await actor.page.locator('input[name="name"]').fill('E2E Yeni Müşteri');
  await actor.page.locator('input[name="email"]').fill(email);
  await actor.page.locator('input[name="phone"]').fill(uniquePhone());
  // One password field: the register endpoint asks for it once.
  await actor.page.locator('input[name="password"]').fill(PASSWORD);
  await actor.page.getByRole('button', { name: 'Hesap Oluştur' }).click();

  await expect(actor.page).not.toHaveURL(/\/register/);
  await assertNoErrorScreen(actor.page);

  return email;
}

test.describe('e-mail verification', () => {
  test('a new customer receives a link that marks their address verified', async ({ browser }) => {
    const customer = await Actor.open(browser, 'new-customer', primaryRuntime);

    try {
      const email = await registerCustomer(customer);

      const before = await prisma().user.findUniqueOrThrow({ where: { email } });
      expect(before.emailVerifiedAt).toBeNull();

      const verifyUrl = await waitForLatestEmailVerificationUrl(email);
      // The link points at this runtime's own web app, over a real absolute URL.
      expect(verifyUrl.startsWith(`${primaryRuntime.webUrl}/e-posta-dogrula?token=`)).toBe(true);

      await customer.page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
      await expect(
        customer.page.getByRole('heading', { name: 'E-postanız doğrulandı' }),
      ).toBeVisible();
      await assertNoErrorScreen(customer.page);

      const after = await prisma().user.findUniqueOrThrow({ where: { email } });
      expect(after.emailVerifiedAt).not.toBeNull();

      // The link is spent. Opening it again says so rather than silently
      // pretending to work.
      await customer.page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
      await expect(customer.page.getByRole('heading', { name: 'Bağlantı geçersiz' })).toBeVisible();
    } finally {
      await customer.close();
    }
  });
});

test.describe('password reset', () => {
  test('a forgotten password can be replaced, and the old session dies with it', async ({
    browser,
  }) => {
    const customer = await Actor.open(browser, 'forgetful-customer', primaryRuntime);

    try {
      const email = await registerCustomer(customer);

      // Signed in from registration; this is the session the reset must close.
      await customer.gotoWeb('/requests/my');
      await expect(customer.page).not.toHaveURL(/\/login/);

      await customer.gotoWeb('/sifre-unuttum');
      await customer.page.locator('input[name="email"]').fill(email);
      await customer.page.getByRole('button', { name: 'Sıfırlama Bağlantısı Gönder' }).click();
      await expect(customer.page.getByRole('heading', { name: 'Bağlantı gönderildi' })).toBeVisible();
      await assertNoErrorScreen(customer.page);

      const resetUrl = await waitForLatestPasswordResetUrl(email);
      expect(resetUrl.startsWith(`${primaryRuntime.webUrl}/sifre-sifirla?token=`)).toBe(true);

      await customer.page.goto(resetUrl, { waitUntil: 'domcontentloaded' });
      await expect(
        customer.page.getByRole('heading', { name: 'Yeni şifre belirleyin' }),
      ).toBeVisible();

      await customer.page.locator('input[name="password"]').fill(NEW_PASSWORD);
      await customer.page.locator('input[name="passwordConfirm"]').fill(NEW_PASSWORD);
      await customer.page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();

      await expect(customer.page.getByRole('heading', { name: 'Şifreniz güncellendi' })).toBeVisible();
      await assertNoErrorScreen(customer.page);

      // The session the old password opened is gone: a protected page now
      // bounces to the login screen.
      await customer.gotoWeb('/requests/my');
      await expect(customer.page).toHaveURL(/\/login/);

      // The new password works, and the old one does not.
      await customer.gotoWeb('/login');
      await customer.page.locator('input[name="email"]').fill(email);
      await customer.page.locator('input[name="password"]').fill(PASSWORD);
      await customer.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(customer.page).toHaveURL(/\/login/);

      await customer.loginToWeb(email, NEW_PASSWORD);

      // And the link cannot be replayed.
      await customer.page.goto(resetUrl, { waitUntil: 'domcontentloaded' });
      await expect(customer.page.getByRole('heading', { name: 'Bağlantı geçersiz' })).toBeVisible();
    } finally {
      await customer.close();
    }
  });

  test('the form says the same thing for an address nobody registered', async ({ browser }) => {
    const visitor = await Actor.open(browser, 'stranger', primaryRuntime);
    const unknown = `bilinmeyen-${uniqueSuffix()}@example.test`;

    try {
      await visitor.gotoWeb('/sifre-unuttum');
      await visitor.page.locator('input[name="email"]').fill(unknown);
      await visitor.page.getByRole('button', { name: 'Sıfırlama Bağlantısı Gönder' }).click();

      // The same confirmation a registered address gets: the screen is not an
      // oracle for who has an account here.
      await expect(visitor.page.getByRole('heading', { name: 'Bağlantı gönderildi' })).toBeVisible();
      await assertNoErrorScreen(visitor.page);

      // And nothing was actually sent.
      expect(emailCountFor(unknown, 'password-reset')).toBe(0);
    } finally {
      await visitor.close();
    }
  });
});
