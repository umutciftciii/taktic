import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  creditBalance,
  isAutoPublishEnabled,
  prisma,
  requestFormValues,
  setAutoPublish,
  uniqueLocation,
  type UrgencyCode,
} from '../src/fixtures';
import {
  createRequest,
  enableAutoPublish,
  expectPublishedSuccess,
  matchingRequestIds,
  submitOffer,
} from '../src/journeys';
import { primaryRuntime } from '../src/runtime';

/**
 * Instant publish — the operations switch that takes the operator out of the
 * loop.
 *
 * With the switch on, a marketplace request is born APPROVED: the customer is
 * told providers have it, and a matching provider finds it and offers on it
 * with nobody touching the admin app in between. The API suite proves the
 * rule; this proves the product says so on the success page and that the
 * provider's list, the offer form and the customer's offer screen all agree
 * without an approval step.
 *
 * The switch is one row shared by every runtime in this run, and every other
 * spec depends on it being OFF (they approve by hand). Each test here turns it
 * on through the admin screen — that is the feature — and `afterEach` puts it
 * back directly, so a failure halfway cannot leak into the next spec.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;

test.describe('request auto-publish', () => {
  test.afterEach(async () => {
    await setAutoPublish(false);
  });

  for (const variant of [
    { name: 'without a stated urgency', urgency: undefined },
    // The most urgent option the form offers. The product has no separate
    // "urgent" lane: urgency is a label the provider reads, and a request that
    // states one is published exactly like one that does not.
    { name: 'with the "Bugün" urgency', urgency: 'TODAY' as UrgencyCode },
  ]) {
    test(`a request ${variant.name} reaches providers with no operator step`, async ({
      browser,
    }) => {
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
        // ---- the operator turns the switch on, once ----------------------
        expect(await isAutoPublishEnabled()).toBe(false);
        await admin.loginToAdmin(adminAccount.email, adminAccount.password);
        await enableAutoPublish(admin);
        expect(await isAutoPublishEnabled()).toBe(true);

        // ---- the customer sends a request and is told it is live ---------
        await customer.loginToWeb(customerAccount.email, customerAccount.password);
        const values = requestFormValues(location, customerAccount.name, {
          urgency: variant.urgency,
        });
        const requestId = await createRequest(customer, category, values);
        await expectPublishedSuccess(customer);

        const stored = await prisma().serviceRequest.findUniqueOrThrow({
          where: { id: requestId },
          select: { status: true, urgency: true },
        });
        expect(stored.status).toBe('APPROVED');
        expect(stored.urgency).toBe(variant.urgency ?? null);

        await customer.gotoWeb('/requests/my');
        await expect(
          customer.page
            .locator(`[data-testid="request-card"][data-request-id="${requestId}"]`)
            .getByTestId('request-status'),
        ).toHaveText('Onaylandı');

        // ---- the provider finds it without anyone approving it -----------
        // The admin actor never opens this request: the only admin action in
        // this test was the switch.
        await provider.loginToWeb(providerAccount.email, providerAccount.password);
        expect(await matchingRequestIds(provider, providerAccount.id)).toEqual([requestId]);

        await submitOffer(provider, {
          providerId: providerAccount.id,
          requestId,
          expectedCreditCost: CATEGORY_COST,
          priceAmount: '1500,00',
          message: 'Hemen başlayabiliriz.',
        });
        expect(await creditBalance(providerAccount.id)).toBe(STARTING_CREDITS - CATEGORY_COST);

        // ---- and the customer sees the offer on a live request -----------
        await customer.gotoWeb(`/requests/${requestId}/offers`);
        await expect(customer.page.getByTestId('request-status')).toHaveText('Onaylandı');
        await expect(customer.page.getByRole('link', { name: 'Teklifi İncele' })).toHaveCount(1);
        await assertNoErrorScreen(customer.page);
      } finally {
        await Promise.all([customer.close(), admin.close(), provider.close()]);
      }
    });
  }
});
