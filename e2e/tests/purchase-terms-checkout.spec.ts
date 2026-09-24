import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCategory, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { primaryRuntime, purchaseTermsRuntime } from '../src/runtime';

/**
 * CMP-006 PR-A — the purchase-terms consent at a credit-package checkout.
 *
 * Two stacks, one code base. The purchase-terms runtime's API has the release
 * gate open as PURCHASE_TERMS_GATE=test (the TEST document set, PR-B.1); the
 * primary one keeps it closed. The same credits screen therefore shows, side by side, the
 * separate, unticked, required box with the full text above it — and, with the
 * gate closed, exactly the form it always had.
 *
 * In both browsers: the box is a native checkbox inside a server-action form,
 * and the evidence row records the user agent the browser actually sent.
 */

async function packageNamed(name: string) {
  return prisma().offerCreditPackage.create({
    data: {
      name,
      slug: `e2e-kosullar-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      creditAmount: 15,
      priceAmount: 29900,
      currency: 'TRY',
      isActive: true,
      sortOrder: 99,
    },
  });
}

function packageCard(page: Page, name: string) {
  return page.locator('article.pkg-card').filter({ hasText: name });
}

test.describe('purchase-terms consent at checkout', () => {
  test('gate open (test): the full TEST text under a test warning, an unticked required box, and the evidence row', async ({
    browser,
    browserName,
  }) => {
    const category = await createCategory(3);
    const seeded = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 0 });
    const name = `E2E Koşullu Paket ${browserName} ${Date.now()}`;
    await packageNamed(name);

    const provider = await Actor.open(browser, 'provider', purchaseTermsRuntime);
    try {
      await provider.loginToWeb(seeded.email, seeded.password);
      await provider.gotoWeb(`/providers/${seeded.id}/credits`);
      await assertNoErrorScreen(provider.page);

      // The text itself, labelled as the test text it is.
      const documents = provider.page.getByTestId('purchase-terms-documents');
      await expect(documents).toBeVisible();
      await expect(provider.page.getByTestId('purchase-terms-test-banner')).toContainText(
        'Test ortamı — üretim sözleşmesi değildir.',
      );
      await expect(provider.page.getByTestId('purchase-terms-draft-banner')).toHaveCount(0);
      for (const title of ['Mesafeli Satış Sözleşmesi', 'Ön Bilgilendirme Formu', 'Kredi Paketi İade Politikası']) {
        await expect(documents.locator('summary', { hasText: title })).toBeVisible();
      }
      await documents.locator('summary', { hasText: 'Kredi Paketi İade Politikası' }).click();
      await expect(documents).toContainText('on dört (14) gün');

      // Separate, unticked, and the button waits for it.
      const card = packageCard(provider.page, name);
      const box = card.getByRole('checkbox');
      const buy = card.getByRole('button', { name: 'Test Ödemesiyle Paket Al' });
      await expect(box).not.toBeChecked();
      await expect(buy).toBeDisabled();

      await box.check();
      await expect(buy).toBeEnabled();
      await buy.click();

      await expect(provider.page).toHaveURL(/\/package-purchases\/[^/]+\/checkout$/);
      await assertNoErrorScreen(provider.page);

      const purchase = await prisma().packagePurchase.findFirstOrThrow({
        where: { providerId: seeded.id },
        include: { purchaseTermsAcceptance: true },
      });
      expect(purchase.termsAcceptanceRequired).toBe(true);
      const acceptance = purchase.purchaseTermsAcceptance!;
      expect(acceptance.documentKey).toBe('PACKAGE_PURCHASE_TERMS');
      expect(acceptance.documentVersion).toMatch(/^test-/);
      expect(acceptance.documentTextSnapshot).toContain('TEST ORTAMI — ÜRETİM SÖZLEŞMESİ DEĞİLDİR');
      expect(acceptance.sourceChannel).toBe('WEB');
      expect(acceptance.documentTextSnapshot).toContain('=== PAKET_IADE_POLITIKASI: Kredi Paketi İade Politikası (Test) ===');
      const browserAgent = await provider.page.evaluate(() => navigator.userAgent);
      expect(acceptance.userAgent).toBe(browserAgent);
      expect(acceptance.clientIp).not.toBeNull();

      // The provider's own screens never show any of it.
      await provider.gotoWeb(`/providers/${seeded.id}/package-purchases/${purchase.id}`);
      await assertNoErrorScreen(provider.page);
      const html = await provider.page.content();
      expect(html).not.toContain(acceptance.documentSha256);
      expect(html).not.toContain(acceptance.id);
    } finally {
      await provider.close();
    }
  });

  test('gate open: a stale version is sent back with an explanation, and nothing is bought', async ({
    browser,
    browserName,
  }) => {
    const category = await createCategory(3);
    const seeded = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 0 });
    const name = `E2E Eski Sürüm Paketi ${browserName} ${Date.now()}`;
    await packageNamed(name);

    const provider = await Actor.open(browser, 'provider', purchaseTermsRuntime);
    try {
      await provider.loginToWeb(seeded.email, seeded.password);
      await provider.gotoWeb(`/providers/${seeded.id}/credits`);

      const card = packageCard(provider.page, name);
      await card.getByRole('checkbox').check();
      // The page was opened under an older text. Written after the tick: the
      // hidden field is rendered by the consent component, and its re-render on
      // the tick would put the served version back.
      await card.locator('input[name="termsVersion"]').evaluate((input) => {
        (input as HTMLInputElement).value = '1999-01-01.eski';
      });
      await card.getByRole('button', { name: 'Test Ödemesiyle Paket Al' }).click();

      await expect(provider.page).toHaveURL(/\/credits\?kosullar=guncellendi/);
      await expect(provider.page.getByTestId('purchase-terms-error')).toContainText(
        'Satın alma koşulları güncellendi',
      );
      expect(await prisma().packagePurchase.count({ where: { providerId: seeded.id } })).toBe(0);
    } finally {
      await provider.close();
    }
  });

  test('gate closed: the credits screen and its checkout are what they always were', async ({
    browser,
    browserName,
  }) => {
    const category = await createCategory(3);
    const seeded = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 0 });
    const name = `E2E Kapısız Paket ${browserName} ${Date.now()}`;
    await packageNamed(name);

    const provider = await Actor.open(browser, 'provider', primaryRuntime);
    try {
      await provider.loginToWeb(seeded.email, seeded.password);
      await provider.gotoWeb(`/providers/${seeded.id}/credits`);

      await expect(provider.page.getByTestId('purchase-terms-documents')).toHaveCount(0);
      const card = packageCard(provider.page, name);
      await expect(card.getByRole('checkbox')).toHaveCount(0);
      await card.getByRole('button', { name: 'Test Ödemesiyle Paket Al' }).click();

      await expect(provider.page).toHaveURL(/\/package-purchases\/[^/]+\/checkout$/);
      const purchase = await prisma().packagePurchase.findFirstOrThrow({ where: { providerId: seeded.id } });
      expect(purchase.termsAcceptanceRequired).toBe(false);
      expect(purchase.purchaseTermsAcceptanceId).toBeNull();
      expect(await prisma().purchaseTermsAcceptance.count({ where: { purchaseId: purchase.id } })).toBe(0);
    } finally {
      await provider.close();
    }
  });
});
