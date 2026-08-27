import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  requestFormValues,
  uniqueLocation,
} from '../src/fixtures';
import {
  acceptOffer,
  approveRequest,
  createRequest,
  readProviderOfferId,
  submitOffer,
} from '../src/journeys';
import { primaryRuntime } from '../src/runtime';

/**
 * The provider's way back to the request an offer was made on.
 *
 * That screen is the discovery screen, and discovery deliberately stops
 * answering for a request that is no longer taking offers: `getMatchingRequest`
 * refuses anything not APPROVED with the same 404 it gives a request outside
 * the provider's categories, so a provider cannot probe for requests it may not
 * see. The refusal is right. Linking to it regardless was not — a provider
 * whose offer had just been accepted clicked "Talep Detayı" and landed on
 * "Sayfa bulunamadı", at the one moment they were most sure the job was theirs.
 *
 * So this covers both halves: the link works while the request is open, and it
 * is gone once the route would refuse — and the route is asserted to refuse, so
 * the link is not merely hidden over something that would have worked.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;

test.describe('provider request link', () => {
  test('leads to the request while it is open, and is gone once it is not', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const requestId = await createRequest(
        customer,
        category,
        requestFormValues(location, customerAccount.name),
      );

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);

      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await submitOffer(provider, {
        providerId: providerAccount.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '2200.00',
        message: 'Klimanızdaki sorunu aynı gün giderebiliriz.',
      });
      const offerId = await readProviderOfferId(provider, providerAccount.id, requestId);

      // ---- while the request is open: the link is there and it works ------
      await provider.gotoWeb(`/providers/${providerAccount.id}/offers/${offerId}`);
      const detailLink = provider.page.getByTestId('request-detail-link');
      await expect(detailLink).toHaveAttribute(
        'href',
        `/providers/${providerAccount.id}/requests/${requestId}`,
      );
      await expect(provider.page.getByTestId('request-detail-closed')).toHaveCount(0);

      await detailLink.click();
      await expect(provider.page).toHaveURL(
        new RegExp(`/providers/${providerAccount.id}/requests/${requestId}$`),
      );
      await expect(provider.page.getByRole('heading', { name: 'Teklif Ver' })).toBeVisible();
      await assertNoErrorScreen(provider.page);

      // The offers table carries the same link, and it is there too.
      await provider.gotoWeb(`/providers/${providerAccount.id}/offers`);
      await expect(provider.page.getByTestId('offer-row-request-link')).toHaveCount(1);

      // ---- the customer accepts: the request leaves APPROVED ---------------
      await acceptOffer(customer, requestId, offerId);

      // The route itself now refuses, which is the behaviour the link was
      // ignoring rather than a state this test invented.
      await provider.gotoWeb(`/providers/${providerAccount.id}/requests/${requestId}`);
      await expectNotFoundScreen(provider.page);

      // So neither screen offers it any more, and both stay usable.
      await provider.gotoWeb(`/providers/${providerAccount.id}/offers/${offerId}`);
      await expect(provider.page.getByTestId('request-detail-link')).toHaveCount(0);
      await expect(provider.page.getByRole('link', { name: 'Talep Detayı' })).toHaveCount(0);
      // This offer was accepted, so the page now carries the brief itself; the
      // stand-in note is for a request that closed *without* this provider
      // winning, which provider-work-scope.spec.ts covers on the rival.
      await expect(provider.page.getByTestId('work-scope')).toBeVisible();
      await expect(provider.page.getByTestId('request-detail-closed')).toHaveCount(0);
      await expect(provider.page.getByRole('link', { name: 'Tüm Tekliflerim' })).toBeVisible();
      await expect(provider.page.getByTestId('offer-status')).toHaveText('Kabul edildi');
      await assertNoErrorScreen(provider.page);

      await provider.gotoWeb(`/providers/${providerAccount.id}/offers`);
      await expect(provider.page.getByTestId('offer-row-request-link')).toHaveCount(0);
      await expect(
        provider.page.getByRole('link', { name: 'Teklif Detayı' }),
      ).toHaveCount(1);
      await assertNoErrorScreen(provider.page);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });
});
