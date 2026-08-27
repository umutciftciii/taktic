import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
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
 * The customer panel's frame: its counters, its navigation and the actions an
 * offer really offers.
 *
 * All three were the same class of defect — something on screen that did not
 * describe the product. The counters vanished on every route but one, so the
 * panel told a customer with an open request that they had none. "Teklifler"
 * pointed at the href already open, so clicking it did nothing. And "Kısa
 * Listeye Al" moved an offer into a state no rule read, promising a decision
 * the platform never made.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;

/** A published, approved request carrying one live offer. */
async function requestWithOneOffer(browser: Parameters<typeof Actor.open>[0]) {
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

  await customer.loginToWeb(customerAccount.email, customerAccount.password);
  const values = requestFormValues(location, customerAccount.name);
  const requestId = await createRequest(customer, category, values);

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

  return { customer, admin, provider, providerAccount, requestId, offerId };
}

test.describe('customer panel', () => {
  test('sidebar counters survive moving between panel routes', async ({ browser }) => {
    const { customer, admin, provider, requestId } = await requestWithOneOffer(browser);

    const requestsCount = customer.page.getByTestId('cdash-nav-count-requests');
    const offersCount = customer.page.getByTestId('cdash-nav-count-offers');
    const matchesCount = customer.page.getByTestId('cdash-nav-count-matches');

    try {
      await customer.gotoWeb('/requests/my');
      await expect(requestsCount).toHaveText('1');
      await expect(offersCount).toHaveText('1');
      await expect(matchesCount).toHaveText('0');

      // The other CTA in the panel. The counters used to be a prop only this
      // screen's route passed, so arriving here emptied all three.
      await customer.gotoWeb('/account/profile');
      await expect(customer.page.getByRole('heading', { name: 'Profil ve ayarlar' })).toBeVisible();
      await expect(requestsCount).toHaveText('1');
      await expect(offersCount).toHaveText('1');
      await expect(matchesCount).toHaveText('0');

      // And on a third route, reached from the profile screen's own link.
      await customer.page.getByRole('link', { name: 'Şifre değiştir' }).click();
      await expect(customer.page).toHaveURL(/\/account\/password$/);
      await expect(requestsCount).toHaveText('1');
      await expect(offersCount).toHaveText('1');

      // Zero is an answer and stays on screen: this customer has no matches.
      await expect(matchesCount).toHaveText('0');

      // A request detail route, which is neither of the two shapes above.
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(requestsCount).toHaveText('1');
      await expect(offersCount).toHaveText('1');
      await assertNoErrorScreen(customer.page);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });

  test('the Teklifler sidebar link opens the offers list, by click and by keyboard', async ({
    browser,
  }) => {
    const { customer, admin, provider, requestId, offerId } = await requestWithOneOffer(browser);

    try {
      await customer.gotoWeb('/requests/my');

      // Scoped to the sidebar: "Teklifleri gör" on a request card would
      // otherwise match the same substring.
      const sidebar = customer.page.getByRole('navigation', { name: 'Bölüm navigasyonu' });
      const offersLink = sidebar.getByRole('link', { name: 'Teklifler' });
      await expect(offersLink).toHaveAttribute('href', '/requests/offers');

      // The defect in one assertion: the link used to carry the href of the
      // page it was already on, so the URL after clicking was unchanged.
      const requestsLink = sidebar.getByRole('link', { name: 'Taleplerim' });
      const requestsHref = await requestsLink.getAttribute('href');
      expect(await offersLink.getAttribute('href')).not.toBe(requestsHref);

      await offersLink.click();
      await expect(customer.page).toHaveURL(/\/requests\/offers$/);
      await expect(customer.page.getByRole('heading', { name: 'Teklifler' })).toBeVisible();
      await assertNoErrorScreen(customer.page);

      // The list is the customer's real offers, and each row leads to the real
      // offer route — no invented screen, no query parameter.
      const offerLink = customer.page
        .getByTestId('customer-offer-list')
        .getByRole('link', { name: 'Teklifi gör' });
      await expect(offerLink).toHaveCount(1);
      await expect(offerLink).toHaveAttribute('href', `/requests/${requestId}/offers/${offerId}`);

      // The active state follows the route rather than staying on Taleplerim.
      await expect(
        customer.page
          .getByRole('navigation', { name: 'Bölüm navigasyonu' })
          .getByRole('link', { name: 'Teklifler' }),
      ).toHaveAttribute('aria-current', 'page');

      // Reachable without a mouse: focus the link and press Enter.
      await customer.gotoWeb('/requests/my');
      await customer.page
        .getByRole('navigation', { name: 'Bölüm navigasyonu' })
        .getByRole('link', { name: 'Teklifler' })
        .focus();
      await customer.page.keyboard.press('Enter');
      await expect(customer.page).toHaveURL(/\/requests\/offers$/);

      // Signed out, the route keeps the panel's existing auth behaviour.
      const stranger = await Actor.open(browser, 'stranger', primaryRuntime);
      try {
        await stranger.gotoWeb('/requests/offers');
        await expect(stranger.page).toHaveURL(/\/login\?redirectTo=/);
        expect(new URL(stranger.page.url()).searchParams.get('redirectTo')).toBe('/requests/offers');
      } finally {
        await stranger.close();
      }
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });

  test('an offer offers only the actions that decide something', async ({ browser }) => {
    const { customer, admin, provider, requestId, offerId } = await requestWithOneOffer(browser);

    try {
      await customer.gotoWeb(`/requests/${requestId}/offers/${offerId}`);
      await assertNoErrorScreen(customer.page);

      const actions = customer.page.getByTestId('offer-actions');
      await expect(actions).toBeVisible();
      await expect(actions.getByRole('button', { name: 'Kabul Et' })).toBeVisible();
      await expect(actions.getByRole('button', { name: 'Reddet' })).toBeVisible();
      await expect(actions.getByRole('button')).toHaveCount(2);

      // Gone entirely — not hidden, not disabled, and no leftover copy about it.
      await expect(customer.page.getByRole('button', { name: 'Kısa Listeye Al' })).toHaveCount(0);
      expect(await customer.page.locator('body').innerText()).not.toContain('Kısa Listeye');

      // Accepting still works and still closes the offer to further action.
      await acceptOffer(customer, requestId, offerId);
      await expect(customer.page.getByRole('heading', { name: 'Aksiyonlar' })).toHaveCount(0);
      await expect(customer.page.getByRole('button', { name: 'Kabul Et' })).toHaveCount(0);
      await expect(customer.page.getByRole('button', { name: 'Reddet' })).toHaveCount(0);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });
});

test.describe('provider request detail', () => {
  test('the quality breakdown is written in the provider’s language, not the API’s', async ({
    browser,
  }) => {
    const { customer, admin, provider, providerAccount, requestId } =
      await requestWithOneOffer(browser);

    try {
      await provider.gotoWeb(`/providers/${providerAccount.id}/requests/${requestId}`);
      await expect(provider.page.getByRole('heading', { name: 'Kalite kırılımı' })).toBeVisible();

      const table = provider.page.locator('.pdash-table-card', {
        has: provider.page.getByRole('heading', { name: 'Kalite kırılımı' }),
      });
      const componentNames = await table.locator('tbody tr td:first-child').allTextContents();
      expect(componentNames.length).toBeGreaterThan(0);

      // Not one of the API's field names reaches the screen.
      for (const key of [
        'namePresent',
        'phonePresent',
        'budgetPresent',
        'urgencyPresent',
        'cityDistrictPresent',
        'descriptionDetailed',
        'preferredDatePresent',
        'locationDetailPresent',
        'requiredAnswersComplete',
        'optionalAnswersCompleted',
      ]) {
        expect(componentNames).not.toContain(key);
      }

      // And what is there is the wording the product uses.
      expect(componentNames).toContain('Ad soyad bilgisi');
      expect(componentNames).toContain('İl ve ilçe bilgisi');
      expect(componentNames).toContain('İsteğe bağlı kategori soruları');

      // The numbers beside them are still the server's, untouched.
      const points = await table.locator('tbody tr td:nth-child(2)').allTextContents();
      expect(points.length).toBe(componentNames.length);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });
});
