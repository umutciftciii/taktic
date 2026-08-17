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

test.describe('phone verification gate', () => {
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
      await expect(customer.page).toHaveURL(/verification=ok/);
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
        priceAmount: '2100.00',
        message: 'Doğrulanmış talep için teklifimiz.',
      });

      expect(await prisma().offer.count({ where: { requestId } })).toBe(1);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
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
        priceAmount: '1250.00',
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
