import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
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
  acceptOffer,
  approveRequest,
  createRequest,
  matchingRequestIds,
  readProviderOfferId,
  submitOffer,
} from '../src/journeys';
import { primaryRuntime } from '../src/runtime';

/**
 * Scenario 1 — the journey the marketplace exists for.
 *
 * A customer publishes a request, an admin approves it, two funded providers
 * compete, the customer picks one. Every step crosses an app boundary (web →
 * API, admin → API, web → API again) and a session boundary, which is the point:
 * the integration suite already proves each rule in isolation, and this proves
 * they survive real cookies, real server actions and real redirects.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;

test.describe('marketplace journey', () => {
  test('one request, two offers, exactly one winner', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const firstProvider = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });
    const secondProvider = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const winner = await Actor.open(browser, 'winning-provider', primaryRuntime);
    const loser = await Actor.open(browser, 'losing-provider', primaryRuntime);

    try {
      // ---- the customer publishes a request -----------------------------
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await expect(customer.page).toHaveURL(/\/requests\/my/);

      const values = requestFormValues(location, customerAccount.name);
      const requestId = await createRequest(customer, category, values);

      await customer.gotoWeb('/requests/my');
      const card = customer.page.locator(`[data-testid="request-card"][data-request-id="${requestId}"]`);
      await expect(card).toBeVisible();

      // ---- an admin approves it -----------------------------------------
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);

      // ---- both providers see it, priced by its category ----------------
      await winner.loginToWeb(firstProvider.email, firstProvider.password);
      await loser.loginToWeb(secondProvider.email, secondProvider.password);

      // The unique district means these lists can only hold this request.
      expect(await matchingRequestIds(winner, firstProvider.id)).toEqual([requestId]);
      expect(await matchingRequestIds(loser, secondProvider.id)).toEqual([requestId]);

      // The matching row quotes the category's own credit price, read from the
      // "Teklif kredisi" cell rather than from a sentence.
      await expect(winner.page.getByTestId('request-offer-credit-cost')).toHaveText(
        String(CATEGORY_COST),
      );

      // ---- both offer, and both are charged the category price ----------
      await submitOffer(winner, {
        providerId: firstProvider.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1500.00',
        message: 'Montaj ve ilk bakım dahil.',
      });
      await submitOffer(loser, {
        providerId: secondProvider.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1750.00',
        message: 'Aynı gün montaj yapabiliriz.',
      });

      expect(await creditBalance(firstProvider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
      expect(await creditBalance(secondProvider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);

      const winningOfferId = await readProviderOfferId(winner, firstProvider.id, requestId);
      const losingOfferId = await readProviderOfferId(loser, secondProvider.id, requestId);

      // ---- before anyone looks: the policy state the provider is shown ---
      await winner.gotoWeb(`/providers/${firstProvider.id}/offers/${winningOfferId}`);
      await expect(winner.page.getByTestId('offer-refund-policy-status')).toHaveText(
        'Görüntülenme bekleniyor',
      );
      await expect(winner.page.getByText('Teklifiniz müşteri tarafından 48 saat içinde görüntülenmezse krediniz otomatik olarak iade edilir.').first()).toBeVisible();
      // The old promises are gone from the screen, not merely joined by the new
      // one: a provider must not read two different refund rules on one page.
      const beforeViewBody = await winner.page.locator('body').innerText();
      expect(beforeViewBody).not.toContain('iade uygunluğu otomatik taranır');
      expect(beforeViewBody).not.toContain('Kredi iadesi yapılmaz');
      expect(beforeViewBody).not.toContain('Manuel inceleme');

      // ---- the customer sees both and accepts one -----------------------
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('request-status')).toHaveText('Onaylandı');
      await expect(
        customer.page.getByRole('link', { name: 'Teklifi İncele' }),
      ).toHaveCount(2);

      await acceptOffer(customer, requestId, winningOfferId);

      // ---- the request is matched, everywhere ---------------------------
      await customer.gotoWeb('/requests/my');
      await expect(
        customer.page
          .locator(`[data-testid="request-card"][data-request-id="${requestId}"]`)
          .getByTestId('request-status'),
      ).toHaveText('Eşleşti');

      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('request-status')).toHaveText('Eşleşti');

      // ---- the winner sees ACCEPTED, the loser sees REJECTED ------------
      await winner.gotoWeb(`/providers/${firstProvider.id}/offers/${winningOfferId}`);
      await expect(winner.page.getByTestId('offer-status')).toHaveText('Kabul edildi');
      // Opening the offer is what settled the credit, and the panel says so.
      await expect(winner.page.getByTestId('offer-refund-policy-status')).toHaveText(
        'Görüntülendi — iade uygun değil',
      );
      await assertNoErrorScreen(winner.page);

      await loser.gotoWeb(`/providers/${secondProvider.id}/offers/${losingOfferId}`);
      // The loser is told the outcome, not the reason: the product deliberately
      // never reveals that a rival was chosen, so the provider-facing label is
      // neutral even though the record underneath says REJECTED.
      await expect(loser.page.getByTestId('offer-status')).toHaveText('Teklifiniz kabul edilmedi');
      await assertNoErrorScreen(loser.page);

      const losingOffer = await prisma().offer.findUniqueOrThrow({ where: { id: losingOfferId } });
      expect(losingOffer.status).toBe('REJECTED');
      expect(losingOffer.rejectionReason).toBe('COMPETITOR_ACCEPTED');

      const loserBody = await loser.page.locator('body').innerText();
      expect(loserBody).not.toContain('COMPETITOR');
      expect(loserBody).not.toContain(firstProvider.businessName);

      // ---- a second acceptance is not offered and not possible ----------
      await customer.gotoWeb(`/requests/${requestId}/offers/${losingOfferId}`);
      await expect(customer.page.getByTestId('offer-status')).toHaveText('Reddedildi');
      // A closed offer exposes no action at all — there is nothing to click
      // twice, which is the UI half of "one winner per request".
      await expect(customer.page.getByRole('button', { name: 'Kabul Et' })).toHaveCount(0);
      await expect(customer.page.getByRole('heading', { name: 'Aksiyonlar' })).toHaveCount(0);

      const acceptedOffers = await prisma().offer.count({
        where: { requestId, status: 'ACCEPTED' },
      });
      expect(acceptedOffers).toBe(1);

      // ---- losing did not refund anything -------------------------------
      // Not because the offer lost — losing decides nothing — but because the
      // customer opened it. A read offer is settled, whatever it ended as.
      expect(await countRefundTransactions()).toBe(0);
      expect(await creditBalance(secondProvider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);

      // ---- no contact details leak in this phase ------------------------
      for (const [actor, url] of [
        [winner, `/providers/${firstProvider.id}/offers/${winningOfferId}`],
        [loser, `/providers/${secondProvider.id}/offers/${losingOfferId}`],
      ] as const) {
        await actor.gotoWeb(url);
        const body = await actor.page.locator('body').innerText();
        expect(body).not.toContain(values.customerPhone);
        expect(body).not.toContain(values.customerEmail);
      }

      // And the customer never learns how to reach the provider directly.
      await customer.gotoWeb(`/requests/${requestId}/offers/${winningOfferId}`);
      const customerBody = await customer.page.locator('body').innerText();
      expect(customerBody).not.toContain(firstProvider.email);
    } finally {
      await Promise.all([customer.close(), admin.close(), winner.close(), loser.close()]);
    }
  });

  test('the customer can close out a matched request', async ({ browser }) => {
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
      const values = requestFormValues(location, customerAccount.name);
      const requestId = await createRequest(customer, category, values);

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);

      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await submitOffer(provider, {
        providerId: providerAccount.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '990.50',
        message: 'Bugün başlayabiliriz.',
      });

      const offerId = await readProviderOfferId(provider, providerAccount.id, requestId);
      await acceptOffer(customer, requestId, offerId);

      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await customer.page.getByRole('button', { name: 'Hizmet tamamlandı' }).click();
      // Wait for the action's own re-render before leaving the page.
      await expect(customer.page.getByTestId('request-status')).toHaveText('Tamamlandı');

      await customer.gotoWeb('/requests/my');
      await expect(
        customer.page
          .locator(`[data-testid="request-card"][data-request-id="${requestId}"]`)
          .getByTestId('request-status'),
      ).toHaveText('Tamamlandı');
      await assertNoErrorScreen(customer.page);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });
});
