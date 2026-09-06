import { expect, test, type Page } from '@playwright/test';
import { Actor } from '../src/actors';
import { createCategory, createCustomer, createProvider, uniqueLocation } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The account menu and the drawer toggle, as controls a person can actually hit.
 *
 * The panel screens already had a responsive suite — `responsive-shell.spec.ts`
 * measures the shell from 320px to 414px and again at 1280px — and every one of
 * those checks passed while the account menu could not be opened at all. What
 * that suite never asked was whether the control it was pressing is the *only*
 * control by that name on the page.
 *
 * It was not. The root layout renders the public site header on every route,
 * and on a panel route it was removed with CSS alone
 * (`.app-shell:has(.cdash-shell) > .lp-header { display: none }`), so the
 * markup stayed: a second `<summary aria-label="Kullanıcı menüsü">` and a
 * second "Çıkış yap" submit button, both 0×0, both ahead of the real ones in
 * document order. Anything that addresses the menu the way a person's tools do
 * — by its accessible name — landed on the dead one, and "Çıkış Yap" was
 * unreachable through the normal path at every width, in both panels.
 *
 * So the assertions here are deliberately about identity as much as geometry:
 * one trigger by that name, with a box, that a real pointer click opens, from
 * which the logout can be reached by mouse and by keyboard. The widths are the
 * ones in the brief — 320, 375, 768, 1024 and a desktop — because the two
 * breakpoints that matter (`720px` for the header shortcut and `1024px` for the
 * drawer) sit between the widths the existing suite already covered.
 *
 * Nothing here presses the logout. What the button does, and what the session
 * does after it, are `session-lifecycle.spec.ts`'s subject; this file ends one
 * step earlier, at "the person can get to it".
 */

/** The brief's matrix: two phone widths, a tablet, the drawer breakpoint, a desktop. */
const WIDTHS = [320, 375, 768, 1024, 1440] as const;

/** Below this the panel sidebar is a drawer and the hamburger is its opener. */
const DRAWER_BREAKPOINT = 1024;

const MENU_LABEL = 'Kullanıcı menüsü';
const LOGOUT_NAME = /Çıkış/i;

/**
 * The logout control, addressed by what it says rather than by its role.
 *
 * The two headers disagree about the role: the public one marks its submit
 * button `role="menuitem"`, the panels leave it a plain button. That disagreement
 * is not this file's subject — what matters is that exactly one control offers
 * to sign the person out, and that it is reachable — so the locator here is
 * role-agnostic and the assertions below use visibility, which is the browser's
 * own answer about whether something is rendered and focusable at all.
 */
function logoutControl(page: Page) {
  return page.locator('[role="menu"] button').filter({ hasText: LOGOUT_NAME });
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${label}: the page is ${overflow}px wider than the viewport`).toBeLessThanOrEqual(
    0,
  );
}

/**
 * A control with a real box, inside the window, that the pointer would actually
 * land on. The hit test is the half that matters here: a 0×0 element passes
 * every "is it visible" check that only reads styles.
 */
async function expectHittable(page: Page, selector: string, label: string) {
  const measured = await page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit =
      rect.width > 0 && rect.height > 0
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      hitsSelf: hit ? element === hit || element.contains(hit) : false,
    };
  });
  const limit = page.viewportSize()?.width ?? 0;

  expect(measured.width, `${label}: "${selector}" has no width`).toBeGreaterThan(0);
  expect(measured.height, `${label}: "${selector}" has no height`).toBeGreaterThan(0);
  expect(measured.left, `${label}: "${selector}" starts ${measured.left}px off the left edge`).toBeGreaterThanOrEqual(
    -1,
  );
  expect(
    measured.right,
    `${label}: "${selector}" ends ${measured.right - limit}px past the right edge`,
  ).toBeLessThanOrEqual(limit + 1);
  expect(
    measured.hitsSelf,
    `${label}: a click at the centre of "${selector}" would land on something else`,
  ).toBe(true);
}

/**
 * The whole point of the fix, in one assertion.
 *
 * Two elements carrying this name is the defect: the pointer, the accessibility
 * tree and every test locator have to guess which one is real, and the dead one
 * comes first.
 */
async function expectSingleAccountMenu(page: Page, label: string) {
  await expect(page.getByLabel(MENU_LABEL), `${label}: the account menu must be the only control by that name`).toHaveCount(
    1,
  );
}

/**
 * There is one logout in the document, and while the menu is shut it is not
 * rendered — so it is not in the tab order either.
 */
async function expectLogoutHiddenWhileClosed(page: Page, label: string) {
  const logout = logoutControl(page);
  await expect(logout, `${label}: exactly one logout control must exist`).toHaveCount(1);
  await expect(
    logout,
    `${label}: a closed menu must keep its logout out of the tab order`,
  ).toBeHidden();
}

/** Opens with a real pointer click and proves the logout is reachable by mouse. */
async function expectPointerOpensLogout(page: Page, menuSelector: string, label: string) {
  await expectLogoutHiddenWhileClosed(page, label);

  // Not `force: true`: the click has to survive Playwright's own actionability
  // checks, which is exactly what a 0×0 control fails.
  await page.getByLabel(MENU_LABEL).click();

  await expect(
    logoutControl(page),
    `${label}: the logout did not appear after a pointer click`,
  ).toBeVisible();
  await expectHittable(page, `${menuSelector} [role="menu"] button`, `${label} logout`);

  // The open menu is a panel of its own; it must not hang off the screen.
  await expectHittable(page, `${menuSelector} [role="menu"]`, `${label} open menu`);
  await expectNoHorizontalOverflow(page, `${label} with the account menu open`);
}

/** Tab reaches the trigger; Enter and Space both work it. */
async function expectKeyboardOpensLogout(page: Page, label: string) {
  const trigger = page.getByLabel(MENU_LABEL);

  await trigger.focus();
  await expect(trigger, `${label}: the account menu cannot take focus`).toBeFocused();

  for (const key of ['Enter', 'Space'] as const) {
    await page.keyboard.press(key);
    await expect(
      logoutControl(page),
      `${label}: ${key} did not open the account menu`,
    ).toBeVisible();

    await page.keyboard.press(key);
    await expectLogoutHiddenWhileClosed(page, `${label} after ${key} closed it`);
  }
}

/**
 * The hamburger, on the side of the breakpoint it belongs to.
 *
 * Above 1024px there is no hamburger to press and there should not be — the
 * sidebar is a column of the layout — so what is asserted there is that the
 * navigation it would have opened is on screen already. A hidden toggle beside
 * a hidden sidebar would be the real defect, and this is the check that would
 * say so.
 */
async function expectDrawerToggle(page: Page, drawerId: string, width: number, label: string) {
  const toggle = page.getByTestId('panel-drawer-toggle');
  const drawer = page.locator(drawerId);

  if (width >= DRAWER_BREAKPOINT) {
    await expect(toggle, `${label}: the hamburger belongs to the drawer layout only`).toBeHidden();
    await expect(drawer, `${label}: the sidebar must stand on its own above the breakpoint`).toBeVisible();
    return;
  }

  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expectHittable(page, '[data-testid="panel-drawer-toggle"]', `${label} hamburger`);
  await expect(drawer, `${label}: the drawer starts shut`).toBeHidden();

  // Pointer.
  await toggle.click();
  await expect(drawer).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expectNoHorizontalOverflow(page, `${label} with the drawer open`);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(toggle).toBeFocused();

  // Keyboard, both keys a button answers to, and Escape back out of each.
  for (const key of ['Enter', 'Space'] as const) {
    await toggle.focus();
    await page.keyboard.press(key);
    await expect(drawer, `${label}: ${key} did not open the drawer`).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer, `${label}: Escape did not close the drawer`).toBeHidden();
    await expect(toggle, `${label}: focus did not come back to the hamburger`).toBeFocused();
  }
}

/** Everything the brief asks of one panel screen at one width. */
async function checkPanelScreen(page: Page, options: {
  menuSelector: string;
  drawerId: string;
  width: number;
  label: string;
}) {
  const { menuSelector, drawerId, width, label } = options;

  await expectNoHorizontalOverflow(page, label);
  await expectSingleAccountMenu(page, label);
  await expectHittable(page, menuSelector, `${label} account menu`);
  await expectDrawerToggle(page, drawerId, width, label);
  await expectPointerOpensLogout(page, menuSelector.replace(/-summary$/, ''), label);
  // Shut again with the trigger. Escape is deliberately not asserted here: a
  // native `<details>` does not answer to it, and the brief asks for whatever
  // this menu already does to be left alone.
  await page.getByLabel(MENU_LABEL).click();
  await expectLogoutHiddenWhileClosed(page, `${label} closed again`);
  await expectKeyboardOpensLogout(page, label);
}

test.describe('the account menu is reachable in both panels', () => {
  test('the customer panel, at every width in the brief', async ({ browser }) => {
    const account = await createCustomer();

    for (const width of WIDTHS) {
      const customer = await Actor.open(browser, `menu-customer-${width}`, primaryRuntime, {
        viewport: { width, height: 800 },
      });

      try {
        await customer.loginToWeb(account.email, account.password);
        await customer.gotoWeb('/requests/my');
        await expect(customer.page.locator('.cdash-shell')).toBeVisible();

        await checkPanelScreen(customer.page, {
          menuSelector: '.cdash-user-summary',
          drawerId: '#cdash-drawer',
          width,
          label: `customer /requests/my @${width}`,
        });

        // The support screen is the shared frame rather than the customer's own
        // route, and it draws the same topbar — so it is where a fix applied to
        // one panel and not the shared one would show up.
        await customer.gotoWeb('/destek');
        await expectSingleAccountMenu(customer.page, `customer /destek @${width}`);
        await expectHittable(
          customer.page,
          '.cdash-user-summary',
          `customer /destek @${width} account menu`,
        );
        await expectNoHorizontalOverflow(customer.page, `customer /destek @${width}`);
      } finally {
        await customer.close();
      }
    }
  });

  test('the provider panel, at every width in the brief', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(2);
    const account = await createProvider({ categoryId: category.id, location, credits: 20 });

    for (const width of WIDTHS) {
      const provider = await Actor.open(browser, `menu-provider-${width}`, primaryRuntime, {
        viewport: { width, height: 800 },
      });

      try {
        await provider.loginToWeb(account.email, account.password);
        await provider.gotoWeb('/providers/me');
        await expect(provider.page.locator('.pdash-shell')).toBeVisible();

        await checkPanelScreen(provider.page, {
          menuSelector: '.pdash-user-summary',
          drawerId: '#pdash-drawer',
          width,
          label: `provider /providers/me @${width}`,
        });

        await provider.gotoWeb(`/providers/${account.id}/credits`);
        await expectSingleAccountMenu(provider.page, `provider credits @${width}`);
        await expectHittable(
          provider.page,
          '.pdash-user-summary',
          `provider credits @${width} account menu`,
        );
        await expectNoHorizontalOverflow(provider.page, `provider credits @${width}`);
      } finally {
        await provider.close();
      }
    }
  });

  /**
   * The public header is the other half of the same rule: a screen that is not
   * a panel keeps its own account menu, and keeps it working. Without this the
   * fix could pass by removing the header everywhere.
   */
  test('the public header keeps its account menu for both roles', async ({ browser }) => {
    const customerAccount = await createCustomer();
    const location = uniqueLocation();
    const category = await createCategory(2);
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: 20,
    });

    for (const width of WIDTHS) {
      for (const account of [customerAccount, providerAccount]) {
        const actor = await Actor.open(browser, `menu-public-${width}`, primaryRuntime, {
          viewport: { width, height: 800 },
        });

        try {
          await actor.loginToWeb(account.email, account.password);
          await actor.gotoWeb('/categories');

          const label = `public /categories @${width}`;
          await expect(actor.page.locator('#site-header')).toBeVisible();
          await expect(
            actor.page.getByTestId('panel-drawer-toggle'),
            `${label}: a public screen has no panel drawer`,
          ).toHaveCount(0);

          await expectNoHorizontalOverflow(actor.page, label);
          await expectSingleAccountMenu(actor.page, label);
          await expectHittable(actor.page, '.lp-user-summary', `${label} account menu`);
          await expectPointerOpensLogout(actor.page, '.lp-user', label);
          await actor.page.getByLabel(MENU_LABEL).click();
          await expectLogoutHiddenWhileClosed(actor.page, `${label} closed again`);
          await expectKeyboardOpensLogout(actor.page, label);
        } finally {
          await actor.close();
        }
      }
    }
  });
});
