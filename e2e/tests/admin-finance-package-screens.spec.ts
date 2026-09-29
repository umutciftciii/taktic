import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createOfferPackage,
  createProvider,
  createStaffAdmin,
  prisma,
  recordCreditTransaction,
  uniqueLocation,
  uniqueSuffix,
} from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESIGN-001 Faz 3D — Finans, paketler ve iadeler: /finance,
 * /finance/credit-ledger, /finance/manual-adjustments, /finance/providers,
 * /package-purchases, /package-purchases/[id], through the real Next screens
 * against the real API and database.
 *
 * What these pin, beyond the per-flow specs that already cover the same
 * screens (lemon-checkout for the credit hold, package-refund-request for the
 * refund decisions and their dialogs, provider-promo-credits and
 * offer-packages for the ledger rows they write):
 *
 * - The finance summary's links, and the payment provider card, follow the
 *   session's permissions (F12, F3) — a link is there only when the page it
 *   opens would let this session in.
 * - The manual adjustments screen writes nothing: the credit form was not
 *   moved there (K4), and a session with a credit-write permission is only
 *   pointed at the credit screen.
 * - The ledger's figures survive the redesign: each seeded movement shows its
 *   signed amount and the balances the ledger recorded.
 * - The pending-purchase correction asks first; closing the dialog (Vazgeç,
 *   Esc, ×) writes nothing, confirming writes exactly the chosen status once.
 * - No page is wider than the window at 320, 390, 768, 1024, 1280 and 1440,
 *   with a long business name, a long package name and a long order id.
 *
 * StickyActionBar is not used by any of these screens (their forms are short
 * action forms), so its Faz 2 integration criterion does not apply here.
 */

const SCREENS_DIR = resolve(artifactsDir, 'faz-3d-screens');

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  // The design package's width, so the captures compare one to one.
  await actor.page.setViewportSize({ width: 1440, height: 1617 });
  await actor.loginToAdmin(account.email, account.password);
  return { actor, account };
}

async function expectOpen(page: Page, path: RegExp) {
  await expect(page).toHaveURL(path);
  await assertNoErrorScreen(page);
  await expect(page.getByRole('heading', { name: /yetkiniz yok/i })).toHaveCount(0);
}

async function expectNoPageOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label}: page overflow`).toBeLessThanOrEqual(1);
}

async function capture(page: Page, name: string) {
  const project = test.info().project.name;
  mkdirSync(SCREENS_DIR, { recursive: true });
  const width = page.viewportSize()?.width ?? 0;
  // The window only, as the design package's own 1440×1617 captures are.
  await page.screenshot({ path: resolve(SCREENS_DIR, `${project}-${name}-${width}.png`) });
}

/**
 * A credit package that is never on sale: the admin screens read the
 * purchase's own snapshot, and a live package would join every later spec's
 * catalogue (lemon-checkout expects exactly its own).
 */
async function retiredOfferPackage(name: string, creditAmount = 150) {
  const pkg = await createOfferPackage({ type: 'ONE_TIME_CREDITS', name, creditAmount });
  await prisma().offerCreditPackage.update({ where: { id: pkg.id }, data: { isActive: false } });
  return pkg;
}

/** A provider whose ledger holds one movement of each kind the screens colour differently. */
async function providerWithLedger(businessName?: string) {
  const category = await createCategory(2, { namePrefix: 'E2E Faz3D' });
  const provider = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 0 });
  if (businessName) {
    await prisma().providerProfile.update({ where: { id: provider.id }, data: { businessName } });
  }
  await recordCreditTransaction({ providerId: provider.id, type: 'PACKAGE_PURCHASE', amount: 500, reason: 'PACKAGE_PURCHASE' });
  await recordCreditTransaction({ providerId: provider.id, type: 'OFFER_SPEND', amount: -3, reason: 'OFFER_SPEND' });
  await recordCreditTransaction({
    providerId: provider.id,
    type: 'ADMIN_GRANT',
    amount: 25,
    reason: 'MANUAL_ADJUSTMENT: Faz 3D ödeme geçti, kredi yüklenmemişti',
  });
  await recordCreditTransaction({ providerId: provider.id, type: 'ADMIN_DEDUCT', amount: -10, reason: 'MANUAL_ADJUSTMENT' });
  return { ...provider, businessName: businessName ?? provider.businessName };
}

/** A purchase still waiting for its payment, as a checkout leaves it. */
async function pendingPurchase(providerId: string, packageName: string, orderId?: string) {
  const pkg = await retiredOfferPackage(packageName);
  return prisma().packagePurchase.create({
    data: {
      providerId,
      kind: 'OFFER_PACKAGE',
      packageId: pkg.id,
      status: 'PENDING',
      creditAmountSnapshot: 150,
      priceAmountSnapshot: 1_234_567_890,
      currencySnapshot: 'TRY',
      packageNameSnapshot: pkg.name,
      paymentProvider: 'mock',
      providerOrderId: orderId ?? null,
      adminNote: 'Faz 3D önceki not',
    },
  });
}

test.describe('ADMIN-DESIGN-001 Faz 3D — finance, packages and refunds', () => {
  test('the finance summary links only to screens this session may open', async ({ browser }) => {
    const reader = await openAs(browser, ['FINANCE_READ']);
    const wide = await openAs(browser, [
      'FINANCE_READ',
      'FINANCE_LEDGER_READ',
      'PACKAGE_PURCHASES_READ',
      'OFFER_REFUND_SCAN_READ',
    ]);

    try {
      const header = (page: Page) => page.locator('.page-header-actions');

      await reader.actor.gotoAdmin('/finance');
      await expectOpen(reader.actor.page, /\/finance$/);
      // Four headline figures, and six months of real buckets under them.
      for (const id of ['finance-kpi-revenue', 'finance-kpi-spent', 'finance-kpi-refunded', 'finance-kpi-manual']) {
        await expect(reader.actor.page.getByTestId(id)).toBeVisible();
      }
      await expect(reader.actor.page.getByTestId('finance-month-bars').locator('li')).toHaveCount(6);
      // The design's breakdown and export have no data source: not drawn.
      await expect(reader.actor.page.getByText('Satılan kredi nereye gitti')).toHaveCount(0);
      await expect(reader.actor.page.getByRole('button', { name: 'Rapor indir' })).toHaveCount(0);
      await expect(reader.actor.page.getByRole('link', { name: 'Rapor indir' })).toHaveCount(0);
      // FINANCE_READ alone: none of the three header links, no ledger or
      // refund-scan quick link, no "Tümünü gör" to a list it cannot open.
      await expect(header(reader.actor.page).getByRole('link')).toHaveCount(0);
      const main = reader.actor.page.locator('main');
      await expect(main.getByRole('link', { name: 'Kredi hareketleri' })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Elle kredi işlemleri' })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'İade kontrolü' })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Paket satışları' })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Tümünü gör' })).toHaveCount(0);
      // The balances screen asks for the same permission as this one.
      await expect(main.getByRole('link', { name: 'İşletme bakiyeleri' })).toBeVisible();

      await wide.actor.gotoAdmin('/finance');
      await expectOpen(wide.actor.page, /\/finance$/);
      await expect(header(wide.actor.page).getByRole('link')).toHaveText([
        'Kredi hareketleri',
        'Paket satışları',
        'İade kontrolü',
      ]);
      await capture(wide.actor.page, 'finans-ozeti');
      // Each one opens.
      for (const [name, path] of [
        ['Kredi hareketleri', /\/finance\/credit-ledger$/],
        ['Paket satışları', /\/package-purchases$/],
        ['İade kontrolü', /\/refund-scan$/],
      ] as const) {
        await wide.actor.gotoAdmin('/finance');
        await header(wide.actor.page).getByRole('link', { name }).click();
        await expectOpen(wide.actor.page, path);
      }
    } finally {
      await reader.actor.close();
      await wide.actor.close();
    }
  });

  test('the payment provider card needs PAYMENTS_CONFIG_READ; the list does not', async ({ browser }) => {
    const plain = await openAs(browser, ['PACKAGE_PURCHASES_READ']);
    const config = await openAs(browser, ['PACKAGE_PURCHASES_READ', 'PAYMENTS_CONFIG_READ']);

    try {
      await plain.actor.gotoAdmin('/package-purchases');
      await expectOpen(plain.actor.page, /\/package-purchases$/);
      await expect(plain.actor.page.getByRole('heading', { name: 'Paket satışları', level: 1 })).toBeVisible();
      await expect(plain.actor.page.getByTestId('payment-provider-config')).toHaveCount(0);
      await expect(plain.actor.page.getByRole('heading', { name: 'Ödeme sağlayıcı' })).toHaveCount(0);

      await config.actor.gotoAdmin('/package-purchases');
      await expectOpen(config.actor.page, /\/package-purchases$/);
      await expect(config.actor.page.getByTestId('payment-provider-config')).toContainText('Kapalı — bu sürümde açılamaz');
      // Names of settings at most; never a secret.
      await expect(config.actor.page.getByTestId('payment-provider-config')).not.toContainText(/secret|api[_-]?key/i);
    } finally {
      await plain.actor.close();
      await config.actor.close();
    }
  });

  test('manual adjustments list what was done and write nothing; the form stays on the credit screen', async ({
    browser,
  }) => {
    const provider = await providerWithLedger();
    const reader = await openAs(browser, ['FINANCE_LEDGER_READ']);
    const granter = await openAs(browser, ['FINANCE_READ', 'FINANCE_LEDGER_READ', 'CREDITS_GRANT']);

    try {
      for (const actor of [reader.actor, granter.actor]) {
        await actor.gotoAdmin(`/finance/manual-adjustments?providerId=${provider.id}`);
        await expectOpen(actor.page, /\/finance\/manual-adjustments\?providerId=/);
        const main = actor.page.locator('main');
        // K4: no amount, no operation, no reason field, no write button, no
        // POST form — the credit form lives on /providers/[id]/credits.
        await expect(main.locator('input[name="amount"], input[name="operationType"], textarea[name="reason"]')).toHaveCount(0);
        await expect(main.locator('form.credit-operation-form')).toHaveCount(0);
        await expect(main.getByRole('button', { name: /Kredi ekle|Kredi düş|İşlemi uygula/ })).toHaveCount(0);
        const methods = await main.locator('form').evaluateAll((forms) =>
          forms.map((form) => (form.getAttribute('method') ?? 'get').toLowerCase()),
        );
        expect(methods.every((method) => method === 'get'), `forms: ${methods.join(',')}`).toBe(true);

        // Both manual rows, each with its signed amount and recorded balances.
        const rows = actor.page.getByTestId('manual-row');
        await expect(rows).toHaveCount(2);
        const grant = actor.page.locator('[data-testid="manual-row"][data-type="ADMIN_GRANT"]');
        await expect(grant).toContainText('+25');
        await expect(grant).toContainText('497');
        await expect(grant).toContainText('522');
        await expect(grant).toContainText('Not: Faz 3D ödeme geçti, kredi yüklenmemişti');
        const deduct = actor.page.locator('[data-testid="manual-row"][data-type="ADMIN_DEDUCT"]');
        await expect(deduct).toContainText('-10');
        await expect(deduct).toContainText('512');
      }

      // A reader holds no write permission: not pointed at a form it will not see.
      await expect(reader.actor.page.getByTestId('manual-new-adjustment')).toHaveCount(0);
      // A granter is pointed at the real credit screen, and it opens there.
      const card = granter.actor.page.getByTestId('manual-new-adjustment');
      await expect(card.getByRole('link', { name: 'İşletme seç' })).toHaveAttribute('href', '/finance/providers');
      await card.getByRole('link', { name: /kredi ekranı/ }).click();
      await expectOpen(granter.actor.page, new RegExp(`/providers/${provider.id}/credits$`));
      await expect(granter.actor.page.locator('form.credit-operation-form')).toBeVisible();
    } finally {
      await reader.actor.close();
      await granter.actor.close();
    }
  });

  test('the ledger and the balances keep every figure', async ({ browser }) => {
    const provider = await providerWithLedger();
    const { actor } = await openAs(browser, ['FINANCE_READ', 'FINANCE_LEDGER_READ']);

    try {
      await actor.gotoAdmin(`/finance/credit-ledger?providerId=${provider.id}`);
      await expectOpen(actor.page, /\/finance\/credit-ledger\?providerId=/);
      await expect(actor.page.getByTestId('ledger-provider-pin')).toContainText(provider.businessName);
      const row = (type: string) => actor.page.locator(`[data-testid="ledger-row"][data-type="${type}"]`);
      await expect(actor.page.getByTestId('ledger-row')).toHaveCount(4);
      // Önceki · Değişim · Sonraki, exactly as the ledger recorded them.
      await expect(row('PACKAGE_PURCHASE').locator('td.is-num')).toHaveText(['0', '+500', '500']);
      await expect(row('OFFER_SPEND').locator('td.is-num')).toHaveText(['500', '-3', '497']);
      await expect(row('ADMIN_GRANT').locator('td.is-num')).toHaveText(['497', '+25', '522']);
      await expect(row('ADMIN_DEDUCT').locator('td.is-num')).toHaveText(['522', '-10', '512']);
      await expect(row('OFFER_SPEND')).toContainText('Teklif Harcaması');
      await expect(actor.page.getByTestId('ledger-page-summary')).toHaveText('4 kaydın 1–4 arası gösteriliyor');
      // The type filter narrows and keeps the pin.
      await actor.page.locator('#ledger-type').selectOption('ADMIN_DEDUCT');
      await actor.page.getByTestId('ledger-filters').getByRole('button', { name: 'Filtrele' }).click();
      await expect(actor.page).toHaveURL(new RegExp(`providerId=${provider.id}`));
      await expect(actor.page.getByTestId('ledger-row')).toHaveCount(1);
      await capture(actor.page, 'kredi-hareketleri');

      await actor.gotoAdmin(`/finance/providers?q=${encodeURIComponent(provider.businessName)}`);
      await expectOpen(actor.page, /\/finance\/providers\?q=/);
      const balance = actor.page.getByTestId('provider-finance-row').filter({ hasText: provider.businessName });
      await expect(balance).toHaveCount(1);
      await expect(balance.getByTestId('provider-finance-balance')).toHaveText('512');
      // Eleven columns, as before the redesign (K7).
      await expect(actor.page.getByTestId('provider-finance-table').locator('thead th')).toHaveCount(11);
      await expect(balance.getByRole('link', { name: 'Hareketler' })).toHaveAttribute(
        'href',
        `/finance/credit-ledger?providerId=${provider.id}`,
      );
      await capture(actor.page, 'isletme-bakiyeleri');
    } finally {
      await actor.close();
    }
  });

  test('a pending purchase’s correction asks first and writes once; without the permission there is none', async ({
    browser,
  }) => {
    const provider = await providerWithLedger();
    const purchase = await pendingPurchase(provider.id, 'E2E Faz3D Düzeltme');
    const reader = await openAs(browser, ['PACKAGE_PURCHASES_READ']);
    const writer = await openAs(browser, ['PACKAGE_PURCHASES_READ', 'PACKAGE_PURCHASE_STATUS_WRITE']);
    const read = () => prisma().packagePurchase.findUniqueOrThrow({ where: { id: purchase.id } });

    try {
      await reader.actor.gotoAdmin(`/package-purchases/${purchase.id}`);
      await expectOpen(reader.actor.page, new RegExp(`/package-purchases/${purchase.id}$`));
      await expect(reader.actor.page.getByTestId('purchase-status')).toHaveText('Bekliyor');
      await expect(reader.actor.page.getByTestId('purchase-status-form')).toHaveCount(0);
      await expect(reader.actor.page.getByRole('button', { name: /işaretle/ })).toHaveCount(0);

      const page = writer.actor.page;
      await writer.actor.gotoAdmin(`/package-purchases/${purchase.id}`);
      await expectOpen(page, new RegExp(`/package-purchases/${purchase.id}$`));
      await expect(page.getByTestId('purchase-fact-amount')).toContainText('12.345.678,90');
      await page.locator('#purchase-admin-note').fill('Faz 3D: ödeme oturumu terk edildi');

      const trigger = page.getByTestId('purchase-mark-cancelled');
      const dialog = page.getByTestId('purchase-mark-cancelled-dialog');
      // Vazgeç, Esc and × each close it without writing anything.
      for (const close of ['Vazgeç', 'Escape', 'Kapat'] as const) {
        await trigger.click();
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('Para ve kredi hareket etmez');
        await expect(dialog).toHaveAttribute('aria-labelledby', /.+/);
        await expect(dialog).toHaveAttribute('aria-describedby', /.+/);
        // Focus starts on the safe choice.
        await expect(dialog.getByRole('button', { name: 'Vazgeç' })).toBeFocused();
        if (close === 'Escape') await page.keyboard.press('Escape');
        else await dialog.getByRole('button', { name: close }).click();
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
      }
      expect(await read()).toMatchObject({ status: 'PENDING', cancelledAt: null, adminNote: 'Faz 3D önceki not' });

      await trigger.click();
      await dialog.getByRole('button', { name: 'Evet, iptal olarak işaretle' }).click();
      await expect(page.getByTestId('purchase-status')).toHaveText('İptal');
      const after = await read();
      expect(after).toMatchObject({ status: 'CANCELLED', expiredAt: null, adminNote: 'Faz 3D: ödeme oturumu terk edildi' });
      expect(after.cancelledAt).not.toBeNull();
      // One write: the row changed once and holds no credit.
      expect(after.creditTransactionId).toBeNull();
      await expect(page.getByTestId('purchase-status-form')).toHaveCount(0);
      await expect(page.getByText('Manuel düzeltme yapılamaz')).toBeVisible();

      // The other outcome is the other button's own value, sent the same way.
      const second = await pendingPurchase(provider.id, 'E2E Faz3D Süre');
      await writer.actor.gotoAdmin(`/package-purchases/${second.id}`);
      await page.getByTestId('purchase-mark-expired').click();
      await page
        .getByTestId('purchase-mark-expired-dialog')
        .getByRole('button', { name: 'Evet, süresi doldu olarak işaretle' })
        .click();
      await expect(page.getByTestId('purchase-status')).toHaveText('Süresi doldu');
      const expired = await prisma().packagePurchase.findUniqueOrThrow({ where: { id: second.id } });
      expect(expired).toMatchObject({ status: 'EXPIRED', cancelledAt: null, adminNote: null });
      expect(expired.expiredAt).not.toBeNull();
    } finally {
      await reader.actor.close();
      await writer.actor.close();
    }
  });

  test('no screen is wider than the window, at any width, with long names and ids', async ({ browser }) => {
    const longName = `E2E Faz3D Çok Uzun İsimli Kombi Klima Doğalgaz Tesisat Ve Bakım Hizmetleri Limited Şirketi ${uniqueSuffix()}`;
    const provider = await providerWithLedger(longName);
    const purchase = await pendingPurchase(
      provider.id,
      'E2E Faz3D Kurumsal Yıllık Süper Avantajlı Teklif Kredisi Paketi Beş Yüz Kredi',
      `lemon-order-${'9'.repeat(48)}`,
    );
    const { actor } = await openAs(browser, 'super');
    const page = actor.page;

    const routes: Array<[string, string]> = [
      ['/finance', 'finans-ozeti'],
      [`/finance/credit-ledger?providerId=${provider.id}`, 'kredi-hareketleri'],
      [`/finance/manual-adjustments?providerId=${provider.id}`, 'elle-kredi-islemleri'],
      [`/finance/providers?q=${encodeURIComponent(longName)}`, 'isletme-bakiyeleri'],
      ['/package-purchases', 'paket-satislari'],
      [`/package-purchases/${purchase.id}`, 'paket-satisi-detayi'],
      ['/package-refunds', 'paket-iadeleri'],
    ];

    try {
      for (const width of [1440, 1280, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1617 : 900 });
        for (const [path, name] of routes) {
          await actor.gotoAdmin(path);
          await assertNoErrorScreen(page);
          await expectNoPageOverflow(page, `${path} @${width}`);
          if (width === 1440 || width === 320) await capture(page, `super-${name}`);
        }
      }
      // Wide tables scroll inside their own box, which the keyboard can reach.
      await page.setViewportSize({ width: 320, height: 900 });
      await actor.gotoAdmin(`/finance/providers?q=${encodeURIComponent(longName)}`);
      const region = page.getByRole('region', { name: 'İşletme bakiyeleri' });
      await expect(region).toHaveAttribute('tabindex', '0');
      const scrolls = await region.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(scrolls).toBe(true);
    } finally {
      await actor.close();
    }
  });
});
