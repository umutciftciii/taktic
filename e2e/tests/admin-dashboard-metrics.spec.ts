import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCustomer, createSupportTicket } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The admin dashboard's metric cards.
 *
 * Two defects, one screen. A card wore a "dikkat" badge whatever its count, so
 * an operator opening a quiet marketplace was warned about zero pending
 * requests, zero tickets in review and zero refund candidates — a badge that is
 * always on says nothing when it matters. And support tickets, which an
 * operator does have to answer, were not on the dashboard at all: the only way
 * to learn one had been opened was to go looking for it.
 *
 * What is asserted here is the rule rather than a screenshot: **no card showing
 * a zero carries a badge**, checked across every card on the screen so a card
 * added later cannot quietly opt out, and **the support card counts the backlog
 * and hands the operator exactly the tickets it counted** — the number on the
 * card and the total on the screen it opens, compared against each other rather
 * than each against a hard-coded three. The badge rule itself is pinned
 * as a pure function in `apps/admin/test/dashboard-metrics.spec.ts` and the
 * backlog's definition in `apps/api/test/admin-dashboard-summary.spec.ts`; this
 * spec is what proves the screen actually uses both.
 *
 * This file runs before `support-tickets.spec.ts` and before anything else that
 * opens a ticket, so the support card genuinely starts at zero — which is what
 * makes the zero case here a real observation rather than a hopeful one.
 */

const SUPPORT_CARD = '[data-metric="openSupportTickets"]';
const DESKTOP = { width: 1280, height: 900 } as const;

/**
 * Subjects unique to this spec, so every assertion below names its own tickets.
 *
 * The suite shares one database and runs serially, so "how many tickets exist"
 * is a number other specs move. What this spec claims is about these five and
 * the delta they make, never about a total.
 */
const BACKLOG = {
  openA: `Dashboard OPEN A ${Date.now()}`,
  openB: `Dashboard OPEN B ${Date.now()}`,
  inProgress: `Dashboard IN_PROGRESS ${Date.now()}`,
  resolved: `Dashboard RESOLVED ${Date.now()}`,
  closed: `Dashboard CLOSED ${Date.now()}`,
} as const;

/** Nothing may make the document wider than the window it is in. */
async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(
    overflow,
    `${label}: the page is ${overflow}px wider than the viewport`,
  ).toBeLessThanOrEqual(0);
}

/** Every card on the dashboard: its metric key, the number it shows, and whether it is badged. */
async function readCards(page: Page) {
  await expect(page.getByTestId('stat-card').first()).toBeVisible();

  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="stat-card"]')).map(
      (card) => ({
        metric: card.dataset.metric ?? '',
        value: Number.parseInt(card.querySelector('.metric')?.textContent ?? '', 10),
        badge: card.querySelector('[data-testid="stat-card-badge"]')?.textContent?.trim() ?? null,
        href: card.getAttribute('href'),
      }),
    ),
  );
}

test.describe('admin dashboard metric cards', () => {
  test('a zero is silent, a positive backlog is not, and the support card opens the queue', async ({
    browser,
  }) => {
    const adminAccount = await createAdmin();
    const customerAccount = await createCustomer('E2E Destek Müşterisi');

    const admin = await Actor.open(browser, 'admin-dashboard', primaryRuntime, {
      viewport: DESKTOP,
    });

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/');
      await assertNoErrorScreen(admin.page);

      // ---- nothing to do yet ---------------------------------------------
      const quiet = await readCards(admin.page);

      // The three the brief names, plus every other card on the screen: a count
      // of zero must not be wearing a badge.
      for (const key of ['pendingRequests', 'inReviewRequests', 'refundableOffers']) {
        const card = quiet.find((entry) => entry.metric === key);
        expect(card, `the dashboard has no "${key}" card`).toBeDefined();
        if (card?.value === 0) {
          expect(card.badge, `"${key}" shows 0 and still carries a badge`).toBeNull();
        }
      }

      for (const card of quiet) {
        if (card.value === 0) {
          expect(card.badge, `"${card.metric}" shows 0 and still carries a badge`).toBeNull();
        }
      }

      // Totals are there to be read, never to be warned about.
      for (const key of ['totalRequests', 'totalOffers', 'packagePurchases']) {
        expect(quiet.find((entry) => entry.metric === key)?.badge, `"${key}" is badged`).toBeNull();
      }

      // ---- the support card, before anybody has asked for help ------------
      const supportCard = admin.page.locator(SUPPORT_CARD);
      await expect(supportCard).toBeVisible();
      await expect(supportCard).toContainText('Açık destek talepleri');
      // This file sorts before every spec that opens a ticket, so the backlog
      // really is empty here: the zero is an observation, not a hope.
      await expect(supportCard.locator('.metric')).toHaveText('0');
      await expect(supportCard.getByTestId('stat-card-badge')).toHaveCount(0);
      // Both halves of the backlog, comma-separated and unencoded: the address
      // is meant to be read and pasted.
      await expect(supportCard).toHaveAttribute('href', '/support?status=OPEN,IN_PROGRESS');

      // The card names itself, its number and where it goes, to a screen reader
      // as well as to an eye.
      const supportLink = admin.page.getByRole('link', { name: /Açık destek talepleri/ });
      await expect(supportLink).toHaveCount(1);

      // ---- a backlog appears ----------------------------------------------
      // Two waiting and one being worked belong in the count; the answered one
      // and the filed one do not. Asserted as the delta these five make, so the
      // claim is about which statuses count rather than about a total the rest
      // of the suite also moves.
      const before = Number(await admin.page.locator(`${SUPPORT_CARD} .metric`).innerText());

      await createSupportTicket({
        requesterId: customerAccount.id,
        status: 'OPEN',
        subject: BACKLOG.openA,
      });
      await createSupportTicket({
        requesterId: customerAccount.id,
        status: 'OPEN',
        subject: BACKLOG.openB,
      });
      await createSupportTicket({
        requesterId: customerAccount.id,
        status: 'IN_PROGRESS',
        subject: BACKLOG.inProgress,
      });
      await createSupportTicket({
        requesterId: customerAccount.id,
        status: 'RESOLVED',
        subject: BACKLOG.resolved,
      });
      await createSupportTicket({
        requesterId: customerAccount.id,
        status: 'CLOSED',
        subject: BACKLOG.closed,
      });

      await admin.gotoAdmin('/');
      await assertNoErrorScreen(admin.page);

      await expect(admin.page.locator(`${SUPPORT_CARD} .metric`)).toHaveText(String(before + 3));
      await expect(admin.page.locator(SUPPORT_CARD).getByTestId('stat-card-badge')).toHaveText(
        'dikkat',
      );

      // ---- and it leads to exactly the tickets it counted -----------------
      const counted = Number(await admin.page.locator(`${SUPPORT_CARD} .metric`).innerText());

      await admin.page.locator(SUPPORT_CARD).click();
      // The comma survives the navigation, encoded or not, depending on the
      // browser — either is the same filter.
      await expect(admin.page).toHaveURL(/\/support\?status=OPEN(,|%2C)IN_PROGRESS$/);
      await assertNoErrorScreen(admin.page);

      // The filter reflects the link that was followed, so pressing Uygula
      // keeps the operator where they are instead of resetting to "Tümü".
      await expect(admin.page.locator('#support-status')).toHaveValue('OPEN,IN_PROGRESS');

      // The number on the card is the size of the list behind it. This is the
      // assertion the mismatch would have failed: the card said one thing and
      // the screen it opened said another.
      await expect(admin.page.getByTestId('support-ticket-count')).toHaveAttribute(
        'data-total',
        String(counted),
      );

      // And it is the same tickets, not merely the same number of them: both
      // waiting ones and the one being worked are here, the answered and the
      // filed are not.
      const rows = admin.page.getByTestId('support-ticket-row');
      for (const present of [BACKLOG.openA, BACKLOG.openB, BACKLOG.inProgress]) {
        await expect(
          rows.filter({ hasText: present }),
          `"${present}" is in the backlog and should be listed`,
        ).toHaveCount(1);
      }
      for (const absent of [BACKLOG.resolved, BACKLOG.closed]) {
        await expect(
          rows.filter({ hasText: absent }),
          `"${absent}" is finished work and should not be listed`,
        ).toHaveCount(0);
      }

      // Nothing outside the backlog slipped through the filter either.
      for (const status of await rows.evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLElement).dataset.status),
      )) {
        expect(['OPEN', 'IN_PROGRESS']).toContain(status);
      }
    } finally {
      await admin.close();
    }
  });

  test('the cards and the list they open fit a 320px phone', async ({ browser }) => {
    const adminAccount = await createAdmin();

    const admin = await Actor.open(browser, 'admin-dashboard-320', primaryRuntime, {
      viewport: { width: 320, height: 640 },
    });

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/');
      await assertNoErrorScreen(admin.page);

      await expect(admin.page.locator(SUPPORT_CARD)).toBeVisible();
      await expectNoHorizontalOverflow(admin.page, 'admin dashboard @320');

      const box = await admin.page.locator(SUPPORT_CARD).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: Math.round(rect.left), right: Math.round(rect.right) };
      });
      expect(box.left, 'the support card starts off the left edge').toBeGreaterThanOrEqual(-1);
      expect(box.right, 'the support card ends past the right edge').toBeLessThanOrEqual(321);

      // And the screen the card opens. Its filter gained an option naming both
      // backlog statuses, and a `<select>` is as wide as its widest option — the
      // one way this change could widen a phone.
      await admin.gotoAdmin('/support?status=OPEN,IN_PROGRESS');
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.locator('#support-status')).toHaveValue('OPEN,IN_PROGRESS');
      await expectNoHorizontalOverflow(admin.page, 'admin backlog list @320');
    } finally {
      await admin.close();
    }
  });

  test('a customer is never shown the admin dashboard, signed in or not', async ({ browser }) => {
    const customerAccount = await createCustomer('E2E Yetkisiz');

    const anonymous = await Actor.open(browser, 'admin-dashboard-anon', primaryRuntime);
    const customer = await Actor.open(browser, 'admin-dashboard-customer', primaryRuntime);

    try {
      // Nobody signed in: the dashboard is the login screen, and no metric
      // reaches the page.
      await anonymous.gotoAdmin('/');
      await expect(anonymous.page).toHaveURL(/\/login/);
      await expect(anonymous.page.getByTestId('stat-card')).toHaveCount(0);

      // A real customer session, carried to the admin panel: the panel's own
      // guard sends them to its login screen rather than rendering the numbers.
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoAdmin('/');
      await expect(customer.page).toHaveURL(/\/login/);
      await expect(customer.page.getByTestId('stat-card')).toHaveCount(0);
      await expect(customer.page.getByText('Açık destek talepleri')).toHaveCount(0);
    } finally {
      await anonymous.close();
      await customer.close();
    }
  });
});
