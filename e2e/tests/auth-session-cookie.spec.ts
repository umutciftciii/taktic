import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createCategory,
  createCustomer,
  requestFormValues,
  uniquePhone,
  uniqueSuffix,
  uniqueLocation,
} from '../src/fixtures';
import { createRequest } from '../src/journeys';
import { waitForLatestActivationUrl } from '../src/outbox';
import { primaryRuntime, type Runtime } from '../src/runtime';

/**
 * Every way this product signs somebody in, and the one thing they must agree
 * on: the cookie the browser is left holding is the cookie the API issued.
 *
 * There are five such flows — signing in, registering as a customer,
 * registering as a hizmet veren, activating a guest account and claiming a
 * guest application — and each used to re-issue the API's cookie with its own
 * private parser and its own answer for `Secure`. That answer came from the
 * build-time `NODE_ENV` constant, which Next folds away when it compiles, so a
 * compiled server always claimed `Secure` however it was later started. Over
 * plain HTTP that is a cookie no browser may keep: Chromium hid it by treating
 * loopback as a secure context, WebKit did not, and on Safari every one of
 * these flows appeared to succeed and left the person signed out.
 *
 * So the assertion is not "the cookie is not Secure" — that would be pinning
 * this suite's own transport and would pass just as happily if the app went
 * back to guessing. It is "the cookie carries whatever the API said", read from
 * the API's own header in the same run. On this stack that resolves to "not
 * Secure over HTTP"; on an HTTPS deployment the same assertion reads "Secure",
 * and the direction this suite cannot serve is pinned in the web app's unit
 * tests instead (apps/web/test/session-cookie.spec.ts).
 *
 * Run under WebKit as well as Chromium, because the engine is the variable.
 */

const AUTH_COOKIE = 'taktic_session';

/** The `Secure` attribute in a raw `Set-Cookie`, as a valueless flag. */
function headerIsSecure(header: string): boolean {
  return header
    .split(';')
    .some((attribute) => attribute.trim().toLowerCase() === 'secure');
}

/**
 * What the API itself puts on the session cookie, asked directly.
 *
 * The comparison has to have an independent witness. Reading the expected
 * answer out of the application under test would make the check tautological —
 * it would agree with the app however wrong the app was — so this signs in
 * against the API over plain HTTP and reads the header the browser never sees.
 */
async function apiSessionHeader(
  runtime: Runtime,
  account: { email: string; password: string },
): Promise<string> {
  const response = await fetch(`${runtime.apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  expect(response.ok, 'the API must accept the fixture credentials').toBe(true);

  const header =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie().find((value) => value.startsWith(`${AUTH_COOKIE}=`))
      : response.headers.get('set-cookie');

  expect(header, 'the API must issue a session cookie').toBeTruthy();
  return header!;
}

/** The session cookie the browser actually kept, or undefined if it dropped it. */
async function browserSession(page: Page) {
  return (await page.context().cookies()).find((cookie) => cookie.name === AUTH_COOKIE);
}

/**
 * The check every case below ends with.
 *
 * "A cookie exists" is the half that catches Safari dropping it; "and its
 * `secure` matches the API" is the half that catches the app going back to
 * deciding for itself. Neither alone is enough: over HTTP a cookie the app
 * wrongly marked `Secure` is simply absent, and on a stack where the browser
 * happens to accept it the flag would be wrong in silence.
 */
async function expectSessionMirrorsApi(page: Page, apiHeader: string) {
  const cookie = await browserSession(page);
  expect(cookie, 'the browser must have kept the session cookie').toBeTruthy();
  expect(cookie!.secure, "the cookie's Secure must be the API's answer").toBe(
    headerIsSecure(apiHeader),
  );
  // The attributes this app restates rather than guesses, unchanged by any of
  // the above.
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe('Lax');
  expect(cookie!.path).toBe('/');
}

/** Fills and submits one of the two registration forms. */
async function registerThrough(actor: Actor, path: string) {
  const suffix = uniqueSuffix();
  const account = {
    email: `e2e-signup-${suffix}@example.test`,
    password: 'E2eSignup123!',
  };

  await actor.gotoWeb(path);
  await expect(actor.page.getByRole('heading', { name: 'Hesap oluştur' })).toBeVisible();

  await actor.page.locator('input[name="name"]').fill(`E2E Kayıt ${suffix}`);
  await actor.page.locator('input[name="email"]').fill(account.email);
  await actor.page.locator('input[name="phone"]').fill(uniquePhone());
  await actor.page.locator('input[name="password"]').fill(account.password);
  await actor.page.getByRole('button', { name: 'Hesap Oluştur' }).click();

  return account;
}

test.describe('the session cookie every auth flow issues', () => {
  test('a customer who registers is left holding the API’s cookie', async ({ browser }) => {
    const actor = await Actor.open(browser, 'new-customer', primaryRuntime);

    try {
      const account = await registerThrough(actor, '/register/customer');

      // Registering signs the new account in and drops them on their own panel.
      await expect(actor.page).toHaveURL(/\/requests\/my$/);
      await assertNoErrorScreen(actor.page);

      await expectSessionMirrorsApi(actor.page, await apiSessionHeader(primaryRuntime, account));

      // And the session is real, not merely present: the panel keeps its own
      // guard polling, and a dropped cookie shows up as a bounce to the sign-in
      // screen rather than as a missing cookie.
      await actor.gotoWeb('/requests/my');
      await expect(actor.page).toHaveURL(/\/requests\/my$/);
    } finally {
      await actor.close();
    }
  });

  test('a hizmet veren who registers is left holding the API’s cookie', async ({ browser }) => {
    const actor = await Actor.open(browser, 'new-provider', primaryRuntime);

    try {
      const account = await registerThrough(actor, '/register/provider');

      // A new hizmet veren lands on the application form, signed in.
      await expect(actor.page).toHaveURL(/\/providers\/register$/);
      await assertNoErrorScreen(actor.page);

      await expectSessionMirrorsApi(actor.page, await apiSessionHeader(primaryRuntime, account));
    } finally {
      await actor.close();
    }
  });

  test('a guest who activates their account is left holding the API’s cookie', async ({
    browser,
  }) => {
    const category = await createCategory(2);
    const values = requestFormValues(uniqueLocation(), 'E2E Misafir');
    const password = 'E2eActivate123!';

    const guest = await Actor.open(browser, 'guest', primaryRuntime);

    try {
      // A guest request creates a password-less account and mails the link.
      await createRequest(guest, category, values);
      const activationUrl = await waitForLatestActivationUrl(values.customerEmail);

      await guest.page.goto(activationUrl, { waitUntil: 'domcontentloaded' });
      await expect(guest.page.getByRole('heading', { name: 'Şifre belirleyin' })).toBeVisible();
      await guest.page.locator('input[name="password"]').fill(password);
      await guest.page.locator('input[name="passwordConfirm"]').fill(password);
      await guest.page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();

      // Activation signs them in — landing anywhere but their own panel means
      // the cookie was refused, which is exactly what Safari used to do.
      await expect(guest.page).toHaveURL(/\/requests\/my$/);
      await assertNoErrorScreen(guest.page);

      await expectSessionMirrorsApi(
        guest.page,
        await apiSessionHeader(primaryRuntime, {
          email: values.customerEmail,
          password,
        }),
      );
    } finally {
      await guest.close();
    }
  });

  test('signing in mirrors the API for an ordinary session and a remembered one', async ({
    browser,
  }) => {
    // The two shapes the API issues, checked against the same header. The
    // expiry is the attribute the mirror was already getting right; it is here
    // because reading `Secure` from the header must not have cost it.
    const plain = await createCustomer();
    const remembered = await createCustomer();

    const first = await Actor.open(browser, 'plain', primaryRuntime);
    const second = await Actor.open(browser, 'remembered', primaryRuntime);

    try {
      await first.loginToWeb(plain.email, plain.password);
      await expectSessionMirrorsApi(first.page, await apiSessionHeader(primaryRuntime, plain));
      // -1 is Playwright's reading of a session cookie: no expiry, so the
      // browser drops it on exit.
      expect((await browserSession(first.page))?.expires).toBe(-1);

      await second.gotoWeb('/login');
      await second.page.locator('input[name="email"]').fill(remembered.email);
      await second.page.locator('input[name="password"]').fill(remembered.password);
      await second.page.getByLabel('Beni hatırla', { exact: true }).check();
      await second.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(second.page).not.toHaveURL(/\/login/);

      await expectSessionMirrorsApi(
        second.page,
        await apiSessionHeader(primaryRuntime, remembered),
      );
      expect((await browserSession(second.page))?.expires ?? -1).toBeGreaterThan(0);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
