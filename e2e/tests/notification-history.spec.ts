import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  prisma,
  requestFormValues,
  uniqueLocation,
} from '../src/fixtures';
import { createRequest } from '../src/journeys';
import { waitForLatestSmsCode } from '../src/outbox';
import { primaryRuntime } from '../src/runtime';

/**
 * Scenario 5 — the delivery history, and what it must never show.
 *
 * The integration suite proves the payload's allow-list. This proves the claim
 * end to end, on a record produced by a real send: the browser reads the same
 * one-time code the application sent (from the test transport, the only place it
 * exists outside the SMS itself) and then asserts that neither the code nor the
 * customer's number appears anywhere on the admin screen that reports the send.
 */

const CATEGORY_COST = 2;

test.describe('notification delivery history', () => {
  test('the admin filters the history and sees no code or raw recipient', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const values = requestFormValues(location, customerAccount.name);
      const requestId = await createRequest(customer, category, values);

      // ---- a real send, through the real screen -------------------------
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await customer.page.getByRole('button', { name: 'Doğrulama kodu gönder' }).click();
      await expect(customer.page).toHaveURL(/verification=ok/);

      const code = await waitForLatestSmsCode(values.customerPhone);

      // A failed attempt on the same request, so the FAILED badge and its safe
      // label have something to render. Written directly: making a live
      // transport fail mid-suite would need a third runtime with a broken
      // adapter, and this screen is what is under test, not the dispatcher.
      await prisma().notificationLog.create({
        data: {
          channel: 'SMS',
          template: 'phone-verification-code',
          maskedRecipient: '+90 ******* 00',
          status: 'FAILED',
          errorCode: 'TRANSPORT_UNAVAILABLE',
          requestId,
          failedAt: new Date(),
        },
      });

      // ---- the admin reads the history ----------------------------------
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/notifications?requestId=${requestId}`);
      await expect(admin.page.getByRole('heading', { name: 'Bildirim Geçmişi' })).toBeVisible();
      // Three sends belong to this request: the receipt mailed when it was
      // submitted, the verification code the screen above asked for, and the
      // failed attempt written just now.
      await expect(admin.page.getByTestId('notification-row')).toHaveCount(3);
      await assertNoErrorScreen(admin.page);

      await admin.gotoAdmin(`/notifications?requestId=${requestId}&channel=EMAIL`);
      const emailRows = admin.page.getByTestId('notification-row');
      await expect(emailRows).toHaveCount(1);
      await expect(emailRows.first()).toContainText('Talep alındı');

      await admin.gotoAdmin(`/notifications?requestId=${requestId}`);

      // ---- filters narrow it, through the URL ---------------------------
      await admin.gotoAdmin(`/notifications?requestId=${requestId}&status=FAILED`);
      await expect(admin.page.getByTestId('notification-row')).toHaveCount(1);
      // The failure reaches the operator as a class, never as provider text.
      await expect(admin.page.getByTestId('notification-error-label')).toHaveText(
        'Taşıma servisi kullanılamıyor',
      );

      await admin.gotoAdmin(`/notifications?requestId=${requestId}&status=SENT&channel=SMS`);
      const sentRows = admin.page.getByTestId('notification-row');
      await expect(sentRows).toHaveCount(1);
      await expect(sentRows.first()).toHaveAttribute('data-status', 'SENT');

      // ---- and it discloses nothing about the message -------------------
      const listBody = await admin.page.locator('body').innerText();
      expect(listBody).not.toContain(code);
      expect(listBody).not.toContain(values.customerPhone);
      expect(listBody).not.toContain(values.customerEmail);

      // ---- the same holds on the detail screen --------------------------
      await sentRows.first().getByRole('link', { name: 'Detay' }).click();
      await expect(admin.page.getByTestId('notification-masked-recipient')).toBeVisible();
      await assertNoErrorScreen(admin.page);

      const detailBody = await admin.page.locator('body').innerText();
      expect(detailBody).not.toContain(code);
      expect(detailBody).not.toContain(values.customerPhone);
      expect(detailBody).not.toContain(values.customerEmail);

      // A read-only screen: nothing here offers to send the message again.
      for (const forbidden of ['Yeniden gönder', 'Tekrar dene', 'Sil', 'Düzenle']) {
        await expect(admin.page.getByRole('button', { name: forbidden })).toHaveCount(0);
      }
    } finally {
      await Promise.all([customer.close(), admin.close()]);
    }
  });

  test('a customer and a provider cannot open the history', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: 5,
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      // Both hold a real session — cookies ignore ports, so each one arrives at
      // the admin app already signed in. What stops them is the role check, not
      // the absence of a cookie, which is exactly the case worth testing.
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await provider.loginToWeb(providerAccount.email, providerAccount.password);

      for (const actor of [customer, provider]) {
        await actor.gotoAdmin('/notifications');
        await expect(actor.page).toHaveURL(/\/login/);
        await expect(actor.page.getByTestId('notification-table')).toHaveCount(0);
        await assertNoErrorScreen(actor.page);
      }
    } finally {
      await Promise.all([customer.close(), provider.close()]);
    }
  });
});
