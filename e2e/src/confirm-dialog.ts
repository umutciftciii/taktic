import { expect, type Locator, type Page, type Route } from '@playwright/test';

/**
 * Waits until React owns `locator` — its props are attached to the element.
 *
 * A `ConfirmDialog` trigger is a submit button whose click handler opens the
 * dialog. Clicked before hydration, React 19 queues the native submission and
 * replays it once the page hydrates, so the action runs without the dialog
 * ever opening. A test that means to go through the confirmation waits here
 * first.
 */
export async function waitForHydration(locator: Locator): Promise<void> {
  await expect
    .poll(() => locator.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps'))))
    .toBe(true);
}

/**
 * Opens a `ConfirmDialog` from its trigger and presses the confirm button.
 * The dialog is the trigger's sibling with `data-testid="<trigger>-dialog"`.
 *
 * `before` runs against the open dialog before the confirm button is pressed:
 * confirming closes the dialog, so what it says must be asserted there, not on
 * the returned locator afterwards.
 */
export async function confirmThrough(
  trigger: Locator,
  confirmLabel: string,
  before?: (dialog: Locator) => Promise<void>,
): Promise<Locator> {
  await waitForHydration(trigger);
  await trigger.click();
  const testId = await trigger.getAttribute('data-testid');
  // The open one: a list draws one dialog per row under the same test id.
  const dialog = testId
    ? trigger.page().locator(`dialog[data-testid="${testId}-dialog"][open]`)
    : trigger.page().locator('dialog.confirm-dialog[open]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Vazgeç' })).toBeFocused();
  if (before) await before(dialog);
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
  return dialog;
}

/**
 * Clicks `trigger` on `url` **before React hydrates** — the hole the
 * confirmation proof closes (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
 *
 * Every Next script request is held, so the page is only the server's markup:
 * the trigger is a plain submit button with no click handler. The click
 * submits the form; React 19's inline replay script queues that submission.
 * Then the scripts are let through, React hydrates and replays the queued
 * submission to the server action — with no dialog ever shown and therefore
 * no proof. The caller asserts what the action did with it.
 */
export async function clickBeforeHydration(page: Page, url: string, trigger: Locator): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Left in place after the release: an open gate passes every later request
  // straight through, and unrouting while held requests are still finishing
  // races them ("Route is already handled").
  await page.route(/\/_next\/static\/.+\.js(\?.*)?$/, async (route: Route) => {
    await gate;
    await route.continue().catch(() => undefined);
  });
  try {
    await page.goto(url, { waitUntil: 'commit' });
    await trigger.waitFor({ state: 'visible' });
    expect(
      await trigger.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps'))),
      'the page hydrated before the click; the scenario would prove nothing',
    ).toBe(false);
    await trigger.click();
  } finally {
    release();
  }
}
