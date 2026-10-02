import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { clickBeforeHydration, confirmThrough, waitForHydration } from '../src/confirm-dialog';
import { createAdmin, createOfferPackage, prisma, setAutoPublish, uniqueSuffix } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Paket A, in the browser: the sales and
 * operations switches that used to go straight through.
 *
 * - A credit-package edit asks only for what a purchase buys or costs (price,
 *   credits) and for a status moved from the form's own select — old → new
 *   in the dialog — and goes straight through for a name; the header switch
 *   asks in both directions; an active create asks with the figures typed.
 * - A vitrin package's "Satıştan kaldır" clicked before React hydrates is
 *   refused and writes nothing.
 * - Auto-publish asks before it goes on, not before it goes off.
 *
 * The campaign, scheduler, reviews, refund and offer-refund screens are driven
 * in the specs that already drive them.
 */

async function openSuper(browser: Parameters<typeof Actor.open>[0]) {
  const account = await createAdmin();
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.page.setViewportSize({ width: 1440, height: 1200 });
  await actor.loginToAdmin(account.email, account.password);
  return actor;
}

const creditPackage = (id: string) => prisma().offerCreditPackage.findUniqueOrThrow({ where: { id } });

test.describe('ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Paket A', () => {
  test('credit package edit: a name goes straight through; price and status ask, old → new', async ({ browser }) => {
    const pkg = await createOfferPackage({ type: 'ONE_TIME_CREDITS', name: 'E2E Paket A', priceAmount: 149_900, creditAmount: 10 });
    const actor = await openSuper(browser);
    const page = actor.page;

    try {
      // ---- a name alone: no dialog -------------------------------------------
      await actor.gotoAdmin(`/credit-packages/${pkg.id}`);
      await assertNoErrorScreen(page);
      const save = page.getByTestId('credit-package-save');
      await waitForHydration(save);
      await page.locator('input[name="name"]').fill(`${pkg.name} yeni`);
      await save.click();
      await expect(page).toHaveURL(/ok=saved/);
      // WebKit can follow the action's redirect with a second navigation to
      // the same URL; let it settle before the next goto, or that goto is
      // interrupted by it.
      await page.waitForLoadState('networkidle');
      await expect(page.getByTestId('credit-package-save-dialog')).toBeHidden();
      expect((await creditPackage(pkg.id)).name).toBe(`${pkg.name} yeni`);

      // ---- the price: asks, says old → new; Vazgeç writes nothing ---------------
      await actor.gotoAdmin(`/credit-packages/${pkg.id}`);
      await page.locator('input[name="priceAmount"]').fill('1.599,00');
      await waitForHydration(page.getByTestId('credit-package-save'));
      await page.getByTestId('credit-package-save').click();
      const dialog = page.getByTestId('credit-package-save-dialog');
      await expect(dialog.getByTestId('credit-package-commercial-changes')).toContainText('₺1.499,00 → ₺1.599,00');
      await expect(dialog).toContainText('bundan sonraki satın almalara');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(dialog).toBeHidden();
      expect((await creditPackage(pkg.id)).priceAmount).toBe(149_900);
      await confirmThrough(page.getByTestId('credit-package-save'), 'Evet, kaydet');
      await expect(page).toHaveURL(/ok=saved/);
      // WebKit can follow the action's redirect with a second navigation to
      // the same URL; let it settle before the next goto, or that goto is
      // interrupted by it.
      await page.waitForLoadState('networkidle');
      expect((await creditPackage(pkg.id)).priceAmount).toBe(159_900);

      // ---- credits and the form's status together: one dialog, both lines ------
      await actor.gotoAdmin(`/credit-packages/${pkg.id}`);
      await page.locator('input[name="creditAmount"]').fill('12');
      await page.locator('select[name="isActive"]').selectOption('false');
      await confirmThrough(page.getByTestId('credit-package-save'), 'Evet, kaydet', async (both) => {
        await expect(both.getByTestId('credit-package-commercial-changes')).toContainText('10 kredi → 12 kredi');
        await expect(both.getByTestId('credit-package-status-change')).toContainText('Aktif → Pasif');
      });
      await expect(page).toHaveURL(/ok=saved/);
      // WebKit can follow the action's redirect with a second navigation to
      // the same URL; let it settle before the next goto, or that goto is
      // interrupted by it.
      await page.waitForLoadState('networkidle');
      expect(await creditPackage(pkg.id)).toMatchObject({ creditAmount: 12, isActive: false });

      // ---- the header switch: before hydration it writes nothing; then it asks --
      const toggle = page.getByTestId('package-status-toggle');
      await clickBeforeHydration(page, `${primaryRuntime.adminUrl}/credit-packages/${pkg.id}`, toggle);
      await expect(page).toHaveURL(/error=/);
      await expect(page.locator('.notice-error')).toContainText('onay penceresinden onay alınamadı');
      expect((await creditPackage(pkg.id)).isActive).toBe(false);
      await actor.gotoAdmin(`/credit-packages/${pkg.id}`);
      await confirmThrough(page.getByTestId('package-status-toggle'), 'Evet, aktifleştir', async (activate) => {
        await expect(activate).toContainText('₺1.599,00');
        await expect(activate).toContainText('12 kredi (tek seferlik)');
      });
      await expect(page).toHaveURL(/ok=activated/);
      expect((await creditPackage(pkg.id)).isActive).toBe(true);
    } finally {
      // Left active, a fixture package breaks lemon-checkout's one-package view.
      await prisma().offerCreditPackage.update({ where: { id: pkg.id }, data: { isActive: false } });
      await actor.close();
    }
  });

  test('credit package create: active asks with the figures typed; the package is on sale at once', async ({ browser }) => {
    const slug = `e2e-paket-a-${uniqueSuffix()}`;
    const actor = await openSuper(browser);
    const page = actor.page;

    try {
      await actor.gotoAdmin('/credit-packages/new');
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('credit-package-new-status')).toHaveValue('true');
      await page.locator('input[name="name"]').fill(`E2E Paket A ${slug}`);
      await page.locator('input[name="slug"]').fill(slug);
      await page.locator('input[name="creditAmount"]').fill('25');
      await page.locator('input[name="priceAmount"]').fill('249,90');
      await confirmThrough(page.getByTestId('credit-package-create-submit'), 'Evet, aktif olarak oluştur', async (dialog) => {
        await expect(dialog.getByTestId('credit-package-create-summary')).toContainText(`E2E Paket A ${slug}`);
        await expect(dialog.getByTestId('credit-package-create-summary')).toContainText('₺249,90');
        await expect(dialog.getByTestId('credit-package-create-summary')).toContainText('25 kredi');
        await expect(dialog).toContainText('hemen satışa');
      });
      await expect(page).toHaveURL(/\/credit-packages\/[^/?]+\?ok=created$/);
      expect(await prisma().offerCreditPackage.findUniqueOrThrow({ where: { slug } })).toMatchObject({ isActive: true, priceAmount: 24_990 });
    } finally {
      await prisma().offerCreditPackage.updateMany({ where: { slug }, data: { isActive: false } });
      await actor.close();
    }
  });

  test('vitrin package: "Satıştan kaldır" clicked before hydration writes nothing; through the dialog it does', async ({ browser }) => {
    const pkg = await prisma().showcasePackage.create({
      data: {
        name: `E2E Paket A Vitrin ${uniqueSuffix()}`,
        slug: `vitrin-e2e-paket-a-${Date.now()}`,
        priceAmount: 120_000,
        currency: 'TRY',
        durationDays: 30,
      },
    });
    const actor = await openSuper(browser);
    const page = actor.page;

    try {
      const toggle = page.getByTestId('showcase-package-status-toggle');
      await clickBeforeHydration(page, `${primaryRuntime.adminUrl}/showcase/packages/${pkg.id}`, toggle);
      await expect(page).toHaveURL(/error=CONFIRMATION_REQUIRED/);
      await expect(page.locator('.notice-error')).toContainText('onay penceresinden onay alınamadı');
      expect((await prisma().showcasePackage.findUniqueOrThrow({ where: { id: pkg.id } })).isActive).toBe(true);

      await actor.gotoAdmin(`/showcase/packages/${pkg.id}`);
      await confirmThrough(page.getByTestId('showcase-package-status-toggle'), 'Evet, satıştan kaldır', async (dialog) => {
        await expect(dialog).toContainText('yeni satın almaya kapanır');
      });
      await expect(page).toHaveURL(/deactivated=1/);
      expect((await prisma().showcasePackage.findUniqueOrThrow({ where: { id: pkg.id } })).isActive).toBe(false);
    } finally {
      await prisma().showcasePackage.update({ where: { id: pkg.id }, data: { isActive: false } });
      await actor.close();
    }
  });

  test('auto-publish asks before going on — not before going off — and a pre-hydration click writes nothing', async ({ browser }) => {
    await setAutoPublish(false);
    const stored = async () =>
      Boolean((await prisma().operationsSettings.findUnique({ where: { id: 'singleton' } }))?.marketplaceAutoPublishEnabled);
    const actor = await openSuper(browser);
    const page = actor.page;

    try {
      await clickBeforeHydration(page, `${primaryRuntime.adminUrl}/operations-settings`, page.getByTestId('auto-publish-toggle'));
      await expect(page.getByTestId('operations-settings-error')).toContainText('onay penceresinden onay alınamadı');
      expect(await stored()).toBe(false);

      await actor.gotoAdmin('/operations-settings');
      const toggle = page.getByTestId('auto-publish-toggle');
      await waitForHydration(toggle);
      await toggle.click();
      const dialog = page.getByTestId('auto-publish-toggle-dialog');
      await expect(dialog).toContainText('moderasyon beklemeden');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
      expect(await stored()).toBe(false);

      await confirmThrough(toggle, 'Evet, otomatik yayını aç');
      await expect(page.getByTestId('auto-publish-toggle')).toHaveAttribute('aria-checked', 'true');
      expect(await stored()).toBe(true);

      // Off is one tap: no dialog.
      await waitForHydration(page.getByTestId('auto-publish-toggle'));
      await page.getByTestId('auto-publish-toggle').click();
      await expect(page.getByTestId('auto-publish-toggle')).toHaveAttribute('aria-checked', 'false');
      expect(await stored()).toBe(false);
    } finally {
      await setAutoPublish(false);
      await actor.close();
    }
  });
});
