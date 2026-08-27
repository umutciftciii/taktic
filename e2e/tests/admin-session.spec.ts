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
