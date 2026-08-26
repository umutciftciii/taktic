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
  readProviderOfferId,
  submitOffer,
} from '../src/journeys';
import { primaryRuntime } from '../src/runtime';

/**
 * Scenario 4 — a provider takes its own offer back.
 *
 * The integration suite proves the rule; this proves the product. Two things
 * only a browser can show: that the confirmation really states the three
 * consequences before the action exists, and that the customer's screen stops
 * counting the offer as one they could take — while the request itself carries
 * on and can still be matched to whoever is left.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;

test.describe('offer withdrawal', () => {
  test('the provider withdraws, the customer stops seeing a live offer', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const leavingProvider = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });
    const stayingProvider = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const leaving = await Actor.open(browser, 'leaving-provider', primaryRuntime);
    const staying = await Actor.open(browser, 'staying-provider', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const values = requestFormValues(location, customerAccount.name);
      const requestId = await createRequest(customer, category, values);

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);

      await leaving.loginToWeb(leavingProvider.email, leavingProvider.password);
      await staying.loginToWeb(stayingProvider.email, stayingProvider.password);

      await submitOffer(leaving, {
        providerId: leavingProvider.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1400.00',
        message: 'Bu hafta içinde başlayabiliriz.',
      });
      await submitOffer(staying, {
        providerId: stayingProvider.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1650.00',
        message: 'Montaj ve bakım dahil.',
      });

      const withdrawnOfferId = await readProviderOfferId(leaving, leavingProvider.id, requestId);
      const survivingOfferId = await readProviderOfferId(staying, stayingProvider.id, requestId);

      // ---- the customer starts with two comparable offers -----------------
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByRole('link', { name: 'Teklifi İncele' })).toHaveCount(2);

      // ---- the provider confirms, with the consequences on screen ---------
      await leaving.gotoWeb(`/providers/${leavingProvider.id}/offers/${withdrawnOfferId}`);
      await leaving.page.getByTestId('withdraw-open').click();
      await expect(leaving.page.getByText('Teklifiniz geri çekilecek.')).toBeVisible();
      await expect(leaving.page.getByText('Bu işlem geri alınamaz.')).toBeVisible();
      await expect(leaving.page.getByText('Kredi iadesi yapılmaz.')).toBeVisible();

      await leaving.page.getByTestId('withdraw-confirm').click();

      // In place first — navigating away would cancel the action mid-flight.
      await expect(leaving.page.getByTestId('offer-status')).toHaveText('Geri çekildi');
      await assertNoErrorScreen(leaving.page);

      await leaving.gotoWeb(`/providers/${leavingProvider.id}/offers/${withdrawnOfferId}`);
      await expect(leaving.page.getByTestId('offer-status')).toHaveText('Geri çekildi');
      // The action is gone: there is nothing left to withdraw twice.
      await expect(leaving.page.getByTestId('withdraw-open')).toHaveCount(0);

      const storedOffer = await prisma().offer.findUniqueOrThrow({
        where: { id: withdrawnOfferId },
      });
      expect(storedOffer.status).toBe('WITHDRAWN');
      expect(storedOffer.withdrawnAt).not.toBeNull();

      // ---- withdrawing bought nothing back --------------------------------
      expect(await countRefundTransactions(leavingProvider.id)).toBe(0);
      expect(await creditBalance(leavingProvider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);

      // ---- the customer counts one live offer, not two --------------------
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByRole('link', { name: 'Teklifi İncele' })).toHaveCount(1);
      await expect(customer.page.getByTestId('withdrawn-offers')).toContainText(
        'Teklif geri çekildi',
      );
      // Neutral history, not a comparable price: the withdrawn amount is gone
      // from the screen entirely.
      const offersBody = await customer.page.locator('body').innerText();
      expect(offersBody).not.toContain('1.400,00');
      await assertNoErrorScreen(customer.page);

      await customer.gotoWeb('/requests/my');
      await expect(
        customer.page
          .locator(`[data-testid="request-card"][data-request-id="${requestId}"]`)
          .getByTestId('request-offers-count'),
      ).toHaveText('1');

      // ---- and the request itself carries on ------------------------------
      await acceptOffer(customer, requestId, survivingOfferId);
      const matched = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(matched.status).toBe('MATCHED');
      expect(matched.matchedOfferId).toBe(survivingOfferId);

      // The withdrawal survived the match untouched — no competitor rejection
      // was written over it, and still no refund anywhere.
      const afterMatch = await prisma().offer.findUniqueOrThrow({
        where: { id: withdrawnOfferId },
      });
      expect(afterMatch.status).toBe('WITHDRAWN');
      expect(afterMatch.rejectionReason).toBeNull();
      expect(await countRefundTransactions()).toBe(0);
    } finally {
      await Promise.all([customer.close(), admin.close(), leaving.close(), staying.close()]);
    }
  });
});
