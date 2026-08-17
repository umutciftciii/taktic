import { expect, test, type Browser } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import {
  countRefundTransactions,
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  creditBalance,
  prisma,
  requestFormValues,
  uniqueLocation,
} from '../src/fixtures';
import {
  approveRequest,
  createRequest,
  fillOfferForm,
  matchingRequestIds,
  openRequestAsProvider,
  readProviderOfferId,
  submitOffer,
} from '../src/journeys';
import { primaryRuntime } from '../src/runtime';

/**
 * Scenario 3 — the edges.
 *
 * Access boundaries and failure paths, checked through the browser because that
 * is where they are actually experienced: an API that correctly answers 403 is
 * still a bug if the screen turns into "Bir şeyler ters gitti", and a refused
 * offer is still a bug if the provider cannot tell whether they were charged.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;

/** A published request with one funded provider that can see it. */
async function publishedRequest(browser: Browser) {
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

  await customer.loginToWeb(customerAccount.email, customerAccount.password);
  const values = requestFormValues(location, customerAccount.name);
  const requestId = await createRequest(customer, category, values);

  await admin.loginToAdmin(adminAccount.email, adminAccount.password);
  await approveRequest(admin, requestId);
  await admin.close();

  return { category, location, customer, customerAccount, providerAccount, requestId, values };
}

test.describe('access boundaries', () => {
  test('a stranger cannot open another customer’s request or offer', async ({ browser }) => {
    const fixture = await publishedRequest(browser);
    const strangerAccount = await createCustomer('E2E Yabancı');
    const stranger = await Actor.open(browser, 'stranger', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await provider.loginToWeb(fixture.providerAccount.email, fixture.providerAccount.password);
      await submitOffer(provider, {
        providerId: fixture.providerAccount.id,
        requestId: fixture.requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1400.00',
        message: 'Teklifimiz ektedir.',
      });
      const offerId = await readProviderOfferId(
        provider,
        fixture.providerAccount.id,
        fixture.requestId,
      );

      await stranger.loginToWeb(strangerAccount.email, strangerAccount.password);

      // The offer list of a request that is not theirs.
      await stranger.gotoWeb(`/requests/${fixture.requestId}/offers`);
      await expectNotFoundScreen(stranger.page);

      // And a specific offer on it.
      await stranger.gotoWeb(`/requests/${fixture.requestId}/offers/${offerId}`);
      await expectNotFoundScreen(stranger.page);

      // Nothing about the other customer reached the screen.
      const body = await stranger.page.locator('body').innerText();
      expect(body).not.toContain(fixture.values.customerPhone);
      expect(body).not.toContain(fixture.values.customerEmail);

      // Their own board is empty and healthy.
      await stranger.gotoWeb('/requests/my');
      await expect(stranger.page.getByTestId('request-card')).toHaveCount(0);
      await assertNoErrorScreen(stranger.page);
    } finally {
      await Promise.all([fixture.customer.close(), stranger.close(), provider.close()]);
    }
  });

  test('a provider cannot reach a request outside its categories and areas', async ({
    browser,
  }) => {
    const fixture = await publishedRequest(browser);

    // A provider in a different category and a different district: correctly
    // approved and funded, simply not a match for this request.
    const outsiderCategory = await createCategory(CATEGORY_COST);
    const outsiderAccount = await createProvider({
      categoryId: outsiderCategory.id,
      location: uniqueLocation(),
      credits: STARTING_CREDITS,
    });
    const outsider = await Actor.open(browser, 'outsider-provider', primaryRuntime);

    try {
      await outsider.loginToWeb(outsiderAccount.email, outsiderAccount.password);

      expect(await matchingRequestIds(outsider, outsiderAccount.id)).toEqual([]);

      await outsider.gotoWeb(`/providers/${outsiderAccount.id}/requests/${fixture.requestId}`);
      await expectNotFoundScreen(outsider.page);
      await expect(outsider.page.getByRole('button', { name: 'Teklifi Gönder' })).toHaveCount(0);

      // Borrowing the matching provider's id does not help either: the API
      // checks the session's ownership of that provider, not the URL.
      await outsider.gotoWeb(
        `/providers/${fixture.providerAccount.id}/requests/${fixture.requestId}`,
      );
      await expectNotFoundScreen(outsider.page);

      expect(await prisma().offer.count({ where: { requestId: fixture.requestId } })).toBe(0);
      expect(await creditBalance(outsiderAccount.id)).toBe(STARTING_CREDITS);
    } finally {
      await Promise.all([fixture.customer.close(), outsider.close()]);
    }
  });

  test('unknown ids land on the 404 page, not the error boundary', async ({ browser }) => {
    const fixture = await publishedRequest(browser);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await provider.loginToWeb(fixture.providerAccount.email, fixture.providerAccount.password);

      const unknownId = 'c000000000000000000000000';

      for (const path of [
        `/providers/${fixture.providerAccount.id}/requests/${unknownId}`,
        `/providers/${unknownId}/requests`,
        `/providers/${fixture.providerAccount.id}/offers/${unknownId}`,
      ]) {
        await provider.gotoWeb(path);
        await expectNotFoundScreen(provider.page);
      }

      await fixture.customer.gotoWeb(`/requests/${unknownId}/offers`);
      await expectNotFoundScreen(fixture.customer.page);
    } finally {
      await Promise.all([fixture.customer.close(), provider.close()]);
    }
  });
});

test.describe('pricing conflicts', () => {
  test('a price change mid-form refuses the offer and charges nothing', async ({ browser }) => {
    const fixture = await publishedRequest(browser);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await provider.loginToWeb(fixture.providerAccount.email, fixture.providerAccount.password);

      // The provider opens the form while the category still costs 2 credits.
      await openRequestAsProvider(provider, fixture.providerAccount.id, fixture.requestId);
      await expect(provider.page.getByTestId('offer-credit-cost')).toHaveText(
        String(CATEGORY_COST),
      );
      await fillOfferForm(provider, '1600.00', 'Formu doldururken fiyat değişti.');

      // Admin re-prices the category underneath them.
      const newCost = CATEGORY_COST + 3;
      await prisma().serviceCategory.update({
        where: { id: fixture.category.id },
        data: { offerCreditCost: newCost },
      });

      await provider.page.getByRole('button', { name: 'Teklifi Gönder' }).click();

      // Back on the request screen with an explanation — not an error page, and
      // not a silent charge at a price they never saw.
      await expect(provider.page).toHaveURL(/offerError=costChanged/);
      await expect(
        provider.page.getByText('Teklif gönderilmedi, kredi düşülmedi.'),
      ).toBeVisible();
      await expect(provider.page.getByText(`gördüğünüz: ${CATEGORY_COST} kredi`)).toBeVisible();
      await assertNoErrorScreen(provider.page);

      // Nothing was created and nothing was spent.
      expect(await prisma().offer.count({ where: { requestId: fixture.requestId } })).toBe(0);
      expect(await creditBalance(fixture.providerAccount.id)).toBe(STARTING_CREDITS);
      expect(await countRefundTransactions(fixture.providerAccount.id)).toBe(0);

      // Resubmitting at the price now on screen goes through, at the new price.
      await expect(provider.page.getByTestId('offer-credit-cost')).toHaveText(String(newCost));
      await fillOfferForm(provider, '1600.00', 'Güncel fiyatla tekrar gönderiyoruz.');
      await provider.page.getByRole('button', { name: 'Teklifi Gönder' }).click();

      await expect(
        provider.page.getByText('Bu talebe daha önce teklif gönderdiniz'),
      ).toBeVisible();
      expect(await creditBalance(fixture.providerAccount.id)).toBe(STARTING_CREDITS - newCost);
    } finally {
      await Promise.all([fixture.customer.close(), provider.close()]);
    }
  });
});
