import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCategory, createCustomer, uniqueLocation } from '../src/fixtures';
import { seedCustomerRequest, stampAccountProofs } from '../src/request-fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * The operator's customer list and detail: which of a customer's two
 * channels stand verified, from the account's own columns and nothing else.
 *
 * Three customers: one with both proofs, one with the e-mail only, and one
 * "legacy" account with neither — but with a request of theirs verified by
 * one-time code, stamped on the request. The list shows a pill per proven
 * channel and a muted "Yok" for the legacy account; the detail shows the
 * moment beside "Doğrulandı" and a neutral "Doğrulanmadı" — no red, no
 * failure word — for the rest. And neither screen makes anything of the
 * verified request.
 */

const WIDTHS = [320, 768, 1440] as const;
const SCREENSHOT_DIR = resolve(artifactsDir, 'admin-customer-verification');

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${label}: the page is ${overflow}px wider than the viewport`).toBeLessThanOrEqual(0);
}

test.describe('admin customer verification badges', () => {
  test('come from the account columns alone, on the list and on the detail', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Admin Rozet' });
    const both = await createCustomer('E2E İkisi');
    await stampAccountProofs(both.id, {
      emailVerifiedAt: new Date('2026-09-10T08:00:00.000Z'),
      phoneVerifiedAt: new Date('2026-09-12T09:30:00.000Z'),
    });
    const emailOnly = await createCustomer('E2E Yalnız E-posta');
    await stampAccountProofs(emailOnly.id, { emailVerifiedAt: new Date('2026-09-10T08:00:00.000Z') });
    const legacy = await createCustomer('E2E Eski');
    await seedCustomerRequest({
      customerId: legacy.id,
      categoryId: category.id,
      location,
      customerPhone: legacy.phone,
      content: 'empty',
      phoneVerifiedAt: new Date('2026-09-12T09:30:00.000Z'),
    });
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const page = admin.page;

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);

      // ---- the list: one row per customer, found by e-mail ----------------
      const cells: Record<string, { text: string; verified: string }> = {};
      for (const account of [both, emailOnly, legacy]) {
        await admin.gotoAdmin(`/customers?q=${encodeURIComponent(account.email)}`);
        await assertNoErrorScreen(page);
        const cell = page.getByTestId('customer-verification');
        await expect(cell).toHaveCount(1);
        cells[account.id] = {
          text: (await cell.innerText()).replace(/\s+/g, ' ').trim(),
          verified: (await cell.getAttribute('data-verified')) ?? '',
        };
      }
      expect(cells[both.id]).toEqual({ text: 'E-posta Telefon', verified: 'email phone' });
      expect(cells[emailOnly.id]).toEqual({ text: 'E-posta', verified: 'email' });
      // The verified request of the legacy account lights nothing.
      expect(cells[legacy.id]).toEqual({ text: 'Yok', verified: '' });

      // ---- the detail: the moment beside the proof, neutral for the rest --
      await admin.gotoAdmin(`/customers/${emailOnly.id}`);
      await assertNoErrorScreen(page);
      const email = page.getByTestId('customer-email-verification');
      const phone = page.getByTestId('customer-phone-verification');
      await expect(email).toHaveAttribute('data-verified', 'true');
      await expect(email).toContainText('Doğrulandı');
      await expect(email).toContainText('10 Eyl 2026');
      await expect(phone).toHaveAttribute('data-verified', 'false');
      await expect(phone).toHaveText('Doğrulanmadı');
      await expect(phone.locator('.badge')).toHaveClass(/badge-muted/);
      await expect(phone.locator('.badge')).not.toHaveClass(/badge-bad/);
      expect((await page.locator('body').innerText()).toLowerCase()).not.toContain('başarısız');

      await admin.gotoAdmin(`/customers/${legacy.id}`);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('customer-email-verification')).toHaveAttribute('data-verified', 'false');
      await expect(page.getByTestId('customer-phone-verification')).toHaveAttribute('data-verified', 'false');
      await expect(page.getByTestId('customer-phone-verification')).toHaveText('Doğrulanmadı');

      await admin.gotoAdmin(`/customers/${both.id}`);
      await expect(page.getByTestId('customer-phone-verification')).toContainText('12 Eyl 2026');

      // ---- and it fits at every width ---------------------------------------
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      for (const width of WIDTHS) {
        const label = `@${width}`;
        await page.setViewportSize({ width, height: 900 });
        await admin.gotoAdmin(`/customers?q=${encodeURIComponent(both.email)}`);
        await assertNoErrorScreen(page);
        await expect(page.getByTestId('customer-verification')).toHaveCount(1);
        await expectNoHorizontalOverflow(page, `list ${label}`);
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, `list-${width}.png`), fullPage: false });

        await admin.gotoAdmin(`/customers/${both.id}`);
        await assertNoErrorScreen(page);
        await expect(page.getByTestId('customer-phone-verification')).toBeVisible();
        await expectNoHorizontalOverflow(page, `detail ${label}`);
        const line = await page.getByTestId('customer-phone-verification').evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return { right: Math.round(rect.right), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
        });
        expect(line.right, `detail ${label}: the proof line runs past the edge`).toBeLessThanOrEqual(width + 1);
        expect(line.scrollWidth, `detail ${label}: the proof line is clipped`).toBeLessThanOrEqual(line.clientWidth + 1);
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, `detail-${width}.png`), fullPage: false });
      }
    } finally {
      await admin.close();
    }
  });
});
