import { expect, type Locator } from '@playwright/test';

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
 */
export async function confirmThrough(trigger: Locator, confirmLabel: string): Promise<Locator> {
  await waitForHydration(trigger);
  await trigger.click();
  const testId = await trigger.getAttribute('data-testid');
  const dialog = testId
    ? trigger.page().getByTestId(`${testId}-dialog`)
    : trigger.page().locator('dialog.confirm-dialog[open]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Vazgeç' })).toBeFocused();
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
  return dialog;
}
