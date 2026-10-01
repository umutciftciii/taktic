import { expect, test, type Page } from '@playwright/test';
import { HARNESS_ORIGIN, openHarness } from '../src/component-harness';

/**
 * ADMIN-DESIGN-001 Faz 2: the two shared form components no screen uses yet,
 * in a real engine.
 *
 * `ConfirmDialog` and `StickyActionBar` run here under React 19's own form
 * actions, from apps/admin/test/browser-harness/app.tsx (see
 * src/component-harness.ts for why that is not a Next route). What is proven:
 *
 * ConfirmDialog — cancel, Esc and a click on the backdrop close it without
 * submitting anything, and so does Enter in a field (it opens the dialog
 * instead of submitting); confirming submits the form exactly once, with the
 * submit button's own name/value and the fields.
 *
 * StickyActionBar — a save the server refuses loses nothing: the edits stay in
 * the fields and the guard stays on (link, Back). The browser's Back asks
 * before the router moves, and Forward cannot leave a dirty form. A save that
 * lands clears the form and gives Back its ordinary meaning again.
 */

type Entries = Array<[string, string]>;

/** The harness's window.__harness (apps/admin/test/browser-harness/app.tsx). */
declare global {
  interface Window {
    __harness: {
      submissions: Entries[];
      saves: Entries[];
      saveMode: 'ok' | 'reject';
      navigations: number;
      minted: string[];
      mintMode: 'ok' | 'refuse';
    };
  }
}

const submissions = (page: Page) => page.evaluate(() => window.__harness.submissions);
const saveCount = (page: Page) => page.evaluate(() => window.__harness.saves.length);

test.describe('ConfirmDialog', () => {
  test('cancel, Esc, the backdrop and Enter in a field submit nothing', async ({ page }) => {
    await openHarness(page, '/confirm');
    const trigger = page.getByRole('button', { name: 'Hesabı pasife al' });
    const dialog = page.getByRole('dialog', { name: 'Hesap pasife alınsın mı?' });
    await page.getByLabel('Not').fill('gerekçe');

    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription('Kullanıcı bir daha giriş yapamaz.');
    await expect(dialog.getByRole('button', { name: 'Vazgeç' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Kapat' }).click();
    await expect(dialog).toBeHidden();

    await trigger.click();
    await expect(dialog).toBeVisible();
    // The backdrop: a point outside the dialog's box.
    await page.mouse.click(5, 5);
    await expect(dialog).toBeHidden();

    // Enter in a field is the browser clicking the default button — the trigger.
    await page.getByLabel('Not').press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Give any stray submission time to arrive before asserting there was none.
    await page.waitForTimeout(300);
    expect(await submissions(page)).toEqual([]);
    await expect(page.getByTestId('result')).toHaveText('-');
  });

  test('confirming submits once, with the button name/value and the fields', async ({ page }) => {
    await openHarness(page, '/confirm');
    await page.getByLabel('Not').fill('gerekçe');
    await page.getByRole('button', { name: 'Hesabı pasife al' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Pasife al' }).click();

    await expect.poll(() => submissions(page)).toHaveLength(1);
    const [entries] = await submissions(page);
    expect(entries).toContainEqual(['note', 'gerekçe']);
    expect(entries).toContainEqual(['intent', 'deactivate']);
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.waitForTimeout(300);
    expect(await submissions(page)).toHaveLength(1);
    expect(entries!.filter(([name]) => name === 'intent')).toHaveLength(1);
  });

  // ADMIN-DESTRUCTIVE-CONFIRMATION-001: confirming asks the server for a
  // proof bound to the dialog's key and sends it with the form, once.
  test('confirming fetches one proof for the dialog\'s key and submits it for that one submission', async ({ page }) => {
    await openHarness(page, '/confirm');
    await page.getByRole('button', { name: 'Hesabı pasife al' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Pasife al' }).click();

    await expect.poll(() => submissions(page)).toHaveLength(1);
    const [entries] = await submissions(page);
    expect(entries).toContainEqual(['__confirmationProof', 'harness-proof-1']);
    expect(await page.evaluate(() => window.__harness.minted)).toEqual(['customer.status']);
    // The proof field is not left in the form for a later submission.
    expect(await page.locator('form input[name="__confirmationProof"]').count()).toBe(0);
  });

  test('a double press on confirm mints once and submits once', async ({ page }) => {
    await openHarness(page, '/confirm');
    await page.getByRole('button', { name: 'Hesabı pasife al' }).click();
    const confirm = page.getByRole('dialog').getByRole('button', { name: 'Pasife al' });
    await confirm.dblclick();

    await expect.poll(() => submissions(page)).toHaveLength(1);
    await page.waitForTimeout(300);
    expect(await submissions(page)).toHaveLength(1);
    expect(await page.evaluate(() => window.__harness.minted)).toHaveLength(1);
  });

  test('when no proof can be had the dialog stays open, says so, and submits nothing', async ({ page }) => {
    await openHarness(page, '/confirm');
    await page.evaluate(() => {
      window.__harness.mintMode = 'refuse';
    });
    await page.getByRole('button', { name: 'Hesabı pasife al' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Pasife al' }).click();

    await expect(page.getByTestId('confirm-proof-error')).toContainText('Onay doğrulanamadı');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(300);
    expect(await submissions(page)).toEqual([]);
  });

  // Faz 3D regression: a hidden field named "id" shadows `form.id`, and React
  // 19 then ties its temporary submitter input to "[object HTMLInputElement]"
  // — the button's name/value used to vanish without an error.
  test('a field named "id" in the form does not cost the button its name/value', async ({ page }) => {
    await openHarness(page, '/confirm-shadowed');
    await page.getByLabel('Not').fill('gerekçe');
    await page.getByRole('button', { name: 'Sonlandır' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Evet, sonlandır' }).click();

    await expect.poll(() => submissions(page)).toHaveLength(1);
    const [entries] = await submissions(page);
    expect(entries).toContainEqual(['id', 'rec-1']);
    expect(entries).toContainEqual(['note', 'gerekçe']);
    expect(entries!.filter(([name]) => name === 'intent')).toEqual([['intent', 'end']]);
    // The carrier is gone again: the form is back to its own fields.
    expect(await page.locator('form input[name="intent"]').count()).toBe(0);
    await page.waitForTimeout(300);
    expect(await submissions(page)).toHaveLength(1);
  });
});

test.describe('StickyActionBar', () => {
  /** /list, then the settings form through the client router, as in the app. */
  async function openSettings(page: Page) {
    await openHarness(page, '/list');
    await page.getByRole('link', { name: 'Ayarlar' }).click();
    await expect(page).toHaveURL(`${HARNESS_ORIGIN}/settings`);
    await expect(page.getByTestId('bar')).toHaveAttribute('data-dirty', 'false');
  }

  const title = (page: Page) => page.getByRole('textbox', { name: 'Başlık' });
  const bar = (page: Page) => page.getByTestId('bar');

  test('a save the server refuses keeps the edits and the guard; a save that lands clears both', async ({ page }) => {
    await openSettings(page);
    await title(page).fill('Yeni başlık');
    await page.getByRole('checkbox', { name: 'Etkin' }).uncheck();
    await expect(bar(page)).toHaveAttribute('data-dirty', 'true');
    await expect(bar(page).getByRole('status')).toHaveText('Kaydedilmemiş değişiklikler var');

    // ---- refused: React resets the form, the bar puts the edits back ------
    await page.evaluate(() => {
      window.__harness.saveMode = 'reject';
    });
    await bar(page).getByRole('button', { name: 'Değişiklikleri kaydet' }).click();
    await expect.poll(() => saveCount(page)).toBe(1);
    await expect(page.getByTestId('server-title')).toHaveText('Başlık');
    await expect(title(page)).toHaveValue('Yeni başlık');
    await expect(page.getByRole('checkbox', { name: 'Etkin' })).not.toBeChecked();
    await expect(bar(page)).toHaveAttribute('data-dirty', 'true');

    // …and leaving is still asked about: a link, then the page's own unload.
    const asked: string[] = [];
    page.once('dialog', (dialog) => {
      asked.push(dialog.type());
      void dialog.dismiss();
    });
    await page.getByRole('link', { name: 'Başka sayfa' }).click();
    await expect.poll(() => asked).toEqual(['confirm']);
    await expect(page).toHaveURL(`${HARNESS_ORIGIN}/settings`);
    await expect(title(page)).toHaveValue('Yeni başlık');
    expect(
      await page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(true);

    // ---- saved: the new default equals the submission, the form is clean --
    await page.evaluate(() => {
      window.__harness.saveMode = 'ok';
    });
    await bar(page).getByRole('button', { name: 'Değişiklikleri kaydet' }).click();
    await expect(page.getByTestId('server-title')).toHaveText('Yeni başlık');
    await expect(bar(page)).toHaveAttribute('data-dirty', 'false');
    await expect(title(page)).toHaveValue('Yeni başlık');

    // Back is ordinary again: no question, straight to the previous page.
    await page.goBack();
    await expect(page).toHaveURL(`${HARNESS_ORIGIN}/list`);
    await expect(page.getByTestId('page')).toHaveText('/list');
    expect(asked).toEqual(['confirm']);
  });

  test('the browser Back button asks before a dirty form is left, and Forward cannot leave it', async ({ page }) => {
    await openSettings(page);
    await title(page).fill('Taslak');
    await expect(bar(page)).toHaveAttribute('data-dirty', 'true');

    // Back, declined: same page, same edits, still guarded.
    const asked: string[] = [];
    page.on('dialog', (dialog) => {
      asked.push(dialog.type());
      void (asked.length === 1 ? dialog.dismiss() : dialog.accept());
    });
    await page.goBack();
    await expect.poll(() => asked).toEqual(['confirm']);
    await expect(page).toHaveURL(`${HARNESS_ORIGIN}/settings`);
    await expect(title(page)).toHaveValue('Taslak');
    await expect(bar(page)).toHaveAttribute('data-dirty', 'true');

    // Forward from here has nowhere to go: the guard entry is on top.
    await page.goForward();
    await expect(page).toHaveURL(`${HARNESS_ORIGIN}/settings`);
    await expect(title(page)).toHaveValue('Taslak');

    // Back, accepted: the previous page.
    await page.goBack();
    await expect.poll(() => asked).toEqual(['confirm', 'confirm']);
    await expect(page.getByTestId('page')).toHaveText('/list');
    await expect(page).toHaveURL(`${HARNESS_ORIGIN}/list`);
  });

  test('a form reached with Back, then edited, cannot be left with Forward', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('link', { name: 'Başka sayfa' }).click();
    await expect(page.getByTestId('page')).toHaveText('/other');
    await page.goBack();
    await expect(page).toHaveURL(`${HARNESS_ORIGIN}/settings`);

    await title(page).fill('Taslak');
    await expect(bar(page)).toHaveAttribute('data-dirty', 'true');
    await page.goForward();
    await expect(page).toHaveURL(`${HARNESS_ORIGIN}/settings`);
    await expect(title(page)).toHaveValue('Taslak');

    // "Vazgeç" is a reset the operator asked for: clean, and Back is plain again.
    await bar(page).getByRole('button', { name: 'Vazgeç' }).click();
    await expect(bar(page)).toHaveAttribute('data-dirty', 'false');
    await expect(title(page)).toHaveValue('Başlık');
    await page.goBack();
    await expect(page.getByTestId('page')).toHaveText('/list');
  });
});
