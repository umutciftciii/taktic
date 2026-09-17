import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import type { Page } from '@playwright/test';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  isAutoPublishEnabled,
  prisma,
  requestFormValues,
  setAutoPublish,
  uniqueLocation,
} from '../src/fixtures';
import {
  approveRequest,
  createRequest,
  expectApprovalBlockedByPhoneGate,
  matchingRequestIds,
  submitOffer,
} from '../src/journeys';
import { waitForLatestSmsCode } from '../src/outbox';
import { phoneGateRuntime, primaryRuntime } from '../src/runtime';

/**
 * Scenario 2 — REQUIRE_PHONE_VERIFICATION, both ways.
 *
 * The flag is read per call from the API's environment, so the two sides cannot
 * coexist in one process. The suite therefore runs a second full stack with the
 * gate on (see src/runtime.ts) and drives the same journey through it, then
 * repeats the decisive step against the shipped default to show the difference
 * is the flag and not the fixture.
 *
 * The one-time code is read from the API's test SMS transport. It is never
 * returned over HTTP and only a bcrypt hash reaches the database, so there is no
 * other honest way for a browser test to complete the verification screen.
 */

const CATEGORY_COST = 3;
const STARTING_CREDITS = 8;

/** Nothing may make the document wider than the window it is in. */
async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${label}: the page is ${overflow}px wider than the viewport`).toBeLessThanOrEqual(0);
}

/** The element is inside the viewport on both sides — not merely clipped by an ancestor. */
async function expectWithinViewport(page: Page, selector: string, label: string) {
  const box = await page.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
  });
  const limit = page.viewportSize()?.width ?? 0;
  expect(box.width, `${label}: "${selector}" has no width`).toBeGreaterThan(0);
  expect(box.left, `${label}: "${selector}" starts off the left edge`).toBeGreaterThanOrEqual(-1);
  expect(box.right, `${label}: "${selector}" ends ${box.right - limit}px past the right edge`).toBeLessThanOrEqual(
    limit + 1,
  );
}

/** No button inside the container has its label cut off by its own box. */
async function expectNoClippedButtons(page: Page, selector: string, label: string) {
  const clipped = await page.locator(selector).first().evaluate((element) =>
    Array.from(element.querySelectorAll('button'))
      .filter((button) => button.scrollWidth > button.clientWidth + 1)
      .map((button) => button.textContent?.trim() ?? ''),
  );
  expect(clipped, `${label}: clipped button labels`).toEqual([]);
}

test.describe('phone verification gate', () => {
  test.afterEach(async () => {
    await setAutoPublish(false);
  });

  test('gate on: an unverified request is invisible until the customer verifies', async ({
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

    const customer = await Actor.open(browser, 'customer', phoneGateRuntime);
    const admin = await Actor.open(browser, 'admin', phoneGateRuntime);
    const provider = await Actor.open(browser, 'provider', phoneGateRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const values = requestFormValues(location, customerAccount.name);
      const requestId = await createRequest(customer, category, values);

      // A fresh request carries no verification.
      expect(
        (await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } }))
          .phoneVerifiedAt,
      ).toBeNull();

      // ---- the gate refuses approval ------------------------------------
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await expectApprovalBlockedByPhoneGate(admin, requestId);

      // ---- and the provider cannot reach it at all ----------------------
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      expect(await matchingRequestIds(provider, providerAccount.id)).toEqual([]);

      // Not even with the URL in hand: the API answers with the same 404 it
      // gives for a request that does not exist, so nothing is disclosed.
      await provider.gotoWeb(`/providers/${providerAccount.id}/requests/${requestId}`);
      await expectNotFoundScreen(provider.page);
      // With no request screen there is no offer form, and no offer exists.
      await expect(provider.page.getByRole('button', { name: 'Teklifi Gönder' })).toHaveCount(0);
      expect(await prisma().offer.count({ where: { requestId } })).toBe(0);

      // ---- the customer verifies ----------------------------------------
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await customer.page.getByRole('button', { name: 'Doğrulama kodu gönder' }).click();
      await expect(customer.page).toHaveURL(/verification=ok/);

      const code = await waitForLatestSmsCode(values.customerPhone);
      await customer.page.locator('input[name="code"]').fill(code);
      // Exact: "Doğrulama kodu gönder" also contains "Doğrula".
      await customer.page.getByRole('button', { name: 'Doğrula', exact: true }).click();
      // Both the send-code and the verify actions redirect to the same
      // `?verification=ok` shape, so the URL from the send-code step above
      // already satisfies this assertion before the verify round-trip lands —
      // asserting on it here would pass instantly instead of waiting for the
      // server action to finish. Poll the write the verify call performs
      // instead: once it is set, the round trip genuinely completed.
      await expect
        .poll(
          async () =>
            (await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } }))
              .phoneVerifiedAt,
          {
            message: 'phoneVerifiedAt should be set once the verify action completes',
            timeout: 15_000,
          },
        )
        .not.toBeNull();
      await assertNoErrorScreen(customer.page);

      // The verification card is gone once the number is proven.
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByText('Telefon Doğrulama')).toHaveCount(0);
      expect(
        (await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } }))
          .phoneVerifiedAt,
      ).not.toBeNull();

      // ---- now the same admin action succeeds ---------------------------
      await approveRequest(admin, requestId);

      // ---- and the provider can find it and offer on it -----------------
      expect(await matchingRequestIds(provider, providerAccount.id)).toEqual([requestId]);
      await submitOffer(provider, {
        providerId: providerAccount.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '2100,00',
        message: 'Doğrulanmış talep için teklifimiz.',
      });

      expect(await prisma().offer.count({ where: { requestId } })).toBe(1);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });

  test('gate on + instant publish: the receipt asks for the phone, and verifying publishes with no operator', async ({
    browser,
  }) => {
    // The switch is one row shared by every runtime; every other spec depends
    // on it being OFF, and the `afterEach` below puts it back.
    expect(await isAutoPublishEnabled()).toBe(false);
    await setAutoPublish(true);

    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });

    // Two browsers: the customer who must verify, and the provider who must
    // not see anything until they do. No admin actor at all — nobody
    // approves this request.
    const customer = await Actor.open(browser, 'customer', phoneGateRuntime);
    const provider = await Actor.open(browser, 'provider', phoneGateRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const values = requestFormValues(location, customerAccount.name);
      const requestId = await createRequest(customer, category, values);

      // ---- the receipt: verify, not "in review", not "published" ---------
      const receipt = customer.page.getByTestId('request-success');
      await expect(receipt).toHaveAttribute('data-variant', 'verify');
      await expect(customer.page.getByTestId('request-success-title')).toHaveText(
        'Telefonunuzu doğrulayın',
      );
      const receiptText = (await receipt.innerText()).toLowerCase();
      expect(receiptText, 'the verify receipt must not promise a review').not.toContain('ön incele');
      expect(receiptText, 'the verify receipt must not claim publication').not.toContain('yayınlandı');
      expect(receiptText).toContain('hizmet verenlere iletilir');
      // The CTA carries the request id and an anchor — no code, no token.
      await expect(customer.page.getByTestId('request-success-verify-cta')).toHaveAttribute(
        'href',
        `/requests/${requestId}/offers#telefon-dogrulama`,
      );

      const stored = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(stored.status).toBe('SUBMITTED');
      expect(stored.phoneVerifiedAt).toBeNull();
      expect(stored.approvedAt).toBeNull();

      // ---- the request page: the card is required, the rail says so ------
      await customer.page.getByTestId('request-success-verify-cta').click();
      await expect(customer.page).toHaveURL(new RegExp(`/requests/${requestId}/offers`));
      await expect(customer.page.getByTestId('request-status')).toHaveText('Gönderildi');
      const card = customer.page.getByTestId('phone-verification-card');
      await expect(card).toHaveAttribute('data-required', 'true');
      await expect(card.getByRole('heading', { name: 'Telefonunuzu doğrulayın' })).toBeVisible();
      await expect(customer.page.getByTestId('request-summary-body')).toContainText(
        'henüz hizmet verenlere iletilmedi',
      );
      const timeline = customer.page.getByTestId('request-timeline');
      await expect(timeline).toContainText('Telefon doğrulama');
      await expect(timeline).not.toContainText('Ön inceleme');

      // ---- the card and the rail fit every width the brief names ----------
      for (const width of [320, 768, 1440]) {
        await customer.page.setViewportSize({ width, height: 780 });
        await customer.gotoWeb(`/requests/${requestId}/offers`);
        await expectNoHorizontalOverflow(customer.page, `${width}px`);
        await expectWithinViewport(customer.page, '[data-testid="phone-verification-card"]', `${width}px`);
        await expectWithinViewport(customer.page, '[data-testid="request-timeline"]', `${width}px`);
        await expectNoClippedButtons(customer.page, '[data-testid="phone-verification-card"]', `${width}px`);
      }
      await customer.page.setViewportSize({ width: 1280, height: 780 });

      // ---- the provider cannot find it -----------------------------------
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      expect(await matchingRequestIds(provider, providerAccount.id)).toEqual([]);

      // ---- the customer verifies through the existing card ---------------
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await customer.page.getByRole('button', { name: 'Doğrulama kodu gönder' }).click();
      await expect(customer.page).toHaveURL(/verification=ok/);

      const code = await waitForLatestSmsCode(values.customerPhone);
      await customer.page.locator('input[name="code"]').fill(code);
      await customer.page.getByRole('button', { name: 'Doğrula', exact: true }).click();
      // Both actions redirect to the same `?verification=ok`; wait on the
      // write the verify performs, not on the URL.
      await expect
        .poll(
          async () =>
            (await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } })).status,
          { message: 'verifying should publish the request', timeout: 15_000 },
        )
        .toBe('APPROVED');
      await assertNoErrorScreen(customer.page);

      const published = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(published.phoneVerifiedAt).not.toBeNull();
      // Published by the verification itself: the same instant, and no
      // operator's hand on it.
      expect(published.approvedAt).toEqual(published.phoneVerifiedAt);
      expect(published.moderatedAt).toBeNull();

      // ---- now the page says so, and the card is gone --------------------
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('request-status')).toHaveText('Onaylandı');
      await expect(customer.page.getByTestId('phone-verification-card')).toHaveCount(0);
      await expect(customer.page.getByTestId('request-summary-body')).toContainText(
        'hizmet verenlere iletildi',
      );
      await expect(customer.page.getByTestId('request-timeline')).not.toContainText('Telefon doğrulama');

      // ---- and the provider finds it, without anyone approving it --------
      expect(await matchingRequestIds(provider, providerAccount.id)).toEqual([requestId]);

      // ---- one publication, one fan-out ----------------------------------
      // The verification booked exactly one message per recipient; the
      // delivery sweep runs in the background, so poll until it has run.
      await expect
        .poll(
          () =>
            prisma().notificationLog.count({
              where: { requestId, template: { in: ['request-available', 'request-published'] }, status: 'SENT' },
            }),
          { message: 'the fan-out should be delivered once', timeout: 15_000 },
        )
        .toBe(2);
      expect(
        await prisma().notificationLog.count({
          where: { requestId, template: { in: ['request-available', 'request-published'] } },
        }),
      ).toBe(2);
    } finally {
      await Promise.all([customer.close(), provider.close()]);
    }
  });

  test('gate off: the same unverified request stays visible and offerable', async ({
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

    // Same fixtures, same steps — only the runtime differs.
    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const values = requestFormValues(location, customerAccount.name);
      const requestId = await createRequest(customer, category, values);

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      // No refusal here: with the gate off, approval never consults the phone.
      await approveRequest(admin, requestId);

      const stored = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      expect(stored.phoneVerifiedAt).toBeNull();
      expect(stored.status).toBe('APPROVED');

      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      expect(await matchingRequestIds(provider, providerAccount.id)).toEqual([requestId]);

      await submitOffer(provider, {
        providerId: providerAccount.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1250,00',
        message: 'Doğrulama zorunlu değilken de teklif verebiliriz.',
      });

      expect(await prisma().offer.count({ where: { requestId } })).toBe(1);

      // The customer is still invited to verify — offered, never demanded.
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByText('Telefon Doğrulama')).toBeVisible();
      await assertNoErrorScreen(customer.page);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });
});
