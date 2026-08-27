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
 * What the provider that won a job can read about it, on the offer it won.
 *
 * The brief — the customer's description, and the location and timing the offer
 * was priced against — used to be reachable only from the discovery screen,
 * which stops answering once the request leaves APPROVED. So accepting an offer
 * took the brief away from the one provider who then had to act on it. It is on
 * the offer now, served by the API only for an offer it itself sees as
 * ACCEPTED.
 *
 * The two cases that matter most are the ones that must stay closed: the rival
 * whose offer the acceptance rejected, and — with contact sharing off on this
 * stack — anything that would say who the customer is or where exactly they
 * are. `apps/api/test/provider-work-scope.spec.ts` covers the payload itself;
 * this covers the screens.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;

test.describe('accepted offer work scope', () => {
  test('the winner reads the brief, the rival reads nothing, and no contact detail appears', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const winnerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });
    const rivalAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const winner = await Actor.open(browser, 'winning-provider', primaryRuntime);
    const rival = await Actor.open(browser, 'losing-provider', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const values = requestFormValues(location, customerAccount.name);
      const requestId = await createRequest(customer, category, values);

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);

      await winner.loginToWeb(winnerAccount.email, winnerAccount.password);
      await rival.loginToWeb(rivalAccount.email, rivalAccount.password);

      for (const [actor, account, price] of [
        [winner, winnerAccount, '2200.00'],
        [rival, rivalAccount, '2400.00'],
      ] as const) {
        await submitOffer(actor, {
          providerId: account.id,
          requestId,
          expectedCreditCost: CATEGORY_COST,
          priceAmount: price,
          message: 'Klimanızdaki sorunu aynı gün giderebiliriz.',
        });
      }

      const winningOfferId = await readProviderOfferId(winner, winnerAccount.id, requestId);
      const losingOfferId = await readProviderOfferId(rival, rivalAccount.id, requestId);

      // ---- before acceptance nobody has a brief on their offer -----------
      await winner.gotoWeb(`/providers/${winnerAccount.id}/offers/${winningOfferId}`);
      await expect(winner.page.getByTestId('work-scope')).toHaveCount(0);

      // ---- the customer accepts one --------------------------------------
      await acceptOffer(customer, requestId, winningOfferId);

      // ---- the winner reads the brief on the offer it won -----------------
      await winner.gotoWeb(`/providers/${winnerAccount.id}/offers/${winningOfferId}`);
      await assertNoErrorScreen(winner.page);

      const scope = winner.page.getByTestId('work-scope');
      await expect(scope).toBeVisible();
      await expect(winner.page.getByTestId('work-scope-description')).toHaveText(
        values.description,
      );
      await expect(winner.page.getByTestId('work-scope-location')).toHaveText(
        `${values.city}/${values.district}`,
      );

      // The dead discovery link is still gone, and its stand-in note is not
      // needed here: the brief itself is what the provider came for.
      await expect(winner.page.getByTestId('request-detail-link')).toHaveCount(0);
      await expect(winner.page.getByTestId('request-detail-closed')).toHaveCount(0);

      // ---- nothing about who the customer is, anywhere on the page --------
      const winnerBody = await winner.page.locator('body').innerText();
      for (const secret of [values.customerPhone, values.customerEmail, values.customerName]) {
        expect(winnerBody, `the offer screen must not carry "${secret}"`).not.toContain(secret);
      }
      // Contact sharing is off on this stack, so the reveal section is absent
      // too — the brief did not become a way around the flag.
      await expect(winner.page.getByTestId('matched-contact')).toHaveCount(0);

      // ---- the rival is told the outcome and nothing more ------------------
      await rival.gotoWeb(`/providers/${rivalAccount.id}/offers/${losingOfferId}`);
      await assertNoErrorScreen(rival.page);

      await expect(rival.page.getByTestId('offer-status')).toHaveText('Teklifiniz kabul edilmedi');
      await expect(rival.page.getByTestId('work-scope')).toHaveCount(0);

      const rivalBody = await rival.page.locator('body').innerText();
      expect(rivalBody).not.toContain(values.description);
      expect(rivalBody).not.toContain(winnerAccount.businessName);
      // The request closed, so the rival gets the existing explanation instead.
      await expect(rival.page.getByTestId('request-detail-closed')).toBeVisible();
    } finally {
      await Promise.all([customer.close(), admin.close(), winner.close(), rival.close()]);
    }
  });
});
