import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCustomer, generateFixturePassword, uniqueSuffix } from '../src/fixtures';
import { waitForLatestPasswordResetUrl } from '../src/outbox';
import { primaryRuntime } from '../src/runtime';

/**
 * SEC-AUTH-ABUSE-001 through both applications' real sign-in forms, against
 * the API's deterministic Turnstile verifier (the stack runs the test
 * adapter): the token is minted in the browser, carried in a hidden field to
 * the fixed route handler and on in its header; the API's persistent attempt
 * scopes lock after five wrong passwords from one address; and nothing on
 * screen differs between an account that exists and one that does not.
 *
 * Every actor here signs in from its own forwarded address (TRUST_PROXY=1 and
 * WEB_TRUST_PROXY=true on every runtime), so the locks these cases cause
 * never reach the shared 127.0.0.1 the rest of the suite signs in from.
 */

const WRONG = generateFixturePassword();
const INVALID = 'E-posta veya şifre hatalı. Lütfen tekrar deneyin.';
const ADMIN_INVALID = 'Giriş başarısız. E-posta ve şifrenizi kontrol edin.';
const LOCKED =
  'Çok fazla deneme yapıldı. Güvenliğiniz için bir süre bekleyip tekrar deneyin ya da şifrenizi sıfırlayın.';
const VERIFICATION = 'Güvenlik doğrulaması tamamlanamadı. Lütfen tekrar deneyin.';
const PAIR_LIMIT = 5;
const TEST_TOKEN = /turnstile-test:/;

let addressSeed = 0;
async function openFrom(browser: Parameters<typeof Actor.open>[0], name: string) {
  addressSeed += 1;
  const address = `10.${Math.floor(Math.random() * 200) + 20}.${addressSeed}.${Math.floor(Math.random() * 250) + 1}`;
  return Actor.open(browser, name, primaryRuntime, { extraHTTPHeaders: { 'x-forwarded-for': address } });
}

async function steerTurnstile(page: Page, outcome: 'invalid' | 'unavailable' | 'error' | null) {
  await page.evaluate((value) => {
    if (value === null) delete window.__TAKTIC_TURNSTILE_TEST__;
    else window.__TAKTIC_TURNSTILE_TEST__ = { outcome: value };
  }, outcome);
}

declare global {
  interface Window {
    __TAKTIC_TURNSTILE_TEST__?: { outcome: 'invalid' | 'unavailable' | 'error' };
  }
}

async function submitWebLogin(actor: Actor, email: string, password: string) {
  await actor.gotoWeb('/login');
  await actor.page.locator('input[name="email"]').fill(email);
  await actor.page.locator('input[name="password"]').fill(password);
  await actor.page.getByRole('button', { name: 'Giriş Yap' }).click();
  await actor.page.waitForURL(/\/login\?error=|\/requests\/my|\/providers\//);
  await assertNoErrorScreen(actor.page);
}

async function submitAdminLogin(actor: Actor, email: string, password: string) {
  await actor.gotoAdmin('/login');
  await actor.page.locator('input[name="email"]').fill(email);
  await actor.page.locator('input[name="password"]').fill(password);
  await actor.page.getByRole('button', { name: 'Giriş Yap' }).click();
  await actor.page.waitForURL((url) => url.pathname !== '/login' || url.search.includes('error='));
  await assertNoErrorScreen(actor.page);
}

async function shownError(page: Page): Promise<string> {
  return (await page.getByRole('alert').first().innerText()).trim();
}

test.describe('web sign-in', () => {
  test('a real sign-in passes the invisible check, and no token is left anywhere', async ({ browser }) => {
    const account = await createCustomer();
    const customer = await openFrom(browser, 'customer');
    try {
      await customer.loginToWeb(account.email, account.password);
      expect(customer.page.url()).not.toMatch(TEST_TOKEN);
      expect(await customer.page.content()).not.toMatch(TEST_TOKEN);
    } finally {
      await customer.close();
    }
  });

  test('five wrong passwords lock the pair, and an unknown e-mail reads exactly the same at every step', async ({
    browser,
  }) => {
    const account = await createCustomer();
    const unknown = `kimse-${uniqueSuffix()}@example.test`;
    const known = await openFrom(browser, 'known');
    const absent = await openFrom(browser, 'absent');
    try {
      for (let attempt = 0; attempt < PAIR_LIMIT; attempt += 1) {
        await submitWebLogin(known, account.email, WRONG);
        await submitWebLogin(absent, unknown, WRONG);
        expect(await shownError(known.page)).toBe(INVALID);
        expect(await shownError(absent.page)).toBe(await shownError(known.page));
        expect(new URL(known.page.url()).search).toBe(new URL(absent.page.url()).search);
      }

      // The right password is refused too while the lock holds.
      await submitWebLogin(known, account.email, account.password);
      await submitWebLogin(absent, unknown, WRONG);
      await expect(known.page).toHaveURL(/\/login\?error=locked$/);
      expect(await shownError(known.page)).toBe(LOCKED);
      expect(await shownError(absent.page)).toBe(LOCKED);
    } finally {
      await known.close();
      await absent.close();
    }
  });

  test('a person who mistypes a few times still gets in', async ({ browser }) => {
    const account = await createCustomer();
    const customer = await openFrom(browser, 'typo');
    try {
      for (let attempt = 0; attempt < PAIR_LIMIT - 1; attempt += 1) {
        await submitWebLogin(customer, account.email, WRONG);
      }
      await customer.loginToWeb(account.email, account.password);
    } finally {
      await customer.close();
    }
  });

  test('a token the API refuses and a widget that fails are told apart from a wrong password', async ({ browser }) => {
    const account = await createCustomer();
    const customer = await openFrom(browser, 'refused-token');
    try {
      await customer.gotoWeb('/login');
      await steerTurnstile(customer.page, 'invalid');
      await customer.page.locator('input[name="email"]').fill(account.email);
      await customer.page.locator('input[name="password"]').fill(account.password);
      await customer.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(customer.page).toHaveURL(/\/login\?error=verification$/);
      expect(await shownError(customer.page)).toBe(VERIFICATION);

      // The widget itself fails: nothing is posted, the form stays as it was.
      await steerTurnstile(customer.page, 'error');
      await customer.page.locator('input[name="email"]').fill(account.email);
      await customer.page.locator('input[name="password"]').fill(account.password);
      await customer.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(customer.page.getByTestId('turnstile-challenge-failed')).toHaveText(VERIFICATION);
      await expect(customer.page).toHaveURL(/\/login\?error=verification$/);

      // And with the widget working again, the same form signs in at once.
      await steerTurnstile(customer.page, null);
      await customer.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(customer.page).not.toHaveURL(/\/login/);
    } finally {
      await customer.close();
    }
  });

  test('the forgot-password form carries its own token and still says "sent" for any address', async ({ browser }) => {
    const visitor = await openFrom(browser, 'forgot');
    try {
      await visitor.gotoWeb('/sifre-unuttum');
      await visitor.page.locator('input[name="email"]').fill(`kimse-${uniqueSuffix()}@example.test`);
      await visitor.page.getByRole('button', { name: 'Sıfırlama Bağlantısı Gönder' }).click();
      await expect(visitor.page).toHaveURL(/\/sifre-unuttum\?sent=1$/);
    } finally {
      await visitor.close();
    }
  });
});

test.describe('admin sign-in — the same rules, the same check', () => {
  test('an operator signs in through the Turnstile check', async ({ browser }) => {
    const admin = await createAdmin();
    const operator = await openFrom(browser, 'operator');
    try {
      await operator.gotoAdmin('/login');
      await expect(operator.page.getByTestId('turnstile-slot')).toHaveAttribute('data-turnstile-mode', 'test');
      await operator.loginToAdmin(admin.email, admin.password);
      expect(await operator.page.content()).not.toMatch(TEST_TOKEN);
    } finally {
      await operator.close();
    }
  });

  test('a refused token is refused on the panel too', async ({ browser }) => {
    const admin = await createAdmin();
    const operator = await openFrom(browser, 'operator-refused');
    try {
      await operator.gotoAdmin('/login');
      await steerTurnstile(operator.page, 'invalid');
      await operator.page.locator('input[name="email"]').fill(admin.email);
      await operator.page.locator('input[name="password"]').fill(admin.password);
      await operator.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(operator.page).toHaveURL(/\/login\?error=verification$/);
      expect(await shownError(operator.page)).toBe(VERIFICATION);
    } finally {
      await operator.close();
    }
  });

  test('a locked operator reads the same as a stranger, and a completed reset lifts the lock', async ({ browser }) => {
    const admin = await createAdmin();
    const operator = await openFrom(browser, 'operator-locked');
    const stranger = await openFrom(browser, 'stranger');
    const unknown = `panel-kimse-${uniqueSuffix()}@example.test`;
    const newPassword = generateFixturePassword();
    try {
      for (let attempt = 0; attempt < PAIR_LIMIT; attempt += 1) {
        await submitAdminLogin(operator, admin.email, WRONG);
        await submitAdminLogin(stranger, unknown, WRONG);
        expect(await shownError(operator.page)).toBe(ADMIN_INVALID);
        expect(await shownError(stranger.page)).toBe(ADMIN_INVALID);
      }
      await submitAdminLogin(operator, admin.email, admin.password);
      await submitAdminLogin(stranger, unknown, WRONG);
      await expect(operator.page).toHaveURL(/\/login\?error=locked$/);
      expect(await shownError(operator.page)).toBe(LOCKED);
      expect(await shownError(stranger.page)).toBe(LOCKED);

      // The way out: the panel's own reset, behind its own token.
      await operator.gotoAdmin('/sifre-unuttum');
      await operator.page.locator('input[name="email"]').fill(admin.email);
      await operator.page.getByRole('button', { name: 'Sıfırlama Bağlantısı Gönder' }).click();
      await expect(operator.page.getByRole('heading', { name: 'Bağlantı gönderildi' })).toBeVisible();
      await operator.page.goto(await waitForLatestPasswordResetUrl(admin.email), { waitUntil: 'domcontentloaded' });
      await operator.page.locator('input[name="password"]').fill(newPassword);
      await operator.page.locator('input[name="passwordConfirm"]').fill(newPassword);
      await operator.page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();
      await expect(operator.page.getByRole('heading', { name: 'Şifreniz güncellendi' })).toBeVisible();

      await operator.loginToAdmin(admin.email, newPassword);
    } finally {
      await operator.close();
      await stranger.close();
    }
  });
});
