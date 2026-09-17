import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import {
  createCategory,
  createCustomer,
  createProvider,
  createSelectQuestion,
  uniqueLocation,
} from '../src/fixtures';
import { seedCustomerRequest, stampAccountProofs } from '../src/request-fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * The customer's own request page (REQ-UX-012 and the "what did I send?"
 * block), and the settings screen's badges.
 *
 * - The owner reads back what they wrote: the category and the reference,
 *   the description, every answered question in words, the neighbourhood,
 *   the address note, the date range, the budget, the urgency. A field left
 *   empty has no row; the phone and the e-mail are not in the block.
 * - The one-time-code row — send, the code, verify — lines up: three
 *   controls of one height on one baseline at a desktop width, folding
 *   without clipping or overflow at 320px.
 * - Another customer meets the not-found screen and none of the content; a
 *   provider is sent to sign in as a customer.
 * - The settings screen shows "Doğrulandı" / "Doğrulanmadı" for the e-mail
 *   and the phone from the account's own columns — and a request of the
 *   customer's verified by code does not light the phone badge.
 */

const WIDTHS = [320, 768, 1440] as const;
/** The code row is measured at every width the requirement names. */
const OTP_WIDTHS = [320, 375, 768, 1024, 1440] as const;
const SCREENSHOT_DIR = resolve(artifactsDir, 'req-ux-012');

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${label}: the page is ${overflow}px wider than the viewport`).toBeLessThanOrEqual(0);
}

async function expectWithinViewport(page: Page, testId: string, label: string) {
  const box = await page.getByTestId(testId).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
  const limit = page.viewportSize()?.width ?? 0;
  expect(box.left, `${label}: ${testId} starts off the left edge`).toBeGreaterThanOrEqual(-1);
  expect(box.right, `${label}: ${testId} runs past the right edge`).toBeLessThanOrEqual(limit + 1);
  expect(box.scrollWidth, `${label}: ${testId}'s content is wider than it`).toBeLessThanOrEqual(
    box.clientWidth + 1,
  );
}

/**
 * The three controls of the code row: same rendered height, same type size
 * and line-height, no clipped label, and — wherever two of them share a
 * line — the same top and bottom edge, so their text sits on one baseline.
 */
async function expectAlignedOtpRow(page: Page, label: string) {
  const metrics = await page.getByTestId('phone-verification-controls').evaluate((row) => {
    const controls = Array.from(row.querySelectorAll<HTMLElement>('.otp-control'));
    return controls.map((control) => {
      const rect = control.getBoundingClientRect();
      const style = getComputedStyle(control);
      return {
        name: control.tagName === 'INPUT' ? 'code' : control.textContent?.trim() ?? '',
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        clipped: control.scrollWidth > control.clientWidth + 1,
      };
    });
  });
  expect(metrics.map((m) => m.name), label).toEqual(['Doğrulama kodu gönder', 'code', 'Doğrula']);
  const [send, code, verify] = metrics as [typeof metrics[number], typeof metrics[number], typeof metrics[number]];
  for (const control of metrics) {
    expect(control.clipped, `${label}: "${control.name}" is clipped`).toBe(false);
    expect(control.fontSize, `${label}: "${control.name}" type size`).toBe(send.fontSize);
    expect(control.lineHeight, `${label}: "${control.name}" line-height`).toBe(send.lineHeight);
    expect(control.paddingTop, `${label}: "${control.name}" padding`).toBe(send.paddingTop);
    expect(control.paddingBottom, `${label}: "${control.name}" padding`).toBe(send.paddingBottom);
    expect(Math.abs(control.height - send.height), `${label}: "${control.name}" height ${control.height} vs ${send.height}`).toBeLessThanOrEqual(1);
  }
  // The code and its button always share a line.
  expect(Math.abs(code.top - verify.top), `${label}: code and verify tops`).toBeLessThanOrEqual(1);
  expect(Math.abs(code.bottom - verify.bottom), `${label}: code and verify bottoms`).toBeLessThanOrEqual(1);
  expect(code.right, `${label}: the code field overlaps its button`).toBeLessThanOrEqual(verify.left);
  // Wherever the send button shares that line, it shares the baseline too;
  // where it has folded onto its own line, it sits above, never overlapping.
  if (Math.abs(send.top - code.top) <= 1) {
    expect(Math.abs(send.bottom - code.bottom), `${label}: send and code bottoms`).toBeLessThanOrEqual(1);
    expect(send.right, `${label}: the send button overlaps the code field`).toBeLessThanOrEqual(code.left);
  } else {
    expect(send.bottom, `${label}: the folded send button overlaps the code line`).toBeLessThanOrEqual(code.top);
  }
  return metrics;
}

/**
 * The row's words as written, not as painted: the label is uppercased by
 * CSS, and `innerText` would report "AÇIKLAMA".
 */
async function rowText(page: Page, key: string): Promise<string | null> {
  const row = page.getByTestId(`request-content-${key}`);
  if ((await row.count()) === 0) return null;
  return row.evaluate((element) =>
    Array.from(element.querySelectorAll('dt, dd'))
      .map((part) => (part.textContent ?? '').replace(/\s+/g, ' ').trim())
      .join(' '),
  );
}

test.describe('the customer’s own request page', () => {
  test('reads back what was sent, hides what was not, and keeps the code row aligned', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E İçerik' });
    const type = await createSelectQuestion({
      categoryId: category.id,
      key: 'klima_tipi',
      label: 'Klima tipi',
      options: [
        { key: 'split', label: 'Split klima' },
        { key: 'salon', label: 'Salon tipi' },
      ],
      sortOrder: 1,
    });
    const extras = await createSelectQuestion({
      categoryId: category.id,
      key: 'ek_hizmet',
      label: 'Ek hizmetler',
      options: [
        { key: 'temizlik', label: 'İç ünite temizliği' },
        { key: 'gaz', label: 'Gaz dolumu' },
      ],
      multi: true,
      sortOrder: 2,
    });
    const owner = await createCustomer('E2E Sahip');
    const full = await seedCustomerRequest({
      customerId: owner.id,
      categoryId: category.id,
      location,
      customerPhone: owner.phone,
      content: 'full',
      answers: [
        { question: type, value: 'salon' },
        { question: extras, value: ['gaz', 'temizlik'] },
      ],
    });
    const empty = await seedCustomerRequest({
      customerId: owner.id,
      categoryId: category.id,
      location,
      customerPhone: owner.phone,
      content: 'empty',
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const page = customer.page;

    try {
      await customer.loginToWeb(owner.email, owner.password);

      // ---- the full request: every value, in words -----------------------
      await customer.gotoWeb(`/requests/${full.id}/offers`);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('request-content')).toBeVisible();
      await expect(page.locator('.cdash-summary-title')).toHaveText(category.name);
      await expect(page.locator('.cdash-summary-head')).toContainText(full.requestNumber as string);
      expect(await rowText(page, 'description')).toBe(
        'Açıklama Salon kliması soğutmuyor; dış ünite ses yapıyor.',
      );
      expect(await rowText(page, 'answer-klima_tipi')).toBe('Klima tipi Salon tipi');
      expect(await rowText(page, 'answer-ek_hizmet')).toBe(
        'Ek hizmetler Gaz dolumu, İç ünite temizliği',
      );
      expect(await rowText(page, 'location')).toBe(`Konum ${location.city}, ${location.district}`);
      expect(await rowText(page, 'address-note')).toBe('Adres notu Kapıcıya haber verin, zil çalışmıyor.');
      expect(await rowText(page, 'preferred-date')).toMatch(/^Tercih edilen tarih 0?1 Eki 2026 – 0?5 Eki 2026$/);
      expect(await rowText(page, 'budget')).toBe('Bütçe ₺1.500,00 - ₺2.500,00');
      expect(await rowText(page, 'urgency')).toBe('Aciliyet Esnek');
      const block = await page.getByTestId('request-content').innerText();
      expect(block).not.toContain(owner.phone.replace(/^\+90/, ''));
      expect(block).not.toContain('@example.test');
      expect(block).not.toContain('>salon<');

      // ---- the code row, at every width ------------------------------------
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      for (const width of OTP_WIDTHS) {
        const label = `@${width}`;
        await page.setViewportSize({ width, height: 900 });
        await customer.gotoWeb(`/requests/${full.id}/offers`);
        await assertNoErrorScreen(page);
        await expectNoHorizontalOverflow(page, label);
        await expectWithinViewport(page, 'request-content', label);
        await page.getByTestId('phone-verification-card').scrollIntoViewIfNeeded();
        await expectWithinViewport(page, 'phone-verification-card', label);
        await expectWithinViewport(page, 'phone-verification-controls', label);
        const metrics = await expectAlignedOtpRow(page, label);
        if (width >= 1024) {
          // Room for all three on one line: one baseline across the row. At
          // 768px the summary's two columns leave the card too narrow for
          // that, and the send button folds onto its own line — measured
          // above as a fold, not as a misalignment.
          const tops = new Set(metrics.map((m) => m.top));
          expect(tops.size, `${label}: the three controls share one line`).toBe(1);
        }
        await page.screenshot({
          path: resolve(SCREENSHOT_DIR, `otp-row-${width}.png`),
          fullPage: false,
        });
      }

      // ---- the code row after a wrong code: same three controls, still aligned
      await page.setViewportSize({ width: 320, height: 900 });
      await customer.gotoWeb(`/requests/${full.id}/offers?verification=invalid`);
      await expect(page.getByTestId('phone-verification-message')).toContainText('Kod geçersiz');
      await expect(page.locator('#phone-code')).toHaveAttribute('aria-invalid', 'true');
      await page.getByTestId('phone-verification-card').scrollIntoViewIfNeeded();
      await expectAlignedOtpRow(page, 'after a wrong code @320');
      await expectNoHorizontalOverflow(page, 'after a wrong code @320');
      await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'otp-row-invalid-320.png'), fullPage: false });

      // ---- the empty request: the location and nothing invented ------------
      await page.setViewportSize({ width: 1280, height: 900 });
      await customer.gotoWeb(`/requests/${empty.id}/offers`);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('request-content')).toBeVisible();
      expect(await rowText(page, 'location')).toBe(`Konum ${location.city}, ${location.district}`);
      for (const key of ['description', 'address-note', 'preferred-date', 'budget', 'urgency']) {
        expect(await rowText(page, key), key).toBeNull();
      }
      await expect(page.locator('[data-testid^="request-content-answer-"]')).toHaveCount(0);
      const emptyBlock = await page.getByTestId('request-content').evaluate((element) =>
        Array.from(element.querySelectorAll('h3, dt, dd'))
          .map((part) => (part.textContent ?? '').replace(/\s+/g, ' ').trim())
          .join(' '),
      );
      expect(emptyBlock).toBe(`Talep içeriği Konum ${location.city}, ${location.district}`);
    } finally {
      await customer.close();
    }
  });

  test('another customer and a provider get none of it', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Sızıntı' });
    const owner = await createCustomer('E2E Sahip');
    const request = await seedCustomerRequest({
      customerId: owner.id,
      categoryId: category.id,
      location,
      customerPhone: owner.phone,
      content: 'full',
    });
    const strangerAccount = await createCustomer('E2E Yabancı');
    const providerAccount = await createProvider({ categoryId: category.id, location, credits: 5 });
    const stranger = await Actor.open(browser, 'stranger', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await stranger.loginToWeb(strangerAccount.email, strangerAccount.password);
      await stranger.gotoWeb(`/requests/${request.id}/offers`);
      await expectNotFoundScreen(stranger.page);
      const strangerBody = await stranger.page.locator('body').innerText();
      expect(strangerBody).not.toContain('Salon kliması soğutmuyor');
      expect(strangerBody).not.toContain('Kapıcıya haber verin');
      expect(strangerBody).not.toContain('Talep içeriği');

      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb(`/requests/${request.id}/offers`);
      await expect(provider.page).toHaveURL(/\/login\?redirectTo=/);
      const providerBody = await provider.page.locator('body').innerText();
      expect(providerBody).not.toContain('Salon kliması soğutmuyor');
      expect(providerBody).not.toContain('Talep içeriği');
    } finally {
      await Promise.all([stranger.close(), provider.close()]);
    }
  });
});

test.describe('the settings screen’s badges', () => {
  test('read the account’s own columns, and a verified request lights nothing', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Rozet' });
    const account = await createCustomer('E2E Rozet');
    await stampAccountProofs(account.id, {
      emailVerifiedAt: new Date('2026-09-10T08:00:00.000Z'),
      phoneVerifiedAt: null,
    });
    // The trap: a request on the account's own number, verified by code —
    // stamped on the request, never on the account.
    await seedCustomerRequest({
      customerId: account.id,
      categoryId: category.id,
      location,
      customerPhone: account.phone,
      content: 'empty',
      phoneVerifiedAt: new Date('2026-09-12T09:30:00.000Z'),
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const page = customer.page;

    try {
      await customer.loginToWeb(account.email, account.password);
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      for (const width of WIDTHS) {
        const label = `profile @${width}`;
        await page.setViewportSize({ width, height: 900 });
        await customer.gotoWeb('/account/profile');
        await assertNoErrorScreen(page);
        const email = page.getByTestId('account-email-verification');
        const phone = page.getByTestId('account-phone-verification');
        await expect(email, label).toHaveText('Doğrulandı');
        await expect(email, label).toHaveAttribute('data-verified', 'true');
        await expect(email, label).toHaveAttribute('aria-label', 'E-posta doğrulandı');
        await expect(phone, label).toHaveText('Doğrulanmadı');
        await expect(phone, label).toHaveAttribute('data-verified', 'false');
        await expect(phone, label).toHaveAttribute('aria-label', 'Telefon doğrulanmadı');
        // A fact, not a fault: no red, no failure word, no invented button.
        expect(await phone.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(
          /rgb\(2\d\d, [0-9]{1,2}, [0-9]{1,2}\)/,
        );
        const body = (await page.locator('body').innerText()).toLowerCase();
        expect(body, label).not.toContain('başarısız');
        expect(body, label).not.toContain('telefonu doğrula');
        await expectNoHorizontalOverflow(page, label);
        await expectWithinViewport(page, 'account-email-verification', label);
        await expectWithinViewport(page, 'account-phone-verification', label);
        await page.screenshot({
          path: resolve(SCREENSHOT_DIR, `profile-badges-${width}.png`),
          fullPage: false,
        });
      }
    } finally {
      await customer.close();
    }
  });
});
