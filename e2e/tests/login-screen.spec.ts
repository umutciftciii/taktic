import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCategory, createCustomer, createProvider, uniqueLocation } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The sign-in screens themselves: what they say, and what the browser does
 * immediately after they are used.
 *
 * Two things are checked here that no other spec covers.
 *
 * **The "Beni hatırla" control is a label and a box, and nothing else.** It
 * used to carry a second line explaining the policy, which put the longest
 * sentence on the screen next to its smallest control. The wording is gone; the
 * control is not. So this asserts the removal *and* the parts that had to
 * survive it — the accessible label, the name and the value the login action
 * reads — because a checkbox that lost its `id`/`htmlFor` pairing or its
 * `value="true"` would still look right and would no longer work.
 *
 * **Signing in leaves no runtime error behind.** The customer's first screen
 * after signing in is a client-navigated route, and a browser whose module
 * graph disagrees with the payload it was handed fails there rather than on the
 * form: the route boundary renders "Bir şeyler ters gitti" over an otherwise
 * intact page, and the console carries the reason. Reported from Safari, which
 * is why this spec is also run under WebKit (see playwright.config.ts) — the
 * engine is the variable, so asserting it in one engine only would be asserting
 * the wrong thing.
 *
 * Nothing is suppressed to make this pass. The assertions read the console the
 * application actually produced; the route boundary keeps its own
 * `console.error`, and this is the spec that would notice if it stopped
 * reporting.
 */

/** What the removed explanation said. Neither screen may say any of it again. */
const REMOVED_EXPLANATION = [
  /30 gün/,
  /Bu cihazda/,
  /işlem yapılmazsa/i,
  /oturum yine kapanır/i,
];

/**
 * Console output that means the page broke rather than merely logged.
 *
 * `originalFactory` is the webpack module factory the reported failure named;
 * "Unhandled route error" and "Unhandled application error" are what this
 * application's own two error boundaries print when they catch something. All
 * three are failures of the page, not of the test's patience.
 */
const RUNTIME_FAILURE_PATTERNS = [
  /originalFactory/,
  /Unhandled route error/,
  /Unhandled application error/,
  /is not an object/,
  /Cannot read propert/,
  /ChunkLoadError/,
  /Failed to fetch dynamically imported module/,
];

/**
 * Collects everything the page reported as an error, from the moment it is
 * attached.
 *
 * Both channels are read. A module that fails to execute surfaces as a
 * `pageerror` (an uncaught exception) and, once React has handed it to the
 * boundary, as a `console.error` — and a run that watched only one of them
 * would miss the failure whenever the other fired first.
 */
function recordRuntimeErrors(page: Page): string[] {
  const seen: string[] = [];

  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') {
      return;
    }
    seen.push(message.text());
  });
  page.on('pageerror', (error) => {
    seen.push(`${error.name}: ${error.message}`);
  });

  return seen;
}

/** The subset of what was seen that means the page broke. */
function runtimeFailures(seen: readonly string[]): string[] {
  return seen.filter((text) => RUNTIME_FAILURE_PATTERNS.some((pattern) => pattern.test(text)));
}

/** The "Beni hatırla" box, checked the way a screen reader would find it. */
function rememberBox(page: Page) {
  return page.getByLabel('Beni hatırla', { exact: true });
}

async function assertRememberIsLabelOnly(page: Page) {
  const box = rememberBox(page);

  // Reached by its accessible name, so this fails if the label and the input
  // stop being associated — not merely if the text disappears.
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute('type', 'checkbox');
  await expect(box).toHaveAttribute('name', 'rememberMe');
  // The login action reads `formData.get('rememberMe') === 'true'`; any other
  // value silently turns the box into a no-op.
  await expect(box).toHaveAttribute('value', 'true');
  await expect(box).not.toBeChecked();

  // The control still works, and unticking it leaves the form as it was.
  await box.check();
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect(box).not.toBeChecked();

  // The label carries the four words and no fifth one.
  const label = page.locator('label', { has: box }).first();
  await expect(label).toHaveText('Beni hatırla');
  await expect(label.locator('small')).toHaveCount(0);

  // And the removed sentence is nowhere else on the screen either — moving it
  // to a hint under the button would pass a label-only check and still put the
  // paragraph back on the form.
  const body = await page.locator('body').innerText();
  for (const pattern of REMOVED_EXPLANATION) {
    expect(body, `the sign-in screen must not explain "Beni hatırla" (${pattern})`).not.toMatch(
      pattern,
    );
  }
}

test.describe('sign-in screens', () => {
  test('the web "Beni hatırla" control is its label and its box, nothing more', async ({
    browser,
  }) => {
    const actor = await Actor.open(browser, 'visitor', primaryRuntime);
    try {
      await actor.gotoWeb('/login');
      await assertRememberIsLabelOnly(actor.page);
    } finally {
      await actor.close();
    }
  });

  test('the admin "Beni hatırla" control is its label and its box, nothing more', async ({
    browser,
  }) => {
    const actor = await Actor.open(browser, 'operator', primaryRuntime);
    try {
      await actor.gotoAdmin('/login');
      await assertRememberIsLabelOnly(actor.page);
    } finally {
      await actor.close();
    }
  });

  test('signing in still remembers the device when the box is ticked', async ({ browser }) => {
    // The wording went; the policy did not. Asserted here as well as in
    // session-lifecycle.spec.ts because this is the spec that changed the
    // markup the box lives in.
    const account = await createCustomer();
    const actor = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await actor.gotoWeb('/login');
      await actor.page.locator('input[name="email"]').fill(account.email);
      await actor.page.locator('input[name="password"]').fill(account.password);
      await rememberBox(actor.page).check();
      await actor.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(actor.page).not.toHaveURL(/\/login/);

      const cookie = (await actor.page.context().cookies()).find(
        (candidate) => candidate.name === 'taktic_session',
      );
      // -1 is Playwright's reading of a session cookie. A remembered session
      // has a real expiry, which is the whole difference the box buys.
      expect(cookie?.expires ?? -1).toBeGreaterThan(0);
    } finally {
      await actor.close();
    }
  });

  test('a customer reaching their default panel does so without a runtime error', async ({
    browser,
  }) => {
    const account = await createCustomer();
    const actor = await Actor.open(browser, 'customer', primaryRuntime);
    const errors = recordRuntimeErrors(actor.page);

    try {
      await actor.gotoWeb('/login');
      await actor.page.locator('input[name="email"]').fill(account.email);
      await actor.page.locator('input[name="password"]').fill(account.password);
      await actor.page.getByRole('button', { name: 'Giriş Yap' }).click();

      // No redirectTo was given, so the customer's own default is where this
      // has to land — not the home page, which is where a failed role lookup
      // sends people.
      await expect(actor.page).toHaveURL(/\/requests\/my$/);
      await expect(actor.page.getByRole('heading', { name: 'Taleplerim' })).toBeVisible();
      await assertNoErrorScreen(actor.page);

      // The panel is client-navigated and keeps polling after it settles, so
      // the window a module-graph failure appears in is the one just after
      // arrival rather than during it.
      await expect
        .poll(async () => actor.page.getByText('Bir şeyler ters gitti').count(), {
          timeout: 5_000,
        })
        .toBe(0);

      expect(runtimeFailures(errors), `runtime errors after sign-in: ${errors.join(' | ')}`).toEqual(
        [],
      );
    } finally {
      await actor.close();
    }
  });

  test('a customer sent back to where they were does so without a runtime error', async ({
    browser,
  }) => {
    const account = await createCustomer();
    const actor = await Actor.open(browser, 'customer', primaryRuntime);
    const errors = recordRuntimeErrors(actor.page);

    try {
      // The session guard hands the current path back this way when an idle
      // session ends, so this is the redirect a real customer meets most often.
      await actor.loginToWeb(account.email, account.password, '/requests/offers');

      await expect(actor.page).toHaveURL(/\/requests\/offers$/);
      await assertNoErrorScreen(actor.page);
      await expect
        .poll(async () => actor.page.getByText('Bir şeyler ters gitti').count(), {
          timeout: 5_000,
        })
        .toBe(0);

      expect(
        runtimeFailures(errors),
        `runtime errors after a redirected sign-in: ${errors.join(' | ')}`,
      ).toEqual([]);
    } finally {
      await actor.close();
    }
  });

  test('the other two roles still sign in cleanly', async ({ browser }) => {
    // The change above touched both login screens, and the customer path is the
    // only one the reported failure was about. These two are here so a fix for
    // it cannot quietly cost the other roles their sign-in.
    const category = await createCategory(2);
    const providerAccount = await createProvider({
      categoryId: category.id,
      location: uniqueLocation(),
      credits: 10,
    });
    const adminAccount = await createAdmin();

    const provider = await Actor.open(browser, 'provider', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const providerErrors = recordRuntimeErrors(provider.page);
    const adminErrors = recordRuntimeErrors(admin.page);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      // A provider's default is their own dashboard, resolved from the id the
      // login action looks up — not the customer panel and not the home page.
      await expect(provider.page).toHaveURL(new RegExp(`/providers/${providerAccount.id}/requests$`));
      await assertNoErrorScreen(provider.page);
      expect(
        runtimeFailures(providerErrors),
        `runtime errors after a provider sign-in: ${providerErrors.join(' | ')}`,
      ).toEqual([]);

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await assertNoErrorScreen(admin.page);
      expect(
        runtimeFailures(adminErrors),
        `runtime errors after an admin sign-in: ${adminErrors.join(' | ')}`,
      ).toEqual([]);
    } finally {
      await provider.close();
      await admin.close();
    }
  });
});
