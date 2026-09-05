import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  prisma,
  uniqueLocation,
} from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The support desk from the hizmet veren panel, end to end.
 *
 * Three claims, and every one of them is driven through real screens because
 * every one of them is about a screen. **Destek is an ordinary section of both
 * sidebars, in the same place, with no "yakında" anywhere and no empty column
 * pushed to the floor.** **A hizmet veren opens, reads and answers a ticket of
 * their own, on screens that look and behave like the hizmet alan's.** And
 * **the operator sees both desks in one queue, can tell them apart at a glance
 * and can narrow to either.**
 *
 * `support-tickets.spec.ts` still owns the hizmet alan journey and the rules
 * that are the same for both. What is here is only what the second desk added.
 */

const SUBJECT = 'Teklif verdim, kredim düştü ama teklif görünmüyor';
const FIRST_MESSAGE = 'Dün akşam teklif verdim, kredim düştü fakat teklif listede yok.';
const ADMIN_REPLY = 'Krediniz iade edildi, teklifiniz yeniden yayına alındı.';
const PROVIDER_REPLY = 'Teşekkürler, teklif şimdi listede görünüyor.';

/** The widths the responsive brief names, down to the 320px floor. */
const MOBILE_WIDTHS = [320, 375] as const;

/**
 * The order both panels put their sections in, as far as this brief fixes it.
 *
 * Destek sits immediately after Mesajlar and before the panel's own
 * profile/settings entry. Written as a triple rather than as a whole nav
 * listing so the assertion stays about the thing that was decided, and does not
 * fail the day a panel gains a section somewhere else.
 */
const CUSTOMER_TAIL = ['cdash-nav-messages', 'cdash-nav-support', 'cdash-nav-settings'] as const;
const PROVIDER_TAIL = ['pdash-nav-messages', 'pdash-nav-support', 'pdash-nav-credits'] as const;

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(
    overflow,
    `${label}: the page is ${overflow}px wider than the viewport`,
  ).toBeLessThanOrEqual(0);
}

/**
 * The sections a panel's nav actually renders, in document order.
 *
 * Read off the DOM rather than asserted one by one, so "Destek comes after
 * Mesajlar" is a statement about the order somebody tabs through rather than
 * about two elements both happening to exist.
 *
 * The child combinator matters. A section's counter badge is a `<span>` *inside*
 * the entry carrying `<prefix>-nav-count-<key>`, which a descendant selector
 * picks up as well — and the interleaved counters then make the order read as
 * "requests > count-requests > offers > …", which contains no adjacent pair of
 * sections at all. Only the entries themselves are direct children of `.nav`.
 */
async function navOrder(page: Page, prefix: 'cdash' | 'pdash'): Promise<string[]> {
  return page
    .locator(`.${prefix}-nav > [data-testid^="${prefix}-nav-"]`)
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.testid as string),
    );
}

/** Every section in a panel's nav, and nothing outside it, is free of "yakında". */
async function expectNoComingSoonInNav(page: Page, prefix: 'cdash' | 'pdash', label: string) {
  const nav = page.locator(`.${prefix}-nav`);
  await expect(nav, `${label}: the sidebar nav must exist`).toBeVisible();
  await expect(
    nav.getByText(/yakında/i),
    `${label}: no section may still be labelled "yakında"`,
  ).toHaveCount(0);
  // The pinned footer that used to hold the Destek placeholder is gone
  // entirely, along with the empty column it pushed above itself.
  await expect(
    page.locator(`.${prefix}-sidebar-footer`),
    `${label}: the pinned sidebar footer must be gone`,
  ).toHaveCount(0);
}

test.describe('destek in both sidebars', () => {
  test('sits after Mesajlar in each panel, with no placeholder and no pinned footer', async ({
    browser,
  }) => {
    const customerAccount = await createCustomer();
    const category = await createCategory(2);
    const providerAccount = await createProvider({
      categoryId: category.id,
      location: uniqueLocation(),
      credits: 5,
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoWeb('/requests/my');
      await assertNoErrorScreen(customer.page);

      const customerNav = await navOrder(customer.page, 'cdash');
      expect(customerNav.join(' > ')).toContain(CUSTOMER_TAIL.join(' > '));
      await expectNoComingSoonInNav(customer.page, 'cdash', 'customer panel');

      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb('/providers/me');
      await assertNoErrorScreen(provider.page);

      const providerNav = await navOrder(provider.page, 'pdash');
      expect(providerNav.join(' > ')).toContain(PROVIDER_TAIL.join(' > '));
      await expectNoComingSoonInNav(provider.page, 'pdash', 'provider panel');

      // Both entries are real links that land on the same screen, and the
      // section is marked current once there.
      for (const [actor, prefix] of [
        [customer, 'cdash'],
        [provider, 'pdash'],
      ] as const) {
        const entry = actor.page.getByTestId(`${prefix}-nav-support`);
        await expect(entry).toBeVisible();
        await entry.click();
        await expect(actor.page).toHaveURL(/\/destek$/);
        await assertNoErrorScreen(actor.page);
        await expect(actor.page.getByTestId(`${prefix}-nav-support`)).toHaveAttribute(
          'aria-current',
          'page',
        );
      }
    } finally {
      await Promise.all([customer.close(), provider.close()]);
    }
  });

  test('keeps the same order inside the mobile drawer, at 320px and up', async ({ browser }) => {
    const category = await createCategory(2);
    const providerAccount = await createProvider({
      categoryId: category.id,
      location: uniqueLocation(),
      credits: 5,
    });
    const customerAccount = await createCustomer();

    const provider = await Actor.open(browser, 'provider', primaryRuntime);
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await customer.loginToWeb(customerAccount.email, customerAccount.password);

      for (const width of MOBILE_WIDTHS) {
        for (const [actor, prefix, path, tail] of [
          [customer, 'cdash', '/requests/my', CUSTOMER_TAIL],
          [provider, 'pdash', '/providers/me', PROVIDER_TAIL],
        ] as const) {
          await actor.page.setViewportSize({ width, height: 780 });
          await actor.gotoWeb(path);

          const toggle = actor.page.getByTestId('panel-drawer-toggle');
          await expect(toggle).toBeVisible();
          await toggle.click();
          await expect(actor.page.locator(`#${prefix}-drawer`)).toBeVisible();

          // The drawer renders the same sidebar, so it must carry the same
          // information architecture — not merely the same links in some order.
          expect(
            (await navOrder(actor.page, prefix)).join(' > '),
            `${prefix} drawer at ${width}px`,
          ).toContain(tail.join(' > '));
          await expectNoComingSoonInNav(actor.page, prefix, `${prefix} drawer at ${width}px`);
          await expectNoHorizontalOverflow(actor.page, `${prefix} drawer open at ${width}px`);

          await actor.page.keyboard.press('Escape');
        }
      }
    } finally {
      await Promise.all([provider.close(), customer.close()]);
    }
  });
});

test.describe('a hizmet veren and the support desk', () => {
  test('opens a ticket, an operator answers it and both sides read the same conversation', async ({
    browser,
  }) => {
    const category = await createCategory(2);
    const providerAccount = await createProvider({
      categoryId: category.id,
      location: uniqueLocation(),
      credits: 5,
    });
    const adminAccount = await createAdmin();

    const provider = await Actor.open(browser, 'provider', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);

      // ---- an empty desk, inside the provider panel -----------------------
      await provider.gotoWeb('/destek');
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('support-list-empty')).toBeVisible();
      // The frame around it really is the provider's own panel, not the
      // customer's — the credit box is the tell, and it is what makes this one
      // interface rather than two.
      await expect(provider.page.locator('.pdash-nav')).toBeVisible();
      await expect(provider.page.locator('.cdash-nav')).toHaveCount(0);

      // ---- opens one -------------------------------------------------------
      await provider.page.getByTestId('support-new-cta').click();
      await expect(provider.page).toHaveURL(/\/destek\/yeni$/);

      await provider.page.getByTestId('support-subject-input').fill(SUBJECT);
      await provider.page.getByTestId('support-message-input').fill(FIRST_MESSAGE);
      await provider.page.getByTestId('support-submit').click();

      await expect(provider.page).toHaveURL(/\/destek\/[^/]+\?created=1$/);
      await expect(provider.page.getByTestId('support-created-notice')).toBeVisible();
      await assertNoErrorScreen(provider.page);

      const ticketId = provider.page.url().split('?')[0]!.split('/').pop() as string;

      // The row was written on the provider's desk, by the create path rather
      // than by anything this test said.
      const stored = await prisma().supportTicket.findMany({
        where: { requesterId: providerAccount.userId },
        include: { messages: true },
      });
      expect(stored).toHaveLength(1);
      expect(stored[0]!.id).toBe(ticketId);
      expect(stored[0]!.requesterRole).toBe('PROVIDER');
      expect(stored[0]!.messages).toHaveLength(1);
      expect(stored[0]!.messages[0]!.authorRole).toBe('PROVIDER');

      await expect(provider.page.getByTestId('support-ticket-title')).toHaveText(SUBJECT);
      await expect(provider.page.getByTestId('support-timeline-message')).toHaveCount(1);
      await expect(provider.page.getByTestId('support-reply-form')).toBeVisible();

      // ---- the operator finds it, and can tell which desk it is on ---------
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/support');
      await assertNoErrorScreen(admin.page);

      const queueRow = admin.page.getByTestId('support-ticket-row').filter({ hasText: SUBJECT });
      await expect(queueRow).toHaveCount(1);
      await expect(queueRow).toHaveAttribute('data-requester-role', 'PROVIDER');
      await expect(queueRow.getByTestId('support-ticket-requester-role')).toHaveText(
        'Hizmet veren',
      );

      // ---- and can narrow the queue to each desk ---------------------------
      await admin.gotoAdmin('/support?requesterRole=PROVIDER');
      await expect(
        admin.page.getByTestId('support-ticket-row').filter({ hasText: SUBJECT }),
      ).toHaveCount(1);
      for (const row of await admin.page.getByTestId('support-ticket-row').all()) {
        await expect(row).toHaveAttribute('data-requester-role', 'PROVIDER');
      }

      await admin.gotoAdmin('/support?requesterRole=CUSTOMER');
      await expect(
        admin.page.getByTestId('support-ticket-row').filter({ hasText: SUBJECT }),
      ).toHaveCount(0);
      for (const row of await admin.page.getByTestId('support-ticket-row').all()) {
        await expect(row).toHaveAttribute('data-requester-role', 'CUSTOMER');
      }

      // ---- answers it ------------------------------------------------------
      await admin.gotoAdmin(`/support/${ticketId}`);
      await expect(admin.page.getByTestId('support-detail-requester-role')).toHaveText(
        'Hizmet veren',
      );
      await admin.page.getByTestId('support-transition-IN_PROGRESS').click();
      await expect(admin.page.getByTestId('support-detail-status')).toHaveText('İşlemde');

      await admin.page.getByTestId('support-reply-input').fill(ADMIN_REPLY);
      await admin.page.getByTestId('support-reply-send').click();
      await expect(admin.page.getByTestId('support-reply-sent')).toBeVisible();
      await expect(admin.page.getByTestId('support-timeline-message')).toHaveCount(2);
      // The operator's timeline names the side each message came from.
      await expect(admin.page.getByTestId('support-timeline-message').first()).toHaveAttribute(
        'data-author',
        'PROVIDER',
      );
      await expect(admin.page.getByTestId('support-timeline-message').first()).toContainText(
        'Hizmet veren',
      );

      // ---- the provider reads it and writes back ---------------------------
      await provider.gotoWeb(`/destek/${ticketId}`);
      await expect(provider.page.getByTestId('support-detail-status')).toHaveText('İşlemde');
      await expect(provider.page.getByTestId('support-timeline-message')).toHaveCount(2);
      await expect(provider.page.getByTestId('support-timeline-message').nth(1)).toContainText(
        ADMIN_REPLY,
      );
      await expect(provider.page.getByTestId('support-timeline-message').first()).toHaveAttribute(
        'data-author',
        'PROVIDER',
      );

      await provider.page.getByTestId('support-reply-input').fill(PROVIDER_REPLY);
      await provider.page.getByTestId('support-reply-send').click();
      await expect(provider.page.getByTestId('support-sent-notice')).toBeVisible();
      await expect(provider.page.getByTestId('support-timeline-message')).toHaveCount(3);
      await assertNoErrorScreen(provider.page);

      // ---- resolved, then closed, with the same terminal behaviour ---------
      await admin.gotoAdmin(`/support/${ticketId}`);
      await admin.page.getByTestId('support-transition-RESOLVED').click();
      await expect(admin.page.getByTestId('support-detail-status')).toHaveText('Çözüldü');

      await provider.gotoWeb(`/destek/${ticketId}`);
      await expect(provider.page.getByTestId('support-closed-notice')).toBeVisible();
      await expect(provider.page.getByTestId('support-reply-form')).toHaveCount(0);

      await admin.gotoAdmin(`/support/${ticketId}`);
      await admin.page.getByTestId('support-transition-CLOSED').click();
      await expect(admin.page.getByTestId('support-no-transitions')).toBeVisible();
      await expect(admin.page.getByTestId('support-reply-closed')).toBeVisible();

      await provider.gotoWeb(`/destek/${ticketId}`);
      await expect(provider.page.getByTestId('support-detail-status')).toHaveText('Kapatıldı');
      // The whole history survived being closed.
      await expect(provider.page.getByTestId('support-timeline-message')).toHaveCount(3);
      await expect(provider.page.getByTestId('support-timeline-event')).toHaveCount(3);

      // ---- and no placeholder anywhere on the provider's support surface ---
      for (const path of ['/destek', '/destek/yeni', `/destek/${ticketId}`]) {
        await provider.gotoWeb(path);
        await expect(
          provider.page.getByTestId('support-screen').getByText(/yakında/i),
          `${path} must not carry a "yakında" placeholder`,
        ).toHaveCount(0);
        await expectNoComingSoonInNav(provider.page, 'pdash', path);
      }
    } finally {
      await Promise.all([provider.close(), admin.close()]);
    }
  });

  test('neither marketplace role can reach the other role\'s ticket', async ({ browser }) => {
    const category = await createCategory(2);
    const providerAccount = await createProvider({
      categoryId: category.id,
      location: uniqueLocation(),
      credits: 5,
    });
    const customerAccount = await createCustomer('E2E Destek Müşterisi');

    const provider = await Actor.open(browser, 'provider', primaryRuntime);
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb('/destek/yeni');
      await provider.page.getByTestId('support-subject-input').fill('Hizmet verene özel konu');
      await provider.page
        .getByTestId('support-message-input')
        .fill('Bu yalnızca hizmet verene ait.');
      await provider.page.getByTestId('support-submit').click();
      await expect(provider.page).toHaveURL(/\/destek\/[^/]+\?created=1$/);
      const providerTicketId = provider.page.url().split('?')[0]!.split('/').pop() as string;

      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoWeb('/destek/yeni');
      await customer.page.getByTestId('support-subject-input').fill('Hizmet alana özel konu');
      await customer.page.getByTestId('support-message-input').fill('Bu yalnızca hizmet alana ait.');
      await customer.page.getByTestId('support-submit').click();
      await expect(customer.page).toHaveURL(/\/destek\/[^/]+\?created=1$/);
      const customerTicketId = customer.page.url().split('?')[0]!.split('/').pop() as string;

      // Each list holds exactly one ticket: their own.
      for (const [actor, ownSubject] of [
        [provider, 'Hizmet verene özel konu'],
        [customer, 'Hizmet alana özel konu'],
      ] as const) {
        await actor.gotoWeb('/destek');
        await expect(actor.page.getByTestId('support-ticket-row')).toHaveCount(1);
        await expect(actor.page.getByTestId('support-ticket-subject')).toHaveText(ownSubject);
      }

      // And neither reaches the other's by naming it. The id is not what
      // authorises, so knowing it buys nothing — and the refusal is the same
      // 404 a made-up id gets, so it cannot be used to learn that a ticket
      // exists on the other desk.
      for (const [actor, otherTicketId, secret] of [
        [provider, customerTicketId, 'Bu yalnızca hizmet alana ait.'],
        [customer, providerTicketId, 'Bu yalnızca hizmet verene ait.'],
      ] as const) {
        await actor.gotoWeb(`/destek/${otherTicketId}`);
        await expectNotFoundScreen(actor.page);

        const body = await actor.page.locator('body').innerText();
        expect(body).not.toContain(secret);
      }
    } finally {
      await Promise.all([provider.close(), customer.close()]);
    }
  });

  test('the provider support screens do not overflow sideways on a phone', async ({ browser }) => {
    const category = await createCategory(2);
    const providerAccount = await createProvider({
      categoryId: category.id,
      location: uniqueLocation(),
      credits: 5,
    });
    const adminAccount = await createAdmin();

    const provider = await Actor.open(browser, 'provider', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb('/destek/yeni');

      // One long unbroken token in each field: the case that widens a panel is
      // not ordinary prose.
      await provider.page
        .getByTestId('support-subject-input')
        .fill('Cok-uzun-ve-bosluksuz-bir-hizmet-veren-konusu-tasma-testi-icin');
      await provider.page
        .getByTestId('support-message-input')
        .fill(`${'a'.repeat(300)} normal bir cümle de var.`);
      await provider.page.getByTestId('support-submit').click();
      await expect(provider.page).toHaveURL(/\/destek\/[^/]+\?created=1$/);
      const ticketId = provider.page.url().split('?')[0]!.split('/').pop() as string;

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/support/${ticketId}`);
      await admin.page.getByTestId('support-reply-input').fill('b'.repeat(300));
      await admin.page.getByTestId('support-reply-send').click();
      await expect(admin.page.getByTestId('support-reply-sent')).toBeVisible();

      for (const width of MOBILE_WIDTHS) {
        await provider.page.setViewportSize({ width, height: 780 });
        for (const path of ['/destek', '/destek/yeni', `/destek/${ticketId}`]) {
          await provider.gotoWeb(path);
          await expectNoHorizontalOverflow(provider.page, `provider ${path} at ${width}px`);
        }

        // The queue gained a column, so the admin list is re-checked at the
        // floor: a seventh column is exactly the kind of change that pushes a
        // table out of its own scroll box.
        await admin.page.setViewportSize({ width, height: 780 });
        for (const path of ['/support', '/support?requesterRole=PROVIDER', `/support/${ticketId}`]) {
          await admin.gotoAdmin(path);
          await expectNoHorizontalOverflow(admin.page, `admin ${path} at ${width}px`);
        }
      }
    } finally {
      await Promise.all([provider.close(), admin.close()]);
    }
  });
});
