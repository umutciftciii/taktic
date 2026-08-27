import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  requestFormValues,
  uniqueLocation,
} from '../src/fixtures';
import { createRequest } from '../src/journeys';
import { prisma } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * Scenario 7 — the admin panel's own Server Actions.
 *
 * Two different questions, and keeping them apart is the whole point of this
 * file. The reported screens were `UnrecognizedActionError` — "Server Action
 * … was not found on the server" — raised from the login form, from the topbar
 * logout form and from a request detail page.
 *
 * 1. **Is anything actually broken?** These cases run against `next start` on a
 *    production build, in a browser context that has never seen the app before:
 *    sign in, navigate, run a real admin action, sign out. If a route or an
 *    action manifest were wrong, this would fail.
 * 2. **What was the reported screen, then?** A Server Action is addressed by an
 *    id baked into the page that rendered its form, and `next dev` derives a
 *    fresh set on every compile. A tab left open across a restart posts an id
 *    the new process has never heard of, and Next answers 404 with
 *    `x-nextjs-action-not-found`. The last case makes that answer happen on
 *    purpose and checks the recovery: exactly one reload, and no loop.
 */

test.describe('admin session', () => {
  test('a clean session can sign in, navigate, act and sign out', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const customerAccount = await createCustomer();
    const category = await createCategory(2);
    const location = uniqueLocation();

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    // A context of its own, created here and never reused: this is the "clean
    // browser session" half of the question, so nothing may be inherited.
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const requestId = await createRequest(
        customer,
        category,
        requestFormValues(location, customerAccount.name),
      );

      // ---- the login action ---------------------------------------------
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await expect(admin.page).toHaveURL(new RegExp(`^${primaryRuntime.adminUrl}/$`));

      // ---- client-side navigation, then a hard load of the same route ----
      // Both matter: the first keeps the original document (and its action
      // ids) alive, the second replaces it.
      await admin.page.getByRole('link', { name: 'Talepler' }).first().click();
      await expect(admin.page).toHaveURL(/\/requests/);
      await assertNoErrorScreen(admin.page);

      await admin.gotoAdmin(`/requests/${requestId}`);
      await assertNoErrorScreen(admin.page);

      // ---- a real admin action on that page ------------------------------
      await admin.page.getByRole('button', { name: 'Onayla' }).click();
      await expect(admin.page.getByTestId('request-status')).toHaveText('Onaylandı');
      await assertNoErrorScreen(admin.page);

      // ---- the logout action, from the topbar ----------------------------
      await admin.page.getByRole('button', { name: 'Çıkış' }).click();
      await expect(admin.page).toHaveURL(/\/login/);
      await assertNoErrorScreen(admin.page);

      // The session really is gone: the middleware sends a protected route
      // straight back to the form.
      await admin.gotoAdmin('/requests');
      await expect(admin.page).toHaveURL(/\/login/);
    } finally {
      await Promise.all([customer.close(), admin.close()]);
    }
  });

  test('a stale Server Action id reloads the page once, and only once', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      // Counted from the browser's side so the assertion is about real page
      // loads, not about anything the application reports.
      let loads = 0;
      admin.page.on('load', () => {
        loads += 1;
      });

      await admin.gotoAdmin('/login');
      await expect(admin.page.locator('input[name="email"]')).toBeVisible();
      const loadsBeforeSubmit = loads;

      // Exactly the answer a dev server gives a tab holding ids from an
      // earlier compile. Nothing is faked on the client: this is the real
      // response, so the real UnrecognizedActionError is thrown by Next's own
      // code and reaches the real error boundary.
      let refusals = 0;
      await admin.page.route(
        (url) => url.pathname === '/login',
        async (route, request) => {
          if (request.method() !== 'POST' || !request.headers()['next-action']) {
            return route.fallback();
          }

          refusals += 1;
          return route.fulfill({
            status: 404,
            headers: { 'x-nextjs-action-not-found': '1', 'content-type': 'text/plain' },
            body: 'Server action not found.',
          });
        },
      );

      await admin.page.locator('input[name="email"]').fill(adminAccount.email);
      await admin.page.locator('input[name="password"]').fill(adminAccount.password);
      await admin.page.getByRole('button', { name: 'Giriş Yap' }).click();

      // One reload, and the usable form back — not the generic error screen.
      await expect.poll(() => loads, { timeout: 15_000 }).toBe(loadsBeforeSubmit + 1);
      await expect(admin.page.locator('input[name="email"]')).toBeVisible();
      await assertNoErrorScreen(admin.page);
      expect(refusals).toBe(1);

      // And no loop. The reloaded page posts nothing by itself, so the refusal
      // cannot recur; four seconds is far longer than the reload it just did.
      await admin.page.waitForTimeout(4_000);
      expect(loads).toBe(loadsBeforeSubmit + 1);
      expect(refusals).toBe(1);

      // The recovery is a page load, not a retry: the submission was never
      // replayed, so nobody is signed in.
      await admin.gotoAdmin('/requests');
      await expect(admin.page).toHaveURL(/\/login/);
    } finally {
      await admin.close();
    }
  });
});

/**
 * Scenario 8 — the company footer, as admin-managed data.
 *
 * The legal name, the support address and the postal address printed in every
 * transactional e-mail used to be environment variables the API refused to boot
 * without. They are business facts, so they are a form now. What is checked
 * here is the screen an operator actually uses: that it says when the footer is
 * unpublishable, that it saves, that it refuses nonsense, and that it exposes
 * nothing about the transport it is not entitled to see.
 */
test.describe('company e-mail settings', () => {
  test.beforeEach(async () => {
    // The suite shares one database and this row is a singleton, so each case
    // starts from "no operator has saved one yet" — which is also the state a
    // real deployment is in the first time it opens the screen.
    await prisma().companySettings.deleteMany({});
  });

  test('an operator fills in a footer that starts out missing', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/company-settings');

      // Nothing is seeded, and the screen says so rather than showing blanks
      // that look like saved empty values.
      const issues = admin.page.getByTestId('company-settings-issues');
      await expect(issues).toBeVisible();
      await expect(issues).toContainText('Şirket bilgileri hiç kaydedilmemiş');
      await assertNoErrorScreen(admin.page);

      // ---- a value that cannot receive mail is refused ------------------
      await admin.page.locator('input[name="legalName"]').fill('E2E Örnek Teknoloji A.Ş.');
      await admin.page.locator('input[name="supportEmail"]').fill('destek@example.test');
      await admin.page.getByRole('button', { name: 'Kaydet' }).click();
      // The page's own banner, not Next's route announcer — which also carries
      // role="alert" and would make a bare role query ambiguous.
      await expect(admin.page.getByTestId('company-settings-error')).toContainText('placeholder');
      await assertNoErrorScreen(admin.page);
      expect(await prisma().companySettings.count()).toBe(0);

      // ---- and so is a legal name that is only the product name ---------
      await admin.page.locator('input[name="legalName"]').fill('TakTick');
      await admin.page.locator('input[name="supportEmail"]').fill('destek@e2e-ornek.com.tr');
      await admin.page.getByRole('button', { name: 'Kaydet' }).click();
      await expect(admin.page.getByTestId('company-settings-error')).toContainText('ürün adı olamaz');
      expect(await prisma().companySettings.count()).toBe(0);

      // ---- the real thing saves, and the screen says the footer is usable
      await admin.page.locator('input[name="legalName"]').fill('E2E Örnek Teknoloji A.Ş.');
      await admin.page.locator('input[name="supportEmail"]').fill('destek@e2e-ornek.com.tr');
      await admin.page.locator('textarea[name="postalAddress"]').fill('Bir Cadde No:1, Çankaya');
      await admin.page.getByRole('button', { name: 'Kaydet' }).click();

      await expect(admin.page.getByTestId('company-settings-complete')).toBeVisible();
      await expect(admin.page.getByTestId('company-settings-issues')).toHaveCount(0);
      await assertNoErrorScreen(admin.page);

      const stored = await prisma().companySettings.findMany();
      expect(stored).toHaveLength(1);
      expect(stored[0]!.id).toBe('singleton');
      expect(stored[0]!.legalName).toBe('E2E Örnek Teknoloji A.Ş.');
      expect(stored[0]!.supportEmail).toBe('destek@e2e-ornek.com.tr');
      expect(stored[0]!.updatedById).toBe(adminAccount.id);

      // A reload shows the stored values, not the ones still in the form.
      await admin.gotoAdmin('/company-settings');
      await expect(admin.page.locator('input[name="supportEmail"]')).toHaveValue(
        'destek@e2e-ornek.com.tr',
      );

      // ---- and nothing technical is on the page ------------------------
      const body = await admin.page.locator('body').innerText();
      for (const forbidden of ['RESEND', 'resend', 're_', 'noreply@', 'API_KEY']) {
        expect(body).not.toContain(forbidden);
      }
      const html = await admin.page.content();
      expect(html).not.toContain('RESEND_API_KEY');
      expect(html).not.toContain('EMAIL_FROM');
    } finally {
      await admin.close();
    }
  });

  test('a customer cannot reach the settings screen', async ({ browser }) => {
    const customerAccount = await createCustomer();
    const intruder = await Actor.open(browser, 'intruder', primaryRuntime);

    try {
      // A customer session exists, but it is not an admin session: the admin
      // app checks the role itself and sends them to the login form rather than
      // rendering a page whose API calls would 403 anyway.
      await intruder.loginToWeb(customerAccount.email, customerAccount.password);
      await intruder.gotoAdmin('/company-settings');

      await expect(intruder.page).toHaveURL(/\/login/);
      await expect(intruder.page.getByTestId('company-settings-form')).toHaveCount(0);
      await assertNoErrorScreen(intruder.page);
    } finally {
      await intruder.close();
    }
  });
});
