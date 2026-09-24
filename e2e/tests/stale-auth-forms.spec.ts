import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createClaimableCustomer,
  createCustomer,
  prisma,
  uniqueLocation,
  uniqueSuffix,
} from '../src/fixtures';
import {
  waitForLatestActivationUrl,
  waitForLatestClaimUrl,
  waitForLatestPasswordResetUrl,
} from '../src/outbox';
import { primaryRuntime, providerClaimRuntime, type Runtime } from '../src/runtime';

/**
 * BUG-AUTH-STALE-ACTION-001 — the sign-in, sign-up, sign-out and password
 * forms in a tab that was rendered by the previous build.
 *
 * A Server Action is addressed by an id Next derives at build time, salted with
 * that build's own encryption key. A clean build — a recreated container —
 * draws a new key, so every id changes even when the source did not (two clean
 * builds of one commit share none of their 61 ids). A tab rendered before the
 * deploy still holds the old ids; posting one gets `404
 * x-nextjs-action-not-found`, Next's client throws `UnrecognizedActionError`,
 * and the route boundary shows "Bir şeyler ters gitti" — which, on the sign-in
 * form, is a person locked out by a deploy.
 *
 * **How the old tab is made here.** Every POST a page sends with a
 * `Next-Action` header is forwarded to the real server with an id no build has
 * ever issued. The server answers exactly what it answers a tab from the
 * previous build — nothing on the client is faked, so the real
 * `UnrecognizedActionError` is thrown by Next's own code if the form still
 * depends on an action id. The same scenario was checked once against a real
 * rebuild (old tab open → server stopped → `.next` deleted → clean build →
 * restart → submit) in both engines; this spec is the repeatable half of it.
 *
 * **What each case asserts.** The form reached the code that handles it —
 * signed in, signed up, signed out, reset — or showed its own readable
 * refusal; no stale-id post was ever made; and neither the technical error, an
 * action hash, nor the generic error screen appeared, on the page or in the
 * console.
 *
 * Run under Chromium and WebKit (see playwright.config.ts).
 */

/** Shaped like a real id (a two-hex-digit prefix and a 40-hex-digit hash); issued by no build. */
const STALE_ACTION_ID = `7f${'0'.repeat(40)}`;

const NEW_PASSWORD = 'E2eYeniSifre456!';

/** What a page that broke on a stale action shows, on screen or in the console. */
const STALE_FAILURE = [
  /UnrecognizedActionError/,
  /was not found on the server/,
  /failed-to-find-server-action/,
  /Unhandled route error/,
  /Unhandled application error/,
  new RegExp(STALE_ACTION_ID),
];

type StaleTab = {
  /** POSTs this page sent carrying a Server Action id — each one answered as stale. */
  staleActionPosts: () => number;
  /** Console errors and uncaught exceptions, from the moment the tab was prepared. */
  errors: string[];
};

/**
 * Turns this page into a tab from the previous build: any Server Action id it
 * posts is replaced with one the running server has never heard of.
 */
async function prepareStaleTab(page: Page, runtime: Runtime): Promise<StaleTab> {
  const origins = new Set([new URL(runtime.webUrl).origin, new URL(runtime.adminUrl).origin]);
  let staleActionPosts = 0;
  const errors: string[] = [];

  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    errors.push(`${error.name}: ${error.message}`);
  });

  await page.route(
    (url) => origins.has(url.origin),
    async (route, request) => {
      const headers = request.headers();
      if (request.method() !== 'POST' || !headers['next-action']) {
        return route.fallback();
      }

      staleActionPosts += 1;
      return route.continue({ headers: { ...headers, 'next-action': STALE_ACTION_ID } });
    },
  );

  return { staleActionPosts: () => staleActionPosts, errors };
}

/** The old tab reached the form's own outcome: no stale id, no technical error. */
async function expectNoStaleActionFailure(page: Page, tab: StaleTab) {
  await assertNoErrorScreen(page);
  expect(tab.staleActionPosts(), 'the form must not depend on a build-bound action id').toBe(0);

  const body = await page.locator('body').innerText();
  for (const pattern of STALE_FAILURE) {
    expect(body, `the page must not show ${pattern}`).not.toMatch(pattern);
    for (const line of tab.errors) {
      expect(line, `the console must not report ${pattern}`).not.toMatch(pattern);
    }
  }
}

async function fillLogin(page: Page, email: string, password: string) {
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Giriş Yap' }).click();
}

async function sessionCookie(actor: Actor): Promise<string | undefined> {
  const cookies = await actor.context.cookies();
  return cookies.find((cookie) => cookie.name === 'taktic_session')?.value;
}

test.describe('web sign-in from a tab rendered by the previous build', () => {
  test('valid credentials sign in and land on the role’s own screen', async ({ browser }) => {
    const account = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      const tab = await prepareStaleTab(customer.page, primaryRuntime);
      await customer.gotoWeb('/login');
      await fillLogin(customer.page, account.email, account.password);

      await expect(customer.page).toHaveURL(`${primaryRuntime.webUrl}/requests/my`);
      await expectNoStaleActionFailure(customer.page, tab);
      expect(await sessionCookie(customer)).toBeTruthy();
    } finally {
      await customer.close();
    }
  });

  test('a wrong password shows the form’s own error, not a technical one', async ({ browser }) => {
    const account = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      const tab = await prepareStaleTab(customer.page, primaryRuntime);
      await customer.gotoWeb('/login');
      await fillLogin(customer.page, account.email, 'YanlisSifre999!');

      await expect(customer.page).toHaveURL(/\/login\?error=1$/);
      await expect(customer.page.locator('.auth-screen-error')).toHaveText(
        'E-posta veya şifre hatalı. Lütfen tekrar deneyin.',
      );
      await expectNoStaleActionFailure(customer.page, tab);
      expect(await sessionCookie(customer)).toBeUndefined();

      // The same tab, now corrected, still signs in.
      await fillLogin(customer.page, account.email, account.password);
      await expect(customer.page).toHaveURL(`${primaryRuntime.webUrl}/requests/my`);
      await expectNoStaleActionFailure(customer.page, tab);
    } finally {
      await customer.close();
    }
  });

  test('a safe redirectTo is followed, also after a refusal', async ({ browser }) => {
    const account = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      const tab = await prepareStaleTab(customer.page, primaryRuntime);
      await customer.gotoWeb('/login?redirectTo=%2Faccount%2Fprofile');
      await fillLogin(customer.page, account.email, 'YanlisSifre999!');
      // The refusal keeps the destination…
      await expect(customer.page).toHaveURL(/\/login\?error=1&redirectTo=%2Faccount%2Fprofile$/);

      // …and the next attempt goes there.
      await fillLogin(customer.page, account.email, account.password);
      await expect(customer.page).toHaveURL(`${primaryRuntime.webUrl}/account/profile`);
      await expectNoStaleActionFailure(customer.page, tab);
    } finally {
      await customer.close();
    }
  });

  test('an off-site redirectTo — in the address bar or in the posted field — is dropped', async ({
    browser,
  }) => {
    const account = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      const tab = await prepareStaleTab(customer.page, primaryRuntime);

      // From the address bar: the page never writes it into the form.
      await customer.gotoWeb('/login?redirectTo=%2F%2Fevil.example%2Fsteal');
      await expect(customer.page.locator('input[name="redirectTo"]')).toHaveCount(0);

      // Posted anyway, as a forged hidden field: the handler drops it too.
      await customer.page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'redirectTo';
        input.value = 'https://evil.example/steal';
        document.querySelector('form')?.appendChild(input);
      });
      await fillLogin(customer.page, account.email, account.password);

      await expect(customer.page).toHaveURL(`${primaryRuntime.webUrl}/requests/my`);
      await expectNoStaleActionFailure(customer.page, tab);
    } finally {
      await customer.close();
    }
  });

  test('the session-expired screen signs back in to where the person was', async ({ browser }) => {
    const account = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      const tab = await prepareStaleTab(customer.page, primaryRuntime);
      await customer.gotoWeb('/login?reason=session-expired&redirectTo=%2Faccount%2Fpassword');
      await expect(customer.page.getByTestId('session-expired-notice')).toBeVisible();

      await fillLogin(customer.page, account.email, account.password);
      await expect(customer.page).toHaveURL(`${primaryRuntime.webUrl}/account/password`);
      await expectNoStaleActionFailure(customer.page, tab);
    } finally {
      await customer.close();
    }
  });
});

test.describe('the fixed sign-in endpoint keeps the Server Action’s CSRF rule', () => {
  test('a post from another origin, or with no origin, is refused and signs nobody in', async ({
    playwright,
  }) => {
    const account = await createCustomer();
    const request = await playwright.request.newContext();
    const form = { email: account.email, password: account.password };

    try {
      for (const headers of [{ origin: 'https://evil.example' }, {}] as Record<string, string>[]) {
        const refused = await request.post(`${primaryRuntime.webUrl}/login/submit`, {
          form,
          headers,
          maxRedirects: 0,
        });
        expect(refused.status()).toBe(403);
        expect(refused.headers()['set-cookie'] ?? '').not.toContain('taktic_session');
      }

      // The same post from the page's own origin is what the form sends.
      const accepted = await request.post(`${primaryRuntime.webUrl}/login/submit`, {
        form,
        headers: { origin: primaryRuntime.webUrl },
        maxRedirects: 0,
      });
      expect(accepted.status()).toBe(303);
      expect(accepted.headers()['location']).toBe('/requests/my');
      expect(accepted.headers()['set-cookie']).toContain('taktic_session=');

      // Sign-out is guarded the same way: another site cannot end a session.
      const logout = await request.post(`${primaryRuntime.webUrl}/logout`, {
        form: {},
        headers: { origin: 'https://evil.example' },
        maxRedirects: 0,
      });
      expect(logout.status()).toBe(403);
    } finally {
      await request.dispose();
    }
  });
});

test.describe('web sign-up, sign-out and password forms from a stale tab', () => {
  test('customer sign-up signs the new account in', async ({ browser }) => {
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);
    const email = `e2e-stale-signup-${uniqueSuffix()}@example.test`;

    try {
      const tab = await prepareStaleTab(visitor.page, primaryRuntime);
      await visitor.gotoWeb('/register/customer');
      await visitor.page.locator('input[name="name"]').fill('E2E Eski Sekme');
      await visitor.page.locator('input[name="email"]').fill(email);
      await visitor.page.locator('input[name="password"]').fill(NEW_PASSWORD);
      await visitor.page.getByRole('button', { name: 'Hesap Oluştur' }).click();

      await expect(visitor.page).toHaveURL(`${primaryRuntime.webUrl}/requests/my`);
      await expectNoStaleActionFailure(visitor.page, tab);
      expect(await sessionCookie(visitor)).toBeTruthy();

      // Signing out from the panel, in the same old tab.
      await visitor.page.locator('.cdash-user-summary').click();
      await visitor.page.getByTestId('customer-logout').click();
      await expect(visitor.page).toHaveURL(`${primaryRuntime.webUrl}/`);
      await expectNoStaleActionFailure(visitor.page, tab);
      expect(await sessionCookie(visitor)).toBeUndefined();

      // The session is gone on the server, not just in this browser.
      await visitor.gotoWeb('/requests/my');
      await expect(visitor.page).toHaveURL(/\/login/);
    } finally {
      await visitor.close();
    }
  });

  test('a duplicate sign-up shows the form’s own refusal', async ({ browser }) => {
    const existing = await createCustomer();
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      const tab = await prepareStaleTab(visitor.page, primaryRuntime);
      await visitor.gotoWeb('/register/customer');
      await visitor.page.locator('input[name="name"]').fill('E2E Kopya');
      await visitor.page.locator('input[name="email"]').fill(existing.email);
      await visitor.page.locator('input[name="password"]').fill(NEW_PASSWORD);
      await visitor.page.getByRole('button', { name: 'Hesap Oluştur' }).click();

      await expect(visitor.page).toHaveURL(/\/register\/customer\?error=duplicate$/);
      await expect(visitor.page.locator('.auth-screen-error')).toBeVisible();
      await expectNoStaleActionFailure(visitor.page, tab);
    } finally {
      await visitor.close();
    }
  });

  test('provider sign-up signs the new account in', async ({ browser }) => {
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);
    const email = `e2e-stale-provider-${uniqueSuffix()}@example.test`;

    try {
      const tab = await prepareStaleTab(visitor.page, primaryRuntime);
      await visitor.gotoWeb('/register/provider');
      await visitor.page.locator('input[name="name"]').fill('E2E Eski Sekme Usta');
      await visitor.page.locator('input[name="email"]').fill(email);
      await visitor.page.locator('input[name="password"]').fill(NEW_PASSWORD);
      await visitor.page.getByRole('button', { name: 'Hesap Oluştur' }).click();

      await expect(visitor.page).toHaveURL(`${primaryRuntime.webUrl}/providers/register`);
      await expectNoStaleActionFailure(visitor.page, tab);
      expect(await sessionCookie(visitor)).toBeTruthy();
    } finally {
      await visitor.close();
    }
  });

  test('forgot-password and reset-password both work, and the new password signs in', async ({
    browser,
  }) => {
    const account = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      const tab = await prepareStaleTab(customer.page, primaryRuntime);
      await customer.gotoWeb('/sifre-unuttum');
      await customer.page.locator('input[name="email"]').fill(account.email);
      await customer.page.getByRole('button', { name: 'Sıfırlama Bağlantısı Gönder' }).click();
      await expect(customer.page.getByRole('heading', { name: 'Bağlantı gönderildi' })).toBeVisible();
      await expectNoStaleActionFailure(customer.page, tab);

      const resetUrl = await waitForLatestPasswordResetUrl(account.email);
      await customer.page.goto(resetUrl, { waitUntil: 'domcontentloaded' });
      await customer.page.locator('input[name="password"]').fill(NEW_PASSWORD);
      await customer.page.locator('input[name="passwordConfirm"]').fill(NEW_PASSWORD);
      await customer.page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();
      await expect(customer.page.getByRole('heading', { name: 'Şifreniz güncellendi' })).toBeVisible();
      await expectNoStaleActionFailure(customer.page, tab);

      await customer.gotoWeb('/login');
      await fillLogin(customer.page, account.email, NEW_PASSWORD);
      await expect(customer.page).toHaveURL(`${primaryRuntime.webUrl}/requests/my`);
      await expectNoStaleActionFailure(customer.page, tab);
    } finally {
      await customer.close();
    }
  });

  test('customer activation from a mailed link sets the password and signs in', async ({
    browser,
  }) => {
    const claimable = await createClaimableCustomer('E2E Eski Sekme Aktivasyon');
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      const tab = await prepareStaleTab(customer.page, primaryRuntime);

      // Signing up with the address of an auto-created account mails an
      // activation link instead — the sign-up form's own notice says so.
      await customer.gotoWeb('/register/customer');
      await customer.page.locator('input[name="name"]').fill('E2E Aktivasyon');
      await customer.page.locator('input[name="email"]').fill(claimable.email);
      await customer.page.locator('input[name="password"]').fill(NEW_PASSWORD);
      await customer.page.getByRole('button', { name: 'Hesap Oluştur' }).click();
      await expect(customer.page).toHaveURL(/\/register\/customer\?notice=activation-sent$/);
      await expectNoStaleActionFailure(customer.page, tab);

      const activationUrl = await waitForLatestActivationUrl(claimable.email);
      await customer.page.goto(activationUrl, { waitUntil: 'domcontentloaded' });
      await customer.page.locator('input[name="password"]').fill(NEW_PASSWORD);
      await customer.page.locator('input[name="passwordConfirm"]').fill(NEW_PASSWORD);
      await customer.page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();

      await expect(customer.page).toHaveURL(`${primaryRuntime.webUrl}/requests/my`);
      await expectNoStaleActionFailure(customer.page, tab);
      expect(await sessionCookie(customer)).toBeTruthy();
    } finally {
      await customer.close();
    }
  });

  test('changing the password while signed in', async ({ browser }) => {
    const account = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(account.email, account.password);
      const tab = await prepareStaleTab(customer.page, primaryRuntime);
      await customer.gotoWeb('/account/password');

      // A wrong current password is the form's own refusal…
      await customer.page.locator('input[name="currentPassword"]').fill('YanlisSifre999!');
      await customer.page.locator('input[name="password"]').fill(NEW_PASSWORD);
      await customer.page.locator('input[name="passwordConfirm"]').fill(NEW_PASSWORD);
      await customer.page.getByRole('button', { name: 'Şifreyi güncelle' }).click();
      await expect(customer.page).toHaveURL(/\/account\/password\?error=current$/);
      await expectNoStaleActionFailure(customer.page, tab);

      // …and the right one changes it.
      await customer.page.locator('input[name="currentPassword"]').fill(account.password);
      await customer.page.locator('input[name="password"]').fill(NEW_PASSWORD);
      await customer.page.locator('input[name="passwordConfirm"]').fill(NEW_PASSWORD);
      await customer.page.getByRole('button', { name: 'Şifreyi güncelle' }).click();
      await expect(customer.page.getByTestId('account-password-success')).toBeVisible();
      await expectNoStaleActionFailure(customer.page, tab);
    } finally {
      await customer.close();
    }
  });
});

test.describe('provider claim from a stale tab', () => {
  test('the claim screen creates the account and opens the panel', async ({ browser }) => {
    const category = await createCategory(3);
    const location = uniqueLocation();
    const email = `e2e-stale-claim-${uniqueSuffix()}@example.test`;
    const businessName = `E2E Eski Sekme Başvuru ${uniqueSuffix()}`;
    const applicant = await Actor.open(browser, 'applicant', providerClaimRuntime);

    try {
      // The public application is not an auth form; it is submitted normally.
      await applicant.gotoWeb('/providers/register');
      const form = applicant.page.locator('form.provider-apply-form');
      await form.locator('input[name="businessName"]').fill(businessName);
      await form.locator('input[name="contactName"]').fill('E2E Yetkili');
      await form.locator('input[name="phone"]').fill('05551112233');
      await form.locator('input[name="email"]').fill(email);
      await form.locator('select[name="city"]').selectOption(location.city);
      await form.locator('select[name="district"]').selectOption(location.district);
      await form.locator(`input[name="categoryIds"][value="${category.id}"]`).check();
      await form.getByTestId('service-area-city').selectOption(location.city);
      await form.getByTestId('service-area-district').selectOption(location.district);
      await form.getByTestId('service-area-add').click();
      await form.locator('select[name="businessRegistrationType"]').selectOption('NONE_DECLARED');
      await form.getByRole('button', { name: 'Başvuruyu Gönder' }).click();
      await expect(applicant.page).toHaveURL(/\/providers\/success$/);

      const claimUrl = await waitForLatestClaimUrl(email);
      const tab = await prepareStaleTab(applicant.page, providerClaimRuntime);
      await applicant.page.goto(claimUrl, { waitUntil: 'domcontentloaded' });
      await applicant.page.locator('input[name="password"]').fill(NEW_PASSWORD);
      await applicant.page.locator('input[name="passwordConfirm"]').fill(NEW_PASSWORD);
      await applicant.page.getByRole('button', { name: 'Hesabı oluştur ve başvuruyu bağla' }).click();

      await expect(applicant.page).toHaveURL(/\/providers\/me$/);
      await expect(applicant.page.getByRole('heading', { name: businessName })).toBeVisible();
      await expectNoStaleActionFailure(applicant.page, tab);
    } finally {
      await applicant.close();
    }
  });
});

test.describe('admin sign-in, sign-out and invite from a stale tab', () => {
  test('valid and invalid credentials, then sign-out', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      const tab = await prepareStaleTab(admin.page, primaryRuntime);
      await admin.gotoAdmin('/login');
      await fillLogin(admin.page, adminAccount.email, 'YanlisSifre999!');
      await expect(admin.page).toHaveURL(/\/login\?error=1$/);
      await expect(admin.page.locator('.error-message')).toBeVisible();
      await expectNoStaleActionFailure(admin.page, tab);

      await fillLogin(admin.page, adminAccount.email, adminAccount.password);
      await expect(admin.page).toHaveURL(`${primaryRuntime.adminUrl}/`);
      await expectNoStaleActionFailure(admin.page, tab);

      await admin.page.getByRole('button', { name: 'Çıkış' }).click();
      await expect(admin.page).toHaveURL(`${primaryRuntime.adminUrl}/login`);
      await expectNoStaleActionFailure(admin.page, tab);

      // The session really is gone.
      await admin.gotoAdmin('/requests');
      await expect(admin.page).toHaveURL(/\/login/);
    } finally {
      await admin.close();
    }
  });

  test('an invited operator sets a password and can sign in with it', async ({ browser }) => {
    const suffix = uniqueSuffix();
    const email = `e2e-stale-invite-${suffix}@example.test`;
    const rawToken = randomBytes(32).toString('base64url');
    const user = await prisma().user.create({
      data: { email, name: `E2E Davetli ${suffix}`, role: 'ADMIN', isActive: true, passwordHash: null },
      select: { id: true },
    });
    await prisma().adminInviteToken.create({
      data: {
        userId: user.id,
        tokenHash: createHash('sha256').update(rawToken).digest('hex'),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const invitee = await Actor.open(browser, 'invitee', primaryRuntime);

    try {
      const tab = await prepareStaleTab(invitee.page, primaryRuntime);
      await invitee.gotoAdmin(`/admin-invite?token=${encodeURIComponent(rawToken)}`);
      await invitee.page.locator('input[name="password"]').fill(NEW_PASSWORD);
      await invitee.page.locator('input[name="passwordConfirm"]').fill(NEW_PASSWORD);
      await invitee.page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();

      await expect(invitee.page.getByRole('heading', { name: 'Şifreniz oluşturuldu' })).toBeVisible();
      await expectNoStaleActionFailure(invitee.page, tab);

      await invitee.gotoAdmin('/login');
      await fillLogin(invitee.page, email, NEW_PASSWORD);
      await expect(invitee.page).not.toHaveURL(/\/login/);
      await expectNoStaleActionFailure(invitee.page, tab);
    } finally {
      await invitee.close();
    }
  });
});
