import { expect, test, type Page } from '@playwright/test';
import { Actor, expectNotFoundScreen } from '../src/actors';
import { createCategory, createCustomer, createProvider, uniqueLocation } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * Two provider-panel screens, opened by somebody they do not belong to.
 *
 * `/providers/:id/credits` and `/providers/:id/offers` are provider-scoped, and
 * the API has always refused them correctly: ProviderAccessGuard answers 403 for
 * another provider's id, for a customer, and for an id that names nothing. What
 * these two screens did with that answer was the defect. Every other scoped page
 * in this app runs its fetch through `fetchOrNotFound`; these two called
 * `apiFetch` bare, so the 403 became an unhandled rejection in a server
 * component — the generic error boundary in a built app, and the Next dev
 * overlay in the runtime staging is currently started with.
 *
 * That overlay is the reason the body is scanned here rather than only the
 * heading. It is a debugging surface, not a page: it names internal module
 * paths, `rsc://` request URLs and the framework's own portal element, and none
 * of that belongs in front of somebody who just tried an id that was not theirs.
 *
 * The credit balance is asserted to be absent as well. A 404 that still rendered
 * the shell would be a 404 that leaked the number it was refusing to show.
 */

/** Strings that only appear when a framework internal has reached the page. */
const DEV_INTERNALS = ['nextjs-portal', 'webpack-internal', 'rsc://'];

/** The two paths under test, as a function of the provider id in the URL. */
const SCOPED_PATHS = (providerId: string) => [
  `/providers/${providerId}/credits`,
  `/providers/${providerId}/offers`,
];

/**
 * Opens a path and insists it is a real 404: the status on the wire, the shared
 * not-found screen, and no framework internals anywhere in the document.
 *
 * The status is checked because the screen alone cannot tell a `notFound()`
 * apart from an error page that happens to look calm, and a 200 here would mean
 * search engines and monitoring were being told the page exists.
 */
async function expectQuiet404(page: Page, url: string) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });

  expect(response?.status(), `${url} must answer 404`).toBe(404);
  await expectNotFoundScreen(page);

  const html = await page.content();
  for (const internal of DEV_INTERNALS) {
    expect(html, `${url} must not surface "${internal}"`).not.toContain(internal);
  }
}

test.describe('another party’s provider panel', () => {
  test('a customer gets 404 on the credits and offers screens, not an error page', async ({
    browser,
  }) => {
    const category = await createCategory(2);
    const provider = await createProvider({
      categoryId: category.id,
      location: uniqueLocation(),
      credits: 7,
    });
    const customerAccount = await createCustomer('E2E Meraklı Müşteri');
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);

      for (const path of SCOPED_PATHS(provider.id)) {
        await expectQuiet404(customer.page, customer.webUrl(path));
        // Not the 404 page wrapped in somebody else's panel: the provider shell
        // carries the credit balance in its sidebar, and a refusal that still
        // rendered it would be a refusal that leaked the number.
        await expect(customer.page.locator('.pdash-credit-value')).toHaveCount(0);
      }
    } finally {
      await customer.close();
    }
  });

  test('a provider gets 404 on another provider’s credits and offers screens', async ({
    browser,
  }) => {
    const category = await createCategory(2);
    const location = uniqueLocation();
    const owner = await createProvider({ categoryId: category.id, location, credits: 7 });
    const outsider = await createProvider({ categoryId: category.id, location, credits: 3 });
    const actor = await Actor.open(browser, 'outsider-provider', primaryRuntime);

    try {
      await actor.loginToWeb(outsider.email, outsider.password);

      for (const path of SCOPED_PATHS(owner.id)) {
        await expectQuiet404(actor.page, actor.webUrl(path));
      }
    } finally {
      await actor.close();
    }
  });

  test('an id that names no provider is 404 for the provider too', async ({ browser }) => {
    const category = await createCategory(2);
    const provider = await createProvider({
      categoryId: category.id,
      location: uniqueLocation(),
      credits: 5,
    });
    const actor = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await actor.loginToWeb(provider.email, provider.password);

      // A well-formed id that was never issued, and a value that is not an id
      // at all: neither may reach a stack trace.
      for (const unknownId of ['c000000000000000000000000', 'not-an-id']) {
        for (const path of SCOPED_PATHS(unknownId)) {
          await expectQuiet404(actor.page, actor.webUrl(path));
        }
      }
    } finally {
      await actor.close();
    }
  });

  test('a provider’s own credits and offers screens still work', async ({ browser }) => {
    const category = await createCategory(2);
    const provider = await createProvider({
      categoryId: category.id,
      location: uniqueLocation(),
      credits: 9,
    });
    const actor = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await actor.loginToWeb(provider.email, provider.password);

      await actor.gotoWeb(`/providers/${provider.id}/credits`);
      await expect(
        actor.page.getByRole('heading', { name: 'Krediler ve paketler' }),
      ).toBeVisible();
      await expect(actor.page.locator('.credit-balance')).toContainText('9');

      await actor.gotoWeb(`/providers/${provider.id}/offers`);
      await expect(actor.page.getByRole('heading', { name: 'Tekliflerim' })).toBeVisible();
    } finally {
      await actor.close();
    }
  });
});
