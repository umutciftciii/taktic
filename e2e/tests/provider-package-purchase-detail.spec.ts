import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import { createCategory, createOfferPackage, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * BUG-OPS-002 — the provider's package purchase detail, opened for a purchase
 * that is not the viewer's.
 *
 * The API has always answered correctly: 404 for a purchase id that is not
 * this provider's or does not exist, 403 for another provider's panel. The
 * screen called `apiFetch` bare, so either answer became an unhandled
 * rejection in a server component — the error boundary and an HTTP 500
 * (CMP-007 finding). It now goes through `fetchOrNotFound`: every one of those
 * cases is the same HTTP 404 with the same not-found screen, and nothing on the
 * page tells a foreign purchase apart from one that was never issued. The
 * owner's own detail still renders as before.
 */

const UNKNOWN_ID = 'c000000000000000000000000';

/**
 * WebKit logs one of these for every `<Link>` prefetch of the page being left
 * that a `page.goto` cancels. They come from the previous document tearing
 * down, not from the page under test, so they are the only console errors
 * ignored; an error boundary or anything else still fails the test.
 */
const ABORTED_PREFETCH = /^Failed to fetch RSC payload for \S+\. Falling back to browser navigation\. TypeError: Load failed$/;

/** Strings that only appear when a framework internal has reached the page. */
const DEV_INTERNALS = ['nextjs-portal', 'webpack-internal', 'rsc://'];

async function paidOfferPurchase(providerId: string) {
  const pkg = await createOfferPackage({ type: 'ONE_TIME_CREDITS', name: 'E2E Detay Paketi', creditAmount: 10 });
  return prisma().packagePurchase.create({
    data: {
      providerId,
      kind: 'OFFER_PACKAGE',
      packageId: pkg.id,
      status: 'PAID',
      paidAt: new Date(),
      creditAmountSnapshot: 10,
      priceAmountSnapshot: 149_900,
      currencySnapshot: 'TRY',
      packageNameSnapshot: pkg.name,
      paymentProvider: 'mock',
    },
  });
}

/**
 * Opens a path and insists on a quiet 404: the status on the wire, the shared
 * not-found screen, no framework internals, and no console error from an
 * error boundary. Returns what a viewer could compare between two refusals.
 */
async function expectQuiet404(page: Page, url: string) {
  const consoleErrors: string[] = [];
  const onConsole = (message: { type(): string; text(): string }) => {
    // The browser reports the document's own 404 as a failed resource; that
    // is the status this test asks for, not an error the page raised.
    const text = message.text();
    if (message.type() === 'error' && !/Failed to load resource: .*404/.test(text) && !ABORTED_PREFETCH.test(text)) {
      consoleErrors.push(text);
    }
  };
  page.on('console', onConsole);
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    expect(response?.status(), `${url} must answer 404`).toBe(404);
    await expectNotFoundScreen(page);
    const html = await page.content();
    for (const internal of DEV_INTERNALS) {
      expect(html, `${url} must not surface "${internal}"`).not.toContain(internal);
    }
    expect(consoleErrors, `${url} must not log an error`).toEqual([]);
    // No provider shell around the refusal: it would carry a credit balance.
    await expect(page.locator('.pdash-credit-value')).toHaveCount(0);
    return { html, main: await page.locator('main').innerHTML(), text: await page.locator('body').innerText() };
  } finally {
    page.off('console', onConsole);
  }
}

test.describe('provider package purchase detail', () => {
  test('own purchase 200; a foreign, an unknown and another panel’s purchase are the same quiet 404', async ({ browser }) => {
    const category = await createCategory(2);
    const location = uniqueLocation();
    const owner = await createProvider({ categoryId: category.id, location, credits: 4 });
    const outsider = await createProvider({ categoryId: category.id, location, credits: 2 });
    const purchase = await paidOfferPurchase(owner.id);

    const ownerActor = await Actor.open(browser, 'owner-provider', primaryRuntime);
    const outsiderActor = await Actor.open(browser, 'outsider-provider', primaryRuntime);

    try {
      // ---- the owner still sees their purchase --------------------------------
      await ownerActor.loginToWeb(owner.email, owner.password);
      const own = await ownerActor.page.goto(
        ownerActor.webUrl(`/providers/${owner.id}/package-purchases/${purchase.id}`),
        { waitUntil: 'domcontentloaded' },
      );
      expect(own?.status()).toBe(200);
      await assertNoErrorScreen(ownerActor.page);
      await expect(ownerActor.page.getByRole('heading', { name: purchase.packageNameSnapshot, exact: true })).toBeVisible();
      await expect(ownerActor.page.getByTestId('purchase-status')).toBeVisible();

      // ---- the outsider: foreign purchase in their own panel, an unknown id,
      //      and the owner's panel — one and the same 404 -----------------------
      await outsiderActor.loginToWeb(outsider.email, outsider.password);
      const page = outsiderActor.page;
      const foreign = await expectQuiet404(page, outsiderActor.webUrl(`/providers/${outsider.id}/package-purchases/${purchase.id}`));
      const unknown = await expectQuiet404(page, outsiderActor.webUrl(`/providers/${outsider.id}/package-purchases/${UNKNOWN_ID}`));
      const otherPanel = await expectQuiet404(page, outsiderActor.webUrl(`/providers/${owner.id}/package-purchases/${purchase.id}`));
      await expectQuiet404(page, outsiderActor.webUrl(`/providers/${outsider.id}/package-purchases/not-an-id`));

      // Identical to a viewer: same text, same markup once the id each URL
      // carried is set aside.
      const masked = (value: string, id: string) => value.split(id).join('<id>');
      expect(foreign.text).toBe(unknown.text);
      expect(masked(foreign.main, purchase.id)).toBe(masked(unknown.main, UNKNOWN_ID));
      expect(otherPanel.text).toBe(unknown.text);

      // Nothing of the owner's purchase anywhere in the refusals.
      for (const refusal of [foreign, unknown, otherPanel]) {
        expect(refusal.html).not.toContain(purchase.packageNameSnapshot);
        expect(refusal.html).not.toContain(owner.businessName);
        expect(refusal.text).not.toMatch(/₺|1\.499|Paket Satın Alma/);
        expect(refusal.text.toLowerCase()).not.toMatch(/forbidden|not found|package purchase|provider access/);
      }
    } finally {
      await ownerActor.close();
      await outsiderActor.close();
    }
  });
});
