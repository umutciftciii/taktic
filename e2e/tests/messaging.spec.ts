import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
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
import { contactSharingRuntime, primaryRuntime } from '../src/runtime';

/**
 * Scenario 9 — messaging after a match.
 *
 * The journey end to end: a customer posts a request, an admin approves it, two
 * providers offer, the customer accepts one with the disclosure ticked, and the
 * two matched people find each other's conversation from their own panels and
 * talk. Everything is driven through real screens — the thread is opened from
 * the CTA a person would click, the messages are typed into the composer, and
 * the badges are read off the sidebar.
 *
 * Messaging follows contact sharing, so the whole journey runs on the
 * contact-sharing stack. The primary stack — the shipped default, with sharing
 * off — is where the other half of the claim is checked: no reveal, no
 * conversation, and the screen says so instead of rendering an empty one.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;

/** The sidebar number for one nav entry, as the panel actually renders it. */
async function customerUnreadBadge(actor: Actor): Promise<string> {
  return (await actor.page.getByTestId('cdash-nav-count-messages').innerText()).trim();
}

test.describe('post-match messaging', () => {
  test('the two matched parties find each other and talk; nobody else can', async ({
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
    const loserAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });

    const customer = await Actor.open(browser, 'customer', contactSharingRuntime);
    const admin = await Actor.open(browser, 'admin', contactSharingRuntime);
    const winner = await Actor.open(browser, 'winning-provider', contactSharingRuntime);
    const loser = await Actor.open(browser, 'losing-provider', contactSharingRuntime);

    try {
      // ---- a match, built the way the product builds one ------------------
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const values = requestFormValues(location, customerAccount.name);
      const requestId = await createRequest(customer, category, values);

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);

      await winner.loginToWeb(winnerAccount.email, winnerAccount.password);
      await loser.loginToWeb(loserAccount.email, loserAccount.password);
      await submitOffer(winner, {
        providerId: winnerAccount.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1500.00',
        message: 'Montaj ve ilk bakım dahil.',
      });
      await submitOffer(loser, {
        providerId: loserAccount.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1800.00',
        message: 'Aynı gün montaj yapabiliriz.',
      });

      const winningOfferId = await readProviderOfferId(winner, winnerAccount.id, requestId);
      const losingOfferId = await readProviderOfferId(loser, loserAccount.id, requestId);

      // ---- before the acceptance there is nothing to talk about -----------
      await customer.gotoWeb('/mesajlar');
      await expect(customer.page.getByTestId('thread-list-empty')).toBeVisible();
      await expect(customer.page.getByTestId('cdash-nav-count-messages')).toHaveText('0');
      await assertNoErrorScreen(customer.page);

      await acceptOffer(customer, requestId, winningOfferId);

      // ---- the customer opens the conversation from the match screen ------
      await customer.gotoWeb('/requests/matches');
      const messageCta = customer.page.getByTestId('match-message-cta').first();
      await expect(messageCta).toBeVisible();
      await messageCta.click();

      // The CTA names the request; the application resolves it to the one
      // conversation this match is allowed to have.
      await expect(customer.page).toHaveURL(/\/mesajlar\/[^/]+$/);
      await assertNoErrorScreen(customer.page);
      const threadUrl = customer.page.url();
      const threadId = threadUrl.split('/').pop() as string;

      await expect(customer.page.getByTestId('thread-title')).toHaveText(
        winnerAccount.businessName,
      );
      await expect(customer.page.getByTestId('message-list-empty')).toBeVisible();

      // Exactly one thread exists for this match, and it names the winner.
      const threads = await prisma().messageThread.findMany({ where: { requestId } });
      expect(threads).toHaveLength(1);
      expect(threads[0]!.offerId).toBe(winningOfferId);
      expect(threads[0]!.providerId).toBe(winnerAccount.id);
      expect(threads[0]!.customerUserId).toBe(customerAccount.id);

      // ---- the customer writes --------------------------------------------
      await customer.page.getByTestId('message-input').fill('Merhaba, salı günü uygun musunuz?');
      await customer.page.getByTestId('message-send').click();
      await expect(customer.page.getByTestId('message-item')).toHaveCount(1);
      await expect(customer.page.getByTestId('message-item').first()).toContainText(
        'salı günü uygun musunuz?',
      );
      await assertNoErrorScreen(customer.page);

      // Their own message is not unread to them.
      await customer.gotoWeb('/mesajlar');
      await expect(customer.page.getByTestId('cdash-nav-count-messages')).toHaveText('0');

      // ---- the provider is told, in the sidebar ---------------------------
      await winner.gotoWeb('/mesajlar');
      await expect(winner.page.getByTestId('thread-unread')).toHaveText('1');
      await expect(winner.page.getByTestId('thread-counterpart')).toHaveText(
        customerAccount.name,
      );
      await assertNoErrorScreen(winner.page);

      // ---- and replies -----------------------------------------------------
      await winner.page.getByTestId('thread-list').getByRole('link').first().click();
      await expect(winner.page.getByTestId('message-item')).toHaveCount(1);
      await winner.page.getByTestId('message-input').fill('Merhaba, salı 14:00 uygun.');
      await winner.page.getByTestId('message-send').click();
      await expect(winner.page.getByTestId('message-item')).toHaveCount(2);

      // Opening the thread is reading it, so the badge is gone.
      await winner.gotoWeb('/mesajlar');
      await expect(winner.page.getByTestId('thread-unread')).toHaveCount(0);

      // ---- the customer sees the reply and the read receipt ---------------
      await customer.gotoWeb('/mesajlar');
      await expect(customer.page.getByTestId('thread-unread')).toHaveText('1');
      expect(await customerUnreadBadge(customer)).toBe('1');

      await customer.page.goto(threadUrl, { waitUntil: 'domcontentloaded' });
      await expect(customer.page.getByTestId('message-item')).toHaveCount(2);
      await expect(customer.page.getByTestId('message-item').nth(1)).toContainText(
        'salı 14:00 uygun',
      );
      // Each message is attributed to a side, and the customer's own is theirs.
      await expect(customer.page.getByTestId('message-item').first()).toHaveAttribute(
        'data-sender',
        'self',
      );
      await expect(customer.page.getByTestId('message-item').nth(1)).toHaveAttribute(
        'data-sender',
        'counterpart',
      );
      await assertNoErrorScreen(customer.page);

      // Opening the thread is what read it, and the server recorded that while
      // rendering the page — so the badge is already clear by the time the
      // inbox is asked, with no timer and no second visit involved.
      await customer.gotoWeb('/mesajlar');
      expect(await customerUnreadBadge(customer)).toBe('0');

      // ---- the losing provider has no conversation and cannot reach one ---
      await loser.gotoWeb('/mesajlar');
      await expect(loser.page.getByTestId('thread-list-empty')).toBeVisible();
      await assertNoErrorScreen(loser.page);

      // Not through the match…
      await loser.gotoWeb(`/mesajlar/talep/${requestId}`);
      await expectNotFoundScreen(loser.page);

      // …and not by naming the thread the winner is using. The id is not what
      // authorises, so knowing it buys nothing.
      await loser.gotoWeb(`/mesajlar/${threadId}`);
      await expectNotFoundScreen(loser.page);

      // Nothing that was said leaked onto the losing provider's own screens.
      await loser.gotoWeb(`/providers/${loserAccount.id}/offers/${losingOfferId}`);
      const loserBody = await loser.page.locator('body').innerText();
      expect(loserBody).not.toContain('salı 14:00 uygun');
      expect(loserBody).not.toContain(values.customerPhone);
      await expect(loser.page.getByTestId('offer-message-cta')).toHaveCount(0);

      // ---- a second customer cannot reach it either -----------------------
      const outsiderAccount = await createCustomer('E2E Yabancı');
      const outsider = await Actor.open(browser, 'outsider', contactSharingRuntime);
      try {
        await outsider.loginToWeb(outsiderAccount.email, outsiderAccount.password);
        await outsider.gotoWeb(`/mesajlar/${threadId}`);
        await expectNotFoundScreen(outsider.page);

        await outsider.gotoWeb('/mesajlar');
        await expect(outsider.page.getByTestId('thread-list-empty')).toBeVisible();
      } finally {
        await outsider.close();
      }

      // ---- and an anonymous visitor is sent to sign in --------------------
      //
      // Checked at the HTTP level, not only by where the browser ends up. Both
      // used to end up at /login, but the messaging routes got there the wrong
      // way: a `loading.tsx` opened a Suspense boundary above the page's own
      // sign-in check, so the server committed a 200 and streamed the
      // "Mesajlar yükleniyor" skeleton to a stranger before redirecting from
      // inside the markup. The status code is the part that says the request
      // was refused rather than served, so that is what is asserted.
      const anonymous = await Actor.open(browser, 'anonymous', contactSharingRuntime);
      try {
        for (const path of ['/mesajlar', `/mesajlar/${threadId}`, `/mesajlar/talep/${requestId}`]) {
          const response = await anonymous.page.request.get(anonymous.webUrl(path), {
            maxRedirects: 0,
          });

          expect(response.status(), `${path} must refuse an anonymous request`).toBe(307);
          expect(response.headers()['location']).toBe(
            `/login?redirectTo=${path}`,
          );

          // Nothing of the signed-in screen — not even its skeleton — was sent.
          const body = await response.text();
          expect(body).not.toContain('Mesajlar yükleniyor');
          expect(body).not.toContain('Konuşma yükleniyor');
          expect(body).not.toContain('http-equiv="refresh"');
        }

        // And the browser really does land on the sign-in form.
        await anonymous.gotoWeb(`/mesajlar/${threadId}`);
        await expect(anonymous.page).toHaveURL(/\/login/);

        await anonymous.gotoWeb('/mesajlar');
        await expect(anonymous.page).toHaveURL(/\/login/);
      } finally {
        await anonymous.close();
      }

      // ---- the admin panel does not show what was said --------------------
      await admin.gotoAdmin(`/requests/${requestId}`);
      const adminBody = await admin.page.locator('body').innerText();
      expect(adminBody).not.toContain('salı günü uygun musunuz');
      expect(adminBody).not.toContain('salı 14:00 uygun');
      await assertNoErrorScreen(admin.page);
    } finally {
      await Promise.all([customer.close(), admin.close(), winner.close(), loser.close()]);
    }
  });

  test('a message body is shown as text, never rendered as markup', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });

    const customer = await Actor.open(browser, 'customer', contactSharingRuntime);
    const admin = await Actor.open(browser, 'admin', contactSharingRuntime);
    const provider = await Actor.open(browser, 'provider', contactSharingRuntime);

    // Anything the page executed would call this. Registered before the first
    // navigation so it is in place for every document the actor loads.
    const executed: string[] = [];
    await provider.page.exposeFunction('__e2eScriptRan', (marker: string) => {
      executed.push(marker);
    });

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
        priceAmount: '900.00',
        message: 'Hemen başlayabiliriz.',
      });
      const offerId = await readProviderOfferId(provider, providerAccount.id, requestId);
      await acceptOffer(customer, requestId, offerId);

      const payload =
        '<img src=x onerror="window.__e2eScriptRan(\'img\')"><script>window.__e2eScriptRan("script")</script>';

      await customer.gotoWeb(`/mesajlar/talep/${requestId}`);
      await customer.page.getByTestId('message-input').fill(payload);
      await customer.page.getByTestId('message-send').click();
      await expect(customer.page.getByTestId('message-item')).toHaveCount(1);

      // The provider reads it. The body is on screen as the characters that
      // were typed — no element was created from it, and nothing ran.
      await provider.gotoWeb(`/mesajlar/talep/${requestId}`);
      const message = provider.page.getByTestId('message-item').first();
      await expect(message).toBeVisible();
      await expect(message).toContainText('onerror');
      await expect(message.locator('img')).toHaveCount(0);
      await expect(message.locator('script')).toHaveCount(0);

      // Give anything that was going to fire a moment to do so.
      await provider.page.waitForTimeout(1_000);
      expect(executed, 'nothing in a message body may execute').toEqual([]);
      await assertNoErrorScreen(provider.page);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });

  test('a double-submitted message lands once', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });

    const customer = await Actor.open(browser, 'customer', contactSharingRuntime);
    const admin = await Actor.open(browser, 'admin', contactSharingRuntime);
    const provider = await Actor.open(browser, 'provider', contactSharingRuntime);

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
        priceAmount: '900.00',
        message: 'Hemen başlayabiliriz.',
      });
      const offerId = await readProviderOfferId(provider, providerAccount.id, requestId);
      await acceptOffer(customer, requestId, offerId);

      await customer.gotoWeb(`/mesajlar/talep/${requestId}`);
      // The CTA names the request; the redirect is what turns it into the
      // thread. Waiting for it is what makes the id below the right one.
      await expect(customer.page).toHaveURL(/\/mesajlar\/[^/]+$/);
      const threadId = customer.page.url().split('/').pop() as string;

      // The composer submitted twice with the same idempotency key: the second
      // click of an impatient double-click, or a submission the browser
      // retried. The key is read out of the form the page actually rendered, so
      // this is the value a real second submit would carry.
      const body = 'Ödeme detayını konuşabilir miyiz?';
      const token = await customer.page.locator('input[name="clientToken"]').inputValue();
      expect(token, 'the composer must carry an idempotency key').toBeTruthy();

      // The API sits on its own port, and Playwright's request context does not
      // reuse the page's cookie jar across it — so the session cookie is
      // attached by hand. It is the browser's real cookie, read back out of the
      // context that logged in.
      const sessionCookie = (await customer.context.cookies()).find(
        (cookie) => cookie.name === 'taktic_session',
      );
      expect(sessionCookie, 'the customer must be holding a session cookie').toBeTruthy();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await customer.page.request.post(
          `${contactSharingRuntime.apiUrl}/messages/threads/${threadId}/messages`,
          {
            headers: {
              'content-type': 'application/json',
              cookie: `${sessionCookie!.name}=${sessionCookie!.value}`,
            },
            data: { body, clientToken: token },
          },
        );
        expect(response.status()).toBe(201);
      }

      const stored = await prisma().message.findMany({ where: { threadId } });
      expect(stored, 'the same key must not produce a second message').toHaveLength(1);

      await customer.page.reload({ waitUntil: 'domcontentloaded' });
      await expect(customer.page.getByTestId('message-item')).toHaveCount(1);
      await assertNoErrorScreen(customer.page);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });

  test('with contact sharing off, no conversation opens and the screen says why', async ({
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

    // The primary stack: the shipped default, with contact sharing off.
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
        priceAmount: '1100.00',
        message: 'Bu hafta uygunuz.',
      });
      const offerId = await readProviderOfferId(provider, providerAccount.id, requestId);

      // The match completes exactly as it always did — messaging changes
      // nothing about accepting an offer.
      await acceptOffer(customer, requestId, offerId);
      expect(await prisma().contactRevealEvent.count({ where: { requestId } })).toBe(0);

      // And no conversation exists, on either side.
      await customer.gotoWeb(`/mesajlar/talep/${requestId}`);
      await expect(customer.page.getByTestId('thread-unavailable')).toBeVisible();
      await assertNoErrorScreen(customer.page);

      await provider.gotoWeb(`/mesajlar/talep/${requestId}`);
      await expect(provider.page.getByTestId('thread-unavailable')).toBeVisible();
      await assertNoErrorScreen(provider.page);

      expect(await prisma().messageThread.count({ where: { requestId } })).toBe(0);

      // The sidebar entry is still there and still honest: it opens an empty
      // inbox rather than promising something that is not available.
      await customer.gotoWeb('/mesajlar');
      await expect(customer.page.getByTestId('thread-list-empty')).toBeVisible();
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });
});
