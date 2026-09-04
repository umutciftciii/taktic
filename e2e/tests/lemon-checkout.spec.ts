import { expect, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { emailCountFor } from '../src/outbox';
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
  itemPrice?: number;
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
        // Two kuruş above the line item, the way a real order comes back: the
        // provider derives this figure from a USD-rounded value, so it drifts
        // in a store held in any other currency. What settles the purchase is
        // the line item's own price.
        total: overrides.total ?? PRICE_AMOUNT + 2,
        currency: 'TRY',
        first_order_item: {
          variant_id: Number(E2E_LEMON_VARIANT_ID),
          price: overrides.itemPrice ?? PRICE_AMOUNT,
          quantity: 1,
        },
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
      // Nothing has settled, so there is nothing to send a receipt about.
      expect(emailCountFor(seeded.email, 'package-purchase-confirmation')).toBe(0);
      // And no invoice was ever promised on the way here either.
      await expect(provider.page.getByTestId('purchase-notice')).not.toContainText('fatura');

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

      // A refusal this deployment caused — the amount does not agree — settles
      // nothing, and does not close the event to a later delivery.
      const refused = await deliverWebhook(reference, { itemPrice: PRICE_AMOUNT - 100 });
      expect(refused.status).toBe(200);
      expect(await refused.json()).toEqual({ status: 'mismatched' });
      expect(await creditBalance(seeded.id)).toBe(0);

      // The genuine one: the same event, keyed the same way, now agreeing. This
      // is how a deployment recovers from its own refusal.
      const settled = await deliverWebhook(reference);
      expect(settled.status).toBe(200);
      expect(await settled.json()).toEqual({ status: 'processed' });

      // Redelivered, as a real provider retries.
      const redelivered = await deliverWebhook(reference);
      expect(redelivered.status).toBe(200);
      expect(await redelivered.json()).toEqual({ status: 'duplicate' });

      // One row for the one event, carrying both ends of its history.
      const audit = await prisma().paymentWebhookEvent.findFirstOrThrow({
        where: { eventName: 'order_created', eventKey: { contains: ':orders:e2e-order-' } },
      });
      expect(audit.status).toBe('PROCESSED');
      expect(audit.firstFailureCode).toBe('AMOUNT_MISMATCH');
      expect(audit.resolvedAt).not.toBeNull();
      expect(audit.attemptCount).toBe(3);

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

      /*
       * The notice on a settled purchase.
       *
       * It used to promise an e-fatura. There is no invoicing integration of
       * any kind behind this screen, so the sentence described a document that
       * was never produced and never sent. What the platform really does is
       * send the receipt asserted below — and the wording says so without
       * promising the send succeeded, because it can fail and the credits are
       * loaded either way.
       */
      const settledNotice = provider.page.getByTestId('purchase-notice');
      await expect(settledNotice).toContainText('onay e-postası');
      await expect(settledNotice).toContainText('kredi geçmişinizden');
      await expect(settledNotice).not.toContainText('fatura');

      // Exactly one receipt, for the three deliveries above: the redelivered
      // event settled nothing, and the dedupe key would have refused a second
      // message even if it had.
      await expect
        .poll(() => emailCountFor(seeded.email, 'package-purchase-confirmation'), {
          message: 'no purchase receipt was recorded for the buying provider',
          timeout: 20_000,
          intervals: [100, 200, 500],
        })
        .toBe(1);

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
