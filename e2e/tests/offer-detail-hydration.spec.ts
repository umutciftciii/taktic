import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
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
import {
  approveRequest,
  createRequest,
  readProviderOfferId,
  submitOffer,
} from '../src/journeys';
import { primaryRuntime } from '../src/runtime';

/**
 * The route an e-mail's "Teklif detayını görüntüle" button opens, rendered by a
 * browser in a different time zone from the server.
 *
 * That is the exact arrangement behind the reported failure. The application
 * servers here run in the host's zone — UTC in CI — and the context below
 * reports Europe/Istanbul, three hours ahead. Every offer row on these screens
 * prints a submission time, and the formatter used to take the zone from
 * whichever runtime it happened to be in: the server wrote "27 Ağu 2026 23:29"
 * into the HTML and the browser re-rendered "28 Ağu 2026 02:29", so React threw
 * the server tree away and logged a hydration error.
 *
 * Two independent checks, because either alone can pass for the wrong reason:
 *
 * 1. React must not report a hydration mismatch. That is precisely the
 *    assertion "the server rendered what the client renders": if the two trees
 *    disagreed by so much as an hour, React would log it and this fails.
 * 2. The text on screen must be the product's zone and not the browser's guess
 *    or the server's. Computed here, in a third process, from the timestamp the
 *    database holds — so a formatter that quietly followed its host would give
 *    this test a different answer from the browser's.
 *
 * Nothing here is suppressed. `suppressHydrationWarning` would have silenced
 * check 1 while leaving the screen showing the wrong hour.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;

/** A zone that is not the servers'. Three hours of difference is the bug. */
const VISITOR_TIME_ZONE = 'Europe/Istanbul';

/**
 * What React says when the two renders disagree.
 *
 * The development wording is only half of it: this suite runs `next start`, and
 * a production React minifies its messages down to "Minified React error #418"
 * with a link. 418, 423 and 425 are the hydration family — text content
 * mismatch, hydration failed, and the same under Suspense — so a check that
 * only looked for the word "hydration" would pass against a broken build,
 * which is exactly what it did before these codes were added.
 */
const HYDRATION_PATTERNS = [
  /hydrat/i,
  /did not match/i,
  /server rendered/i,
  /text content does not match/i,
  /Minified React error #(418|422|423|425)/,
  /react\.dev\/errors\/(418|422|423|425)/,
];

function collectHydrationErrors(page: Page): string[] {
  const seen: string[] = [];
  const record = (message: ConsoleMessage) => {
    if (message.type() !== 'error' && message.type() !== 'warning') {
      return;
    }

    const text = message.text();
    if (HYDRATION_PATTERNS.some((pattern) => pattern.test(text))) {
      seen.push(text);
    }
  };

  page.on('console', record);
  page.on('pageerror', (error) => {
    if (HYDRATION_PATTERNS.some((pattern) => pattern.test(error.message))) {
      seen.push(error.message);
    }
  });

  return seen;
}

/**
 * The reading the product owes a visitor, in the product's own zone.
 *
 * Spelled out rather than imported so this file is an independent witness: if
 * the shared formatter ever went back to following its host, the browser and
 * this function would disagree and the test would say so.
 */
function inZone(at: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(at);
  const time = new Intl.DateTimeFormat('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(at);

  return `${date} ${time}`;
}

test.describe('offer detail hydration', () => {
  test('renders the same timestamp on the server and in a differently-zoned browser', async ({
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

    // The customer's browser is the one that used to disagree with the server.
    const customer = await Actor.open(browser, 'customer', primaryRuntime, {
      timezoneId: VISITOR_TIME_ZONE,
      locale: 'tr-TR',
    });
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    const hydrationErrors = collectHydrationErrors(customer.page);

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
        priceAmount: '2200.00',
        message: 'Klimanızdaki sorunu aynı gün giderebiliriz.',
      });
      const offerId = await readProviderOfferId(provider, providerAccount.id, requestId);

      // The instant the screens are about to render, straight from the store.
      const { submittedAt } = await prisma().offer.findUniqueOrThrow({
        where: { id: offerId },
        select: { submittedAt: true },
      });
      const expected = inZone(submittedAt, VISITOR_TIME_ZONE);
      // The reading a server in UTC would have produced. Kept as a guard: if the
      // fixture ever lands on an instant where the two zones agree, this test
      // would be proving nothing and says so instead of passing quietly.
      const hostReading = inZone(submittedAt, 'UTC');

      // ---- 1. the offers list, which the e-mail's CTA leads into -----------
      const offersPath = `/requests/${requestId}/offers`;
      await customer.gotoWeb(offersPath);
      // Scoped to the offer card: the page header carries the request's own
      // reference under the same class, and it has no timestamp in it.
      const card = customer.page.locator('.cdash-offer .cdash-offer-sub').first();
      await expect(card).toBeVisible();
      const clientText = (await card.innerText()).trim();

      expect(clientText).toContain(expected);
      if (hostReading !== expected) {
        expect(clientText).not.toContain(hostReading);
      }

      // ---- 2. the detail screen the e-mail button actually opens ------------
      await customer.gotoWeb(`${offersPath}/${offerId}`);
      await expect(customer.page.getByTestId('offer-status')).toBeVisible();
      await assertNoErrorScreen(customer.page);

      // Give React the chance to report a mismatch before asserting it did not.
      // This is the SSR-equals-client half: a server that had written a
      // different hour into the HTML would have been caught here.
      await customer.page.waitForTimeout(500);
      expect(hydrationErrors, hydrationErrors.join('\n')).toEqual([]);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });
});
