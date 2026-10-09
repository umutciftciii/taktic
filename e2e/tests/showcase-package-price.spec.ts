import { expect, test } from '@playwright/test';
import { settleActionRedirect } from '../src/action-redirect';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { confirmThrough } from '../src/confirm-dialog';
import { createAdmin, prisma } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The vitrin catalogue's price field speaks lira.
 *
 * Kuruş are the storage unit, and this spec is about the boundary: what an
 * operator types is lira with a comma for kuruş, what the database holds is an
 * integer of kuruş, and what every screen shows is `₺10,50`. The three are
 * asserted together on one package, through the real form, so the conversion
 * that matters is the one the product performs and not one a test restated.
 */

const uniqueSlug = () => `vitrin-e2e-fiyat-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

test.describe('vitrin: paket fiyatı Türk lirası olarak girilir', () => {
  test('10,50 girilir, 1050 kuruş saklanır, ₺10,50 gösterilir; geçersiz girişler reddedilir', async ({
    browser,
  }) => {
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const slug = uniqueSlug();
    const name = `E2E Fiyat Paketi ${slug.slice(-4)}`;

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/showcase/packages');
      await assertNoErrorScreen(admin.page);

      // The form lives in the "Yeni paket ekle" window (ADMIN-DESIGN-001 Faz 3C).
      await admin.page.getByTestId('showcase-package-new').click();
      await expect(admin.page).toHaveURL(/paket=yeni/);
      await expect(admin.page.getByTestId('showcase-package-dialog')).toBeVisible();

      const createForm = admin.page.locator('form').filter({
        has: admin.page.getByRole('button', { name: 'Paketi oluştur' }),
      });

      // The label says lira; nothing on the form says kuruş.
      await expect(createForm.getByText('Yayın bedeli (₺) *')).toBeVisible();
      await expect(admin.page.getByText('Yayın bedeli (kuruş)')).toHaveCount(0);

      // The listing order is under "Gelişmiş ayarlar", explained, and not a
      // boost: the sentence is what stops an operator selling one.
      const advanced = createForm.locator('details').filter({ hasText: 'Gelişmiş ayarlar' });
      await expect(advanced).toHaveCount(1);
      await expect(advanced).toContainText('hiçbir paket bir karta öncelik ya da sıralama avantajı vermez');

      // ── An invalid amount is refused before it reaches the API ─────────
      await createForm.locator('input[name="name"]').fill(name);
      await createForm.locator('input[name="slug"]').fill(slug);
      await createForm.locator('input[name="durationDays"]').fill('30');
      await createForm.locator('input[name="activationWindowDays"]').fill('90');
      const price = createForm.getByTestId('showcase-package-price');
      // Three decimals: the browser's own pattern check refuses it first.
      await price.fill('10,505');
      await createForm.getByRole('button', { name: 'Paketi oluştur' }).click();
      const patternRefusal = await price.evaluate(
        (element) => (element as HTMLInputElement).validity.patternMismatch,
      );
      expect(patternRefusal).toBe(true);
      expect(await prisma().showcasePackage.count({ where: { slug } })).toBe(0);

      // ── 10,50 ──────────────────────────────────────────────────────────
      await price.fill('10,50');
      // A new package is on sale at once and its slug is permanent: it asks
      // first, with the figures typed (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A).
      await confirmThrough(createForm.getByRole('button', { name: 'Paketi oluştur' }), 'Evet, oluştur ve satışa aç', async (createDialog) => {
        await expect(createDialog).toContainText('₺10,50');
        await expect(createDialog).toContainText(slug);
        await expect(createDialog).toContainText('kalıcıdır');
      });
      await expect(admin.page).toHaveURL(/created=1/);
      await assertNoErrorScreen(admin.page);

      const created = await prisma().showcasePackage.findUniqueOrThrow({ where: { slug } });
      expect(created.priceAmount).toBe(1050);
      expect(created.currency).toBe('TRY');

      // The list: Turkish money format, with the sign.
      const row = admin.page.locator('tr').filter({ hasText: name });
      await expect(row.getByTestId('showcase-package-price-cell')).toHaveText('₺10,50');

      // The edit form, on the package's own screen (Faz 3F.1): the stored
      // 1050 reads back as 10,50 — never as 1050. The slug is shown, and not sent.
      const screen = `/showcase/packages/${created.id}`;
      await row.getByTestId('showcase-package-open').click();
      await expect(admin.page).toHaveURL(new RegExp(`${screen}$`));
      await expect(admin.page.getByTestId('showcase-package-slug')).toContainText(slug);
      await expect(admin.page.locator('input[name="slug"]')).toHaveCount(0);
      const editForm = admin.page.getByTestId('showcase-package-edit-form');
      await expect(editForm.getByTestId('showcase-package-price')).toHaveValue('10,50');

      // ── 1.250,75 through the edit form ─────────────────────────────────
      await editForm.getByTestId('showcase-package-price').fill('1.250,75');
      // Redirects to this same screen: landed before the next goto (settleActionRedirect).
      await settleActionRedirect(admin.page, () =>
        confirmThrough(editForm.getByRole('button', { name: 'Kaydet', exact: true }), 'Evet, kaydet', async (repriceDialog) => {
          await expect(repriceDialog.getByTestId('showcase-package-commercial-changes')).toContainText('₺10,50 → ₺1.250,75');
        }),
      );
      await expect(admin.page).toHaveURL(/saved=1/);
      await assertNoErrorScreen(admin.page);

      const repriced = await prisma().showcasePackage.findUniqueOrThrow({ where: { slug } });
      expect(repriced.priceAmount).toBe(125075);
      await expect(admin.page.getByTestId('showcase-package-fact-price')).toContainText('₺1.250,75');
      await expect(editForm.getByTestId('showcase-package-price')).toHaveValue('1.250,75');
      await admin.gotoAdmin('/showcase/packages');
      await expect(
        admin.page.locator('tr').filter({ hasText: name }).getByTestId('showcase-package-price-cell'),
      ).toHaveText('₺1.250,75');

      // ── A whole number is lira, not kuruş ──────────────────────────────
      // From the plain screen URL, so the `?saved=1` the action redirects to
      // is a new URL this time and the wait for it is a real wait.
      await admin.gotoAdmin(screen);
      await editForm.getByTestId('showcase-package-price').fill('10');
      // Redirects to this same screen: landed before the next goto (settleActionRedirect).
      await settleActionRedirect(admin.page, () => confirmThrough(editForm.getByRole('button', { name: 'Kaydet', exact: true }), 'Evet, kaydet'));
      await expect(admin.page).toHaveURL(/saved=1/);
      await assertNoErrorScreen(admin.page);
      expect(
        (await prisma().showcasePackage.findUniqueOrThrow({ where: { slug } })).priceAmount,
      ).toBe(1000);
      await admin.gotoAdmin('/showcase/packages');
      await expect(
        admin.page.locator('tr').filter({ hasText: name }).getByTestId('showcase-package-price-cell'),
      ).toHaveText('₺10,00');

      // ── Zero is refused by the server action, with a sentence ──────────
      await admin.gotoAdmin(screen);
      // "0" passes the browser's pattern (it is digits) and fails the rule.
      await editForm.getByTestId('showcase-package-price').fill('0');
      await editForm.getByRole('button', { name: 'Kaydet', exact: true }).click();
      await expect(admin.page).toHaveURL(/error=SHOWCASE_PACKAGE_PRICE_INVALID/);
      // The refusal comes back to the package's screen, not to the list.
      await expect(admin.page).toHaveURL(new RegExp(`${screen}\\?error=`));
      await expect(admin.page.locator('.notice-error')).toContainText('Türk lirası olarak girilmeli');
      expect(
        (await prisma().showcasePackage.findUniqueOrThrow({ where: { slug } })).priceAmount,
      ).toBe(1000);
    } finally {
      await admin.close();
    }
  });
});
