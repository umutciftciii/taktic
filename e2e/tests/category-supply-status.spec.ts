import { expect, test } from '@playwright/test';
import { Actor } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createProvider,
  prisma,
  uniqueLocation,
} from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The four supply readings on the screen an operator signs a release off on.
 *
 * The rules themselves are pinned in the API suite. What only a browser can
 * show is that the panel says two different things at once — a row can read
 * "Hizmet veren hazır" and "Hazır değil" together — and that collapsing them
 * into one verdict is exactly what this column exists to prevent.
 */

test.describe('the supply readiness column', () => {
  test('walks EMPTY to SUPPLY_READY to LAUNCH_READY without losing the release verdict', async ({
    browser,
  }) => {
    // The fixture insists on a price, so the unpriced state is produced by
    // clearing it — which is also the state a freshly imported draft is in.
    const service = await createCategory(4, { status: 'DRAFT', namePrefix: 'E2E Arz' });
    await prisma().serviceCategory.update({
      where: { id: service.id },
      data: { offerCreditCost: null },
    });

    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/categories');

      await expect(admin.page.getByTestId(`supply-status-${service.slug}`)).toContainText(
        'Onaylı hizmet veren bekleniyor',
      );

      // An approved provider arrives; the price does not.
      const liveCategory = await createCategory(3);
      const providerAccount = await createProvider({
        categoryId: liveCategory.id,
        location: uniqueLocation(),
        credits: 0,
      });
      await prisma().providerServiceCategory.create({
        data: { providerId: providerAccount.id, categoryId: service.id },
      });

      await admin.gotoAdmin('/categories');
      await expect(admin.page.getByTestId(`supply-status-${service.slug}`)).toContainText(
        'teklif kredisi tanımlanmalı',
      );
      // Still red on the release column, and that is the whole point of two.
      await expect(admin.page.getByTestId(`release-row-${service.slug}`)).toContainText(
        'Hazır değil',
      );

      await prisma().serviceCategory.update({
        where: { id: service.id },
        data: { offerCreditCost: 4 },
      });

      await admin.gotoAdmin('/categories');
      await expect(admin.page.getByTestId(`supply-status-${service.slug}`)).toContainText(
        'Yayına hazır',
      );
      await expect(
        admin.page.getByTestId(`release-row-${service.slug}`).getByText('Hazır', { exact: true }),
      ).toBeVisible();
    } finally {
      await admin.close();
    }
  });

  test('says when a draft is not even taking applications, and when it starts', async ({
    browser,
  }) => {
    const closed = await createCategory(4, { status: 'DRAFT', namePrefix: 'E2E Kapali Basvuru' });
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/categories');
      await expect(admin.page.getByTestId(`enrollment-note-${closed.slug}`)).toContainText(
        'Yeni hizmet veren başvurusu kapalı',
      );

      // Opened through the product, on the screen that owns the switch.
      await admin.gotoAdmin(`/categories/${closed.slug}`);
      await admin.page.getByTestId('provider-enrollment-open').check();
      await admin.page.getByRole('button', { name: 'Kategoriyi kaydet' }).click();

      await admin.gotoAdmin('/categories');
      await expect(admin.page.getByTestId(`enrollment-note-${closed.slug}`)).toContainText(
        'Başvuruya açık, onaylı hizmet veren bekleniyor',
      );
    } finally {
      await admin.close();
    }
  });

  test('shows a live service as LIVE and offers no switch to close it', async ({ browser }) => {
    const live = await createCategory(3, { namePrefix: 'E2E Yayinda' });
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/categories/${live.slug}`);

      await expect(admin.page.getByTestId('supply-status')).toContainText('Yayında');

      const box = admin.page.getByTestId('provider-enrollment-open');
      await expect(box).toBeChecked();
      await expect(box).toBeDisabled();
    } finally {
      await admin.close();
    }
  });
});
