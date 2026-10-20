import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { FIXTURE_PASSWORD, generateFixturePassword, prisma, uniquePhone, uniqueSuffix } from '../src/fixtures';
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

const PASSWORD = FIXTURE_PASSWORD;
const NEW_PASSWORD = generateFixturePassword();

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

      // Opening the link only reads it (STAGING-UAT-001 B3): the address is
      // proven by the button, not by the page load.
      await customer.page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
      await expect(customer.page.getByRole('heading', { name: 'E-postanızı doğrulayın' })).toBeVisible();
      expect((await prisma().user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt).toBeNull();
      // Signed in from registration, so the sign-in / sign-up tabs are not
      // offered (STAGING-UAT-001 D0/G2).
      await expect(customer.page.getByRole('tab', { name: 'Giriş yap' })).toHaveCount(0);

      await customer.page.getByRole('button', { name: 'E-postamı doğrula' }).click();
      await expect(customer.page.getByRole('heading', { name: 'E-postanız doğrulandı' })).toBeVisible();
      await assertNoErrorScreen(customer.page);
      // The result screen carries a result word, never the link.
      expect(customer.page.url()).not.toContain('token=');

      const after = await prisma().user.findUniqueOrThrow({ where: { email } });
      expect(after.emailVerifiedAt).not.toBeNull();

      // The link is spent. Opening it again says what is true — the address is
      // verified — instead of blaming a dead link.
      await customer.page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
      await expect(customer.page.getByRole('heading', { name: 'E-postanız zaten doğrulanmış' })).toBeVisible();
      await expect(customer.page.getByRole('heading', { name: 'Bağlantı geçersiz' })).toHaveCount(0);
      await expect(customer.page.getByRole('link', { name: 'Taleplerime Git' })).toHaveAttribute('href', '/requests/my');
    } finally {
      await customer.close();
    }
  });

  test('a mail scanner opening the link first leaves it for the person (STAGING-UAT-001 B3)', async ({
    browser,
    request,
  }) => {
    const customer = await Actor.open(browser, 'scanned-customer', primaryRuntime);
    const reader = await Actor.open(browser, 'scanned-reader', primaryRuntime);

    try {
      const email = await registerCustomer(customer);
      const { id: userId } = await prisma().user.findUniqueOrThrow({ where: { email } });
      const verifyUrl = await waitForLatestEmailVerificationUrl(email);

      // What Safe Links, a link preview or a prefetcher does: fetch the page —
      // no session, no script, sometimes a HEAD first — and walk away.
      for (const method of ['head', 'get', 'get'] as const) {
        const response = await request[method](verifyUrl, { maxRedirects: 0 });
        expect(response.status(), `${method.toUpperCase()} ${new URL(verifyUrl).pathname}`).toBe(200);
      }

      expect((await prisma().user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt).toBeNull();
      const tokens = await prisma().emailVerificationToken.findMany({ where: { userId } });
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.every((token) => token.usedAt === null)).toBe(true);

      // Then the person opens it, in a browser with no session, as from an
      // inbox — the tabs are offered there — and presses the button.
      await reader.page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
      await expect(reader.page.getByRole('heading', { name: 'E-postanızı doğrulayın' })).toBeVisible();
      await expect(reader.page.getByRole('tab', { name: 'Giriş yap' })).toBeVisible();
      await reader.page.getByRole('button', { name: 'E-postamı doğrula' }).click();
      await expect(reader.page.getByRole('heading', { name: 'E-postanız doğrulandı' })).toBeVisible();
      await assertNoErrorScreen(reader.page);

      expect((await prisma().user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt).not.toBeNull();
    } finally {
      await reader.close();
      await customer.close();
    }
  });

  test('an expired link says so and points at the next step', async ({ browser }) => {
    const customer = await Actor.open(browser, 'expired-link-customer', primaryRuntime);

    try {
      const email = await registerCustomer(customer);
      const { id: userId } = await prisma().user.findUniqueOrThrow({ where: { email } });
      const verifyUrl = await waitForLatestEmailVerificationUrl(email);

      await prisma().emailVerificationToken.updateMany({
        where: { userId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await customer.page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
      await expect(customer.page.getByRole('heading', { name: 'Bağlantının süresi dolmuş' })).toBeVisible();
      await expect(customer.page.getByRole('button', { name: 'E-postamı doğrula' })).toHaveCount(0);
      await expect(customer.page.getByRole('link', { name: 'Taleplerime Git' })).toBeVisible();
      await assertNoErrorScreen(customer.page);
      expect((await prisma().user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt).toBeNull();
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
