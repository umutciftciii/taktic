import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import { createAdmin, createCustomer, prisma } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * Customer support tickets, end to end.
 *
 * The journey a person actually takes: a customer finds Destek in their own
 * panel — a real link now, not a "yakında" placeholder — opens a ticket, sees
 * it in their list, reads the whole conversation; an operator finds it in the
 * admin queue, answers it, and walks it to resolved and then closed; and the
 * customer is then told, on the screen, that the ticket takes no more messages
 * and that a new one is the way forward.
 *
 * Everything is driven through real screens. The ticket is typed into the
 * composer a person would use, the status is moved with the button an operator
 * would click, and the refusals are read off the page rather than off a
 * response body — which is the only way to know the screens actually say them.
 */

const SUBJECT = 'Faturam elime ulaşmadı';
const FIRST_MESSAGE = 'Geçen haftaki talebim için fatura gelmedi, kontrol edebilir misiniz?';
const ADMIN_REPLY = 'Faturanızı yeniden gönderdik, birkaç dakika içinde ulaşacak.';
const CUSTOMER_REPLY = 'Teşekkürler, talep numaram TR-TEST-1.';

/** The widths the responsive brief names, down to the 320px floor. */
const MOBILE_WIDTHS = [320, 375] as const;

/**
 * Nothing may make the document wider than the window it is in. `scrollWidth`
 * on the documentElement is the whole page, so a card, a table or a grid track
 * that sticks out anywhere is caught here rather than only where somebody
 * thought to look.
 */
async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(
    overflow,
    `${label}: the page is ${overflow}px wider than the viewport`,
  ).toBeLessThanOrEqual(0);
}

test.describe('customer support tickets', () => {
  test('a customer opens a ticket, an operator answers and closes it, and the customer is told', async ({
    browser,
  }) => {
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);

      // ---- Destek is a real destination now -------------------------------
      await customer.gotoWeb('/requests/my');
      const supportNav = customer.page.getByTestId('cdash-nav-support');
      await expect(supportNav).toBeVisible();
      await expect(supportNav).not.toContainText(/yakında/i);
      await supportNav.click();
      await expect(customer.page).toHaveURL(/\/destek$/);
      await assertNoErrorScreen(customer.page);

      // ---- with nothing in it yet -----------------------------------------
      await expect(customer.page.getByTestId('support-list-empty')).toBeVisible();
      await expect(customer.page.getByTestId('support-screen').getByText(/yakında/i)).toHaveCount(
        0,
      );

      // ---- the customer opens one -----------------------------------------
      await customer.page.getByTestId('support-new-cta').click();
      await expect(customer.page).toHaveURL(/\/destek\/yeni$/);

      await customer.page.getByTestId('support-subject-input').fill(SUBJECT);
      await customer.page.getByTestId('support-message-input').fill(FIRST_MESSAGE);
      await customer.page.getByTestId('support-submit').click();

      // The action lands on the ticket itself, and says so.
      await expect(customer.page).toHaveURL(/\/destek\/[^/]+\?created=1$/);
      await expect(customer.page.getByTestId('support-created-notice')).toBeVisible();
      await assertNoErrorScreen(customer.page);

      const ticketUrl = customer.page.url().split('?')[0]!;
      const ticketId = ticketUrl.split('/').pop() as string;

      // Exactly one ticket exists, it belongs to this customer, and its opening
      // message is on the timeline rather than hidden in a column.
      const stored = await prisma().supportTicket.findMany({ include: { messages: true } });
      expect(stored).toHaveLength(1);
      expect(stored[0]!.customerId).toBe(customerAccount.id);
      expect(stored[0]!.status).toBe('OPEN');
      expect(stored[0]!.messages).toHaveLength(1);

      await expect(customer.page.getByTestId('support-ticket-title')).toHaveText(SUBJECT);
      await expect(customer.page.getByTestId('support-timeline-message')).toHaveCount(1);
      await expect(customer.page.getByTestId('support-timeline-message').first()).toContainText(
        FIRST_MESSAGE,
      );
      await expect(customer.page.getByTestId('support-reply-form')).toBeVisible();

      // ---- and finds it in their own list ---------------------------------
      await customer.gotoWeb('/destek');
      await expect(customer.page.getByTestId('support-ticket-row')).toHaveCount(1);
      await expect(customer.page.getByTestId('support-ticket-subject')).toHaveText(SUBJECT);
      await expect(customer.page.getByTestId('support-ticket-status')).toHaveText('Açık');

      // ---- the operator finds it in the queue -----------------------------
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/support');
      await assertNoErrorScreen(admin.page);

      await expect(admin.page.getByTestId('support-ticket-row')).toHaveCount(1);
      await expect(admin.page.getByTestId('support-ticket-subject')).toHaveText(SUBJECT);
      await admin.page.getByRole('link', { name: 'Detay' }).click();
      await expect(admin.page).toHaveURL(new RegExp(`/support/${ticketId}$`));

      await expect(admin.page.getByTestId('support-timeline-message')).toHaveCount(1);
      await expect(admin.page.getByTestId('support-detail-status')).toHaveText('Açık');

      // ---- takes it in hand and answers -----------------------------------
      await admin.page.getByTestId('support-transition-IN_PROGRESS').click();
      await expect(admin.page.getByTestId('support-status-saved')).toBeVisible();
      await expect(admin.page.getByTestId('support-detail-status')).toHaveText('İşlemde');

      await admin.page.getByTestId('support-reply-input').fill(ADMIN_REPLY);
      await admin.page.getByTestId('support-reply-send').click();
      await expect(admin.page.getByTestId('support-reply-sent')).toBeVisible();
      await expect(admin.page.getByTestId('support-timeline-message')).toHaveCount(2);
      await assertNoErrorScreen(admin.page);

      // The status change and the operator's message are both on the permanent
      // timeline, and they are different kinds of entry.
      await expect(admin.page.getByTestId('support-timeline-event')).toHaveCount(1);
      await expect(admin.page.getByTestId('support-timeline-event').first()).toContainText(
        'işleme alındı',
      );

      // ---- the customer sees both, and can still write --------------------
      await customer.gotoWeb(`/destek/${ticketId}`);
      await expect(customer.page.getByTestId('support-detail-status')).toHaveText('İşlemde');
      await expect(customer.page.getByTestId('support-timeline-message')).toHaveCount(2);
      await expect(customer.page.getByTestId('support-timeline-message').nth(1)).toContainText(
        ADMIN_REPLY,
      );
      // Each message is attributed to a side, and the customer's own is theirs.
      await expect(customer.page.getByTestId('support-timeline-message').first()).toHaveAttribute(
        'data-author',
        'CUSTOMER',
      );
      await expect(customer.page.getByTestId('support-timeline-message').nth(1)).toHaveAttribute(
        'data-author',
        'ADMIN',
      );

      await customer.page.getByTestId('support-reply-input').fill(CUSTOMER_REPLY);
      await customer.page.getByTestId('support-reply-send').click();
      await expect(customer.page.getByTestId('support-sent-notice')).toBeVisible();
      await expect(customer.page.getByTestId('support-timeline-message')).toHaveCount(3);
      await assertNoErrorScreen(customer.page);

      // ---- the operator resolves, then closes -----------------------------
      await admin.gotoAdmin(`/support/${ticketId}`);
      await admin.page.getByTestId('support-transition-RESOLVED').click();
      await expect(admin.page.getByTestId('support-detail-status')).toHaveText('Çözüldü');

      // A resolved ticket may only be closed — the other moves have no button.
      await expect(admin.page.getByTestId('support-transition-CLOSED')).toBeVisible();
      await expect(admin.page.getByTestId('support-transition-OPEN')).toHaveCount(0);
      await expect(admin.page.getByTestId('support-transition-IN_PROGRESS')).toHaveCount(0);

      // ---- and a resolved ticket already refuses the customer -------------
      await customer.gotoWeb(`/destek/${ticketId}`);
      await expect(customer.page.getByTestId('support-closed-notice')).toBeVisible();
      await expect(customer.page.getByTestId('support-reply-form')).toHaveCount(0);

      await admin.gotoAdmin(`/support/${ticketId}`);
      await admin.page.getByTestId('support-transition-CLOSED').click();
      await expect(admin.page.getByTestId('support-detail-status')).toHaveText('Kapatıldı');

      // Closed is terminal: no transition is offered at all, and the operator's
      // own composer is gone too.
      await expect(admin.page.getByTestId('support-no-transitions')).toBeVisible();
      await expect(admin.page.getByTestId('support-transitions')).toHaveCount(0);
      await expect(admin.page.getByTestId('support-reply-closed')).toBeVisible();
      await expect(admin.page.getByTestId('support-reply-form')).toHaveCount(0);

      // ---- the customer is told, and pointed at a new ticket ---------------
      await customer.gotoWeb(`/destek/${ticketId}`);
      await expect(customer.page.getByTestId('support-detail-status')).toHaveText('Kapatıldı');
      const closedNotice = customer.page.getByTestId('support-closed-notice');
      await expect(closedNotice).toBeVisible();
      await expect(
        closedNotice.getByRole('link', { name: 'yeni bir destek talebi' }),
      ).toBeVisible();
      await expect(customer.page.getByTestId('support-reply-form')).toHaveCount(0);
      await assertNoErrorScreen(customer.page);

      // The whole history survived being closed: three messages and three
      // status changes, in the order they happened.
      await expect(customer.page.getByTestId('support-timeline-message')).toHaveCount(3);
      await expect(customer.page.getByTestId('support-timeline-event')).toHaveCount(3);

      // ---- and no placeholder text is left anywhere on the surface ---------
      for (const path of ['/destek', '/destek/yeni', `/destek/${ticketId}`]) {
        await customer.gotoWeb(path);
        await expect(
          customer.page.getByTestId('support-screen').getByText(/yakında/i),
          `${path} must not carry a "yakında" placeholder`,
        ).toHaveCount(0);
        await expect(customer.page.getByTestId('cdash-nav-support')).not.toContainText(/yakında/i);
      }
    } finally {
      await Promise.all([customer.close(), admin.close()]);
    }
  });

  test('another customer cannot see, open or reach a ticket that is not theirs', async ({
    browser,
  }) => {
    const ownerAccount = await createCustomer('E2E Sahip');
    const outsiderAccount = await createCustomer('E2E Yabancı');

    const owner = await Actor.open(browser, 'owner', primaryRuntime);
    const outsider = await Actor.open(browser, 'outsider', primaryRuntime);

    try {
      await owner.loginToWeb(ownerAccount.email, ownerAccount.password);
      await owner.gotoWeb('/destek/yeni');
      await owner.page.getByTestId('support-subject-input').fill('Gizli konu');
      await owner.page.getByTestId('support-message-input').fill('Bu yalnızca bana ait.');
      await owner.page.getByTestId('support-submit').click();
      await expect(owner.page).toHaveURL(/\/destek\/[^/]+\?created=1$/);

      const ticketId = owner.page.url().split('?')[0]!.split('/').pop() as string;

      await outsider.loginToWeb(outsiderAccount.email, outsiderAccount.password);

      // Not in their list…
      await outsider.gotoWeb('/destek');
      await expect(outsider.page.getByTestId('support-list-empty')).toBeVisible();

      // …and not by naming the ticket. The id is not what authorises, so
      // knowing it buys nothing — and the 404 says the same thing to somebody
      // who guessed an id as to somebody whose ticket really is gone.
      await outsider.gotoWeb(`/destek/${ticketId}`);
      await expectNotFoundScreen(outsider.page);

      // Nothing that was written leaked onto the outsider's own screens.
      const body = await outsider.page.locator('body').innerText();
      expect(body).not.toContain('Bu yalnızca bana ait.');
      expect(body).not.toContain('Gizli konu');

      // An anonymous visitor is refused at the HTTP level, not merely
      // redirected from inside a page that was already committed.
      const anonymous = await Actor.open(browser, 'anonymous', primaryRuntime);
      try {
        for (const path of ['/destek', '/destek/yeni', `/destek/${ticketId}`]) {
          const response = await anonymous.page.request.get(anonymous.webUrl(path), {
            maxRedirects: 0,
          });
          expect(response.status(), `${path} must refuse an anonymous request`).toBe(307);
          expect(response.headers()['location']).toBe(`/login?redirectTo=${path}`);
        }
      } finally {
        await anonymous.close();
      }
    } finally {
      await Promise.all([owner.close(), outsider.close()]);
    }
  });

  test('neither support screen overflows sideways on a phone', async ({ browser }) => {
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoWeb('/destek/yeni');

      // A subject and a body with no spaces in them: the case that used to widen
      // a panel is one long unbroken token, not ordinary prose.
      await customer.page
        .getByTestId('support-subject-input')
        .fill('Cok-uzun-ve-bosluksuz-bir-konu-basligi-tasma-testi-icin-yazildi');
      await customer.page
        .getByTestId('support-message-input')
        .fill(`${'a'.repeat(300)} normal bir cümle de var.`);
      await customer.page.getByTestId('support-submit').click();
      await expect(customer.page).toHaveURL(/\/destek\/[^/]+\?created=1$/);
      const ticketId = customer.page.url().split('?')[0]!.split('/').pop() as string;

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/support/${ticketId}`);
      await admin.page.getByTestId('support-reply-input').fill('b'.repeat(300));
      await admin.page.getByTestId('support-reply-send').click();
      await expect(admin.page.getByTestId('support-reply-sent')).toBeVisible();

      for (const width of MOBILE_WIDTHS) {
        await customer.page.setViewportSize({ width, height: 780 });
        for (const path of ['/destek', '/destek/yeni', `/destek/${ticketId}`]) {
          await customer.gotoWeb(path);
          await expectNoHorizontalOverflow(customer.page, `customer ${path} at ${width}px`);
        }

        await admin.page.setViewportSize({ width, height: 780 });
        for (const path of ['/support', `/support/${ticketId}`]) {
          await admin.gotoAdmin(path);
          await expectNoHorizontalOverflow(admin.page, `admin ${path} at ${width}px`);
        }
      }
    } finally {
      await Promise.all([customer.close(), admin.close()]);
    }
  });
});
