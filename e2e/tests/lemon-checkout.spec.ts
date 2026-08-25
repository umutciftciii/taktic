import { expect, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createCategory,
  createLemonSqueezyCreditPackage,
  createProvider,
  creditBalance,
  prisma,
  uniqueLocation,
} from '../src/fixtures';
import {
  E2E_LEMON_STORE_ID,
  E2E_LEMON_VARIANT_ID,
  E2E_LEMON_WEBHOOK_SECRET,
  lemonSqueezyRuntime,
} from '../src/runtime';

/**
 * Buying credits through a hosted, test-mode checkout, end to end.
 *
 * The whole point of the scenario is the boundary between the browser and the
 * money. The provider really does start a checkout, really is redirected to a
 * hosted page, and really comes back through the application's own return URL
 * — and after all of that the balance is still zero. It moves only when a
 * signed settlement notice arrives on the webhook endpoint, which is what the
 * payment provider would send and what this test sends in its place.
 *
 * Nothing here contacts Lemon Squeezy. The API process on this runtime is
 * pointed at the loopback stub in src/lemon-stub.ts, and the credentials are
 * placeholders that were never issued.
 */

const CREDIT_AMOUNT = 30;
const PRICE_AMOUNT = 49900;

type WebhookOverrides = {
  eventName?: string;
  orderId?: string;
  testMode?: boolean;
  total?: number;
  signature?: string;
};

/**
 * Posts a settlement notice the way the payment provider would: a JSON body
 * with an HMAC over exactly the bytes sent.
 */
async function deliverWebhook(reference: string, overrides: WebhookOverrides = {}) {
  const body = JSON.stringify({
    meta: {
      event_name: overrides.eventName ?? 'order_created',
      test_mode: overrides.testMode ?? true,
      custom_data: { purchase_reference: reference },
    },
    data: {
      type: 'orders',
      id: overrides.orderId ?? `e2e-order-${reference.slice(0, 8)}`,
      attributes: {
        store_id: Number(E2E_LEMON_STORE_ID),
        status: 'paid',
        total: overrides.total ?? PRICE_AMOUNT,
        currency: 'TRY',
        first_order_item: { variant_id: Number(E2E_LEMON_VARIANT_ID) },
      },
    },
  });

  const signature =
    overrides.signature ??
    createHmac('sha256', E2E_LEMON_WEBHOOK_SECRET).update(Buffer.from(body, 'utf8')).digest('hex');

  return fetch(`${lemonSqueezyRuntime.apiUrl}/payments/lemon-squeezy/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': signature },
    body,
  });
}

test.describe('test-mode credit package checkout', () => {
  test('a provider is only credited after a verified settlement notice', async ({ browser }) => {
    const category = await createCategory(3);
    const location = uniqueLocation();
    const seeded = await createProvider({ categoryId: category.id, location, credits: 0 });
    await createLemonSqueezyCreditPackage({
      creditAmount: CREDIT_AMOUNT,
      priceAmount: PRICE_AMOUNT,
    });

    const provider = await Actor.open(browser, 'provider', lemonSqueezyRuntime);

    try {
      await provider.loginToWeb(seeded.email, seeded.password);
      await provider.gotoWeb(`/providers/${seeded.id}/credits`);

      // The screen says what this is before anybody clicks anything.
      const notice = provider.page.getByTestId('payment-mode-notice');
      await expect(notice).toContainText('Test ödemesi');
      await expect(notice).toContainText('sandbox');
      await expect(notice).not.toContainText('gerçek tahsilat yapılır');

      expect(await creditBalance(seeded.id)).toBe(0);

      await provider.page.getByRole('button', { name: 'Test Ödemesiyle Paket Al' }).click();

      // The hosted page. Reaching it is what "the checkout was opened" means,
      // and it is served by the loopback stub, not by any payment provider.
      await expect(provider.page.getByTestId('stub-checkout')).toBeVisible();
      expect(new URL(provider.page.url()).hostname).toBe('127.0.0.1');

      const purchase = await prisma().packagePurchase.findFirstOrThrow({
        where: { providerId: seeded.id },
      });
      expect(purchase.status).toBe('PENDING');
      expect(purchase.paymentProvider).toBe('lemon-squeezy-test');
      expect(purchase.providerCheckoutUrl).not.toBeNull();
      expect(await creditBalance(seeded.id)).toBe(0);

      // Back through the application's own return URL. A navigation, and only a
      // navigation: the screen re-reads the canonical status and says so.
      await provider.page.getByTestId('stub-return').click();
      await expect(provider.page).toHaveURL(
        new RegExp(`/providers/${seeded.id}/package-purchases/${purchase.id}\\?checkout=return$`),
      );
      await assertNoErrorScreen(provider.page);

      await expect(provider.page.getByTestId('purchase-status')).toHaveText('Bekliyor');
      await expect(provider.page.getByTestId('checkout-outcome')).toContainText(
        'Ödeme doğrulanmayı bekliyor',
      );
      expect(await creditBalance(seeded.id)).toBe(0);

      // Reloading the return URL as often as you like changes nothing.
      await provider.page.reload();
      await expect(provider.page.getByTestId('purchase-status')).toHaveText('Bekliyor');
      expect(await creditBalance(seeded.id)).toBe(0);

      const reference = purchase.paymentReference as string;

      // An unsigned notice is refused and writes nothing.
      const forged = await deliverWebhook(reference, { signature: 'a'.repeat(64) });
      expect(forged.status).toBe(401);
      expect(await creditBalance(seeded.id)).toBe(0);

      // A live-mode notice is refused too: this build has no live mode.
      const live = await deliverWebhook(reference, { testMode: false, orderId: 'e2e-live-order' });
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: 'mismatched' });
      expect(await creditBalance(seeded.id)).toBe(0);

      // The genuine one.
      const settled = await deliverWebhook(reference);
      expect(settled.status).toBe(200);
      expect(await settled.json()).toEqual({ status: 'processed' });

      // Redelivered, as a real provider retries.
      const redelivered = await deliverWebhook(reference);
      expect(redelivered.status).toBe(200);
      expect(await redelivered.json()).toEqual({ status: 'duplicate' });

      expect(await creditBalance(seeded.id)).toBe(CREDIT_AMOUNT);
      expect(
        await prisma().providerCreditTransaction.count({
          where: { providerId: seeded.id, type: 'PACKAGE_PURCHASE' },
        }),
      ).toBe(1);

      // And the provider's own screens agree, having been told nothing by the
      // browser.
      await provider.page.reload();
      await expect(provider.page.getByTestId('purchase-status')).toHaveText('Ödendi');

      await provider.gotoWeb(`/providers/${seeded.id}/credits`);
      await expect(
        provider.page.getByText(String(CREDIT_AMOUNT), { exact: true }).first(),
      ).toBeVisible();
      await assertNoErrorScreen(provider.page);
    } finally {
      await provider.close();
    }
  });

  test('starting the same checkout twice reuses one purchase and one payment link', async ({
    browser,
  }) => {
    const category = await createCategory(3);
    const location = uniqueLocation();
    const seeded = await createProvider({ categoryId: category.id, location, credits: 0 });
    await createLemonSqueezyCreditPackage({
      creditAmount: CREDIT_AMOUNT,
      priceAmount: PRICE_AMOUNT,
    });

    const provider = await Actor.open(browser, 'provider', lemonSqueezyRuntime);

    try {
      await provider.loginToWeb(seeded.email, seeded.password);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await provider.gotoWeb(`/providers/${seeded.id}/credits`);
        await provider.page.getByRole('button', { name: 'Test Ödemesiyle Paket Al' }).click();
        await expect(provider.page.getByTestId('stub-checkout')).toBeVisible();
      }

      const purchases = await prisma().packagePurchase.findMany({
        where: { providerId: seeded.id },
      });
      expect(purchases).toHaveLength(1);
      expect(purchases[0]!.status).toBe('PENDING');
      expect(await creditBalance(seeded.id)).toBe(0);
    } finally {
      await provider.close();
    }
  });
});
