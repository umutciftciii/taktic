import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createProvider,
  prisma,
  uniqueLocation,
  uniquePhone,
  uniqueSuffix,
} from '../src/fixtures';
import { seedOffer } from '../src/offer-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * ADMIN-PINNED-LABEL-001 — the offer list's pins keep their names when the
 * page has no row.
 *
 * The pins used to be named from a row of the page, so a refund filter that
 * matched nothing, or a page past the last, showed the raw id ("HV: cm…").
 * They are named by the API now; the list itself — rows, counts, pages, the
 * address — behaves exactly as before.
 */

test.describe('ADMIN-PINNED-LABEL-001 — pinned offer labels', () => {
  test('provider and request pins keep their names on an empty filter, a page out of range, and across history', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Pin' });
    const provider = await createProvider({ categoryId: category.id, location, credits: 0 });
    const requestIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const suffix = uniqueSuffix();
      const request = await prisma().serviceRequest.create({
        data: {
          categoryId: category.id,
          customerId: null,
          requestNumber: `TR-E2E-PIN-${suffix}`,
          customerName: `E2E Pin Misafir ${suffix}`,
          customerPhone: uniquePhone(),
          customerEmail: `e2e-pin-${suffix}@example.test`,
          city: location.city,
          district: location.district,
          status: 'APPROVED',
          approvedAt: new Date(),
          qualityScore: 60,
        },
        select: { id: true },
      });
      requestIds.push(request.id);
      // Outside the refund policy: the FULL_REFUND filter matches none of them.
      await seedOffer({ requestId: request.id, providerId: provider.id, refund: 'none' });
    }

    const account = await createAdmin();
    const actor = await Actor.open(browser, 'staff', primaryRuntime);
    await actor.loginToAdmin(account.email, account.password);
    const page = actor.page;
    const providerPin = page.getByTestId('offer-pin-provider');
    const expectProviderNamed = async () => {
      await expect(providerPin).toContainText(`HV: ${provider.businessName}`);
      await expect(providerPin).not.toContainText(provider.id);
    };

    try {
      await actor.gotoAdmin(`/offers?providerId=${provider.id}`);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('offer-row')).toHaveCount(2);
      await expectProviderNamed();

      // The refund filter matches nothing: no row, and still the name.
      await page.locator('#offer-refund').selectOption('FULL_REFUND');
      await page.getByRole('search', { name: 'Teklif filtreleri' }).getByRole('button', { name: 'Filtrele' }).click();
      await expect(page).toHaveURL(/[?&]refundAction=FULL_REFUND(&|$)/);
      expect(page.url()).toContain(`providerId=${provider.id}`);
      await expect(page.getByText('Filtrelere uygun teklif bulunamadı.')).toBeVisible();
      await expect(page.getByTestId('offer-row')).toHaveCount(0);
      await expectProviderNamed();

      // A page past the last one, reached by editing the address.
      await actor.gotoAdmin(`/offers?providerId=${provider.id}&page=9`);
      await expect(page.getByText('Bu sayfada teklif yok.')).toBeVisible();
      await expect(page.getByTestId('offer-row')).toHaveCount(0);
      await expectProviderNamed();

      // Back and forward are plain URL state, and every stop keeps the name.
      await page.goBack();
      await expect(page).toHaveURL(/[?&]refundAction=FULL_REFUND(&|$)/);
      await expect(page.getByTestId('offer-row')).toHaveCount(0);
      await expectProviderNamed();
      await page.goBack();
      await expect(page).not.toHaveURL(/[?&]refundAction=/);
      await expect(page.getByTestId('offer-row')).toHaveCount(2);
      await expectProviderNamed();
      await page.goForward();
      await expect(page).toHaveURL(/[?&]refundAction=FULL_REFUND(&|$)/);
      await expect(page.getByTestId('offer-row')).toHaveCount(0);
      await expectProviderNamed();

      // The request pin, the same way: an empty refund filter keeps its name.
      const requestPin = page.getByTestId('offer-pin-request');
      await actor.gotoAdmin(`/offers?requestId=${requestIds[0]}&refundAction=FULL_REFUND`);
      await expect(page.getByTestId('offer-row')).toHaveCount(0);
      await expect(requestPin).toContainText(`${category.name} · ${location.city}/${location.district}`);
      await expect(requestPin).not.toContainText(requestIds[0]!);
    } finally {
      await actor.close();
    }
  });
});
