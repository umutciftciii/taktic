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
import {
  acceptOffer,
  approveRequest,
  createRequest,
  readProviderOfferId,
  submitOffer,
} from '../src/journeys';
import {
  contactSharingRuntime,
  E2E_DISCLOSURE_VERSION,
  primaryRuntime,
} from '../src/runtime';

/**
 * Scenario 6 — contact sharing, both ways.
 *
 * CONTACT_SHARING_ENABLED is read per call from the API's environment, so one
 * process cannot represent both sides of it. The suite therefore drives the
 * shipped default on the primary stack and the same code with the flag on
 * against a third one (see src/runtime.ts), which is what makes "the difference
 * is the flag, not the fixture" a claim a reader can check.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;

test.describe('contact sharing', () => {
  test('flag off: matching completes and no contact details appear anywhere', async ({
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

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const values = requestFormValues(location, customerAccount.name);

      // The acknowledgement is not even offered while the feature is off.
      await customer.gotoWeb(`/categories/${category.slug}`);
      await expect(customer.page.getByTestId('contact-disclosure-accept')).toHaveCount(0);

      const requestId = await createRequest(customer, category, values);
      const stored = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(stored.contactDisclosureAcceptedAt).toBeNull();
      expect(stored.contactDisclosureVersion).toBeNull();

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);

      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await submitOffer(provider, {
        providerId: providerAccount.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1300.00',
        message: 'Bu hafta başlayabiliriz.',
      });
      const offerId = await readProviderOfferId(provider, providerAccount.id, requestId);

      // Matching itself is untouched by this feature.
      await acceptOffer(customer, requestId, offerId);
      expect(
        (await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } })).status,
      ).toBe('MATCHED');
      expect(await prisma().contactRevealEvent.count({ where: { requestId } })).toBe(0);

      // Neither screen grows a contact section, and neither leaks the other
      // side's details in passing.
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('matched-contact')).toHaveCount(0);
      const customerBody = await customer.page.locator('body').innerText();
      expect(customerBody).not.toContain(providerAccount.email);
      await assertNoErrorScreen(customer.page);

      await provider.gotoWeb(`/providers/${providerAccount.id}/offers/${offerId}`);
      await expect(provider.page.getByTestId('matched-contact')).toHaveCount(0);
      const providerBody = await provider.page.locator('body').innerText();
      expect(providerBody).not.toContain(values.customerPhone);
      expect(providerBody).not.toContain(values.customerEmail);
      await assertNoErrorScreen(provider.page);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });

  test('flag on: the two matched parties see each other, and nobody else does', async ({
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
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const values = requestFormValues(location, customerAccount.name);

      // ---- the form asks for the acknowledgement, and links the text -----
      await customer.gotoWeb(`/categories/${category.slug}`);
      await expect(customer.page.getByTestId('contact-disclosure-accept')).toBeVisible();
      await expect(customer.page.getByTestId('contact-disclosure-link')).toHaveAttribute(
        'href',
        /^https:\/\//,
      );

      const requestId = await createRequest(customer, category, values);
      const stored = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(stored.contactDisclosureVersion).toBe(E2E_DISCLOSURE_VERSION);
      expect(stored.contactDisclosureAcceptedAt).not.toBeNull();

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

      // ---- nothing is open before the acceptance ------------------------
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('matched-contact')).toHaveCount(0);

      await acceptOffer(customer, requestId, winningOfferId);

      // ---- one audit row, consistent with the match ---------------------
      const events = await prisma().contactRevealEvent.findMany({ where: { requestId } });
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.offerId).toBe(winningOfferId);
      expect(event.providerId).toBe(winnerAccount.id);
      expect(event.customerUserId).toBe(customerAccount.id);
      expect(event.disclosureVersion).toBe(E2E_DISCLOSURE_VERSION);

      // ---- the customer sees the provider they chose --------------------
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      const contactCard = customer.page.getByTestId('matched-contact');
      await expect(contactCard).toBeVisible();
      await expect(contactCard.getByTestId('matched-contact-name')).toHaveText(
        winnerAccount.businessName,
      );
      await expect(contactCard.getByTestId('matched-contact-phone')).toBeVisible();
      await assertNoErrorScreen(customer.page);

      // …and only that one. The losing provider's business name is still on the
      // page — the customer has always seen who offered — but the reveal added
      // no way to reach them.
      const customerBody = await customer.page.locator('body').innerText();
      expect(customerBody).not.toContain(loserAccount.email);
      const loserProfile = await prisma().providerProfile.findUniqueOrThrow({
        where: { id: loserAccount.id },
      });
      expect(customerBody).not.toContain(loserProfile.phone);

      // ---- the chosen provider sees the customer ------------------------
      await winner.gotoWeb(`/providers/${winnerAccount.id}/offers/${winningOfferId}`);
      const winnerCard = winner.page.getByTestId('matched-contact');
      await expect(winnerCard).toBeVisible();
      await expect(winnerCard.getByTestId('matched-contact-phone')).toHaveText(
        values.customerPhone,
      );
      await assertNoErrorScreen(winner.page);

      // ---- and the losing provider sees nothing at all -------------------
      await loser.gotoWeb(`/providers/${loserAccount.id}/offers/${losingOfferId}`);
      await expect(loser.page.getByTestId('matched-contact')).toHaveCount(0);
      const loserBody = await loser.page.locator('body').innerText();
      expect(loserBody).not.toContain(values.customerPhone);
      expect(loserBody).not.toContain(values.customerEmail);
      expect(loserBody).not.toContain(winnerAccount.businessName);
      await assertNoErrorScreen(loser.page);

      // ---- the operator sees the audit, with no new action ---------------
      await admin.gotoAdmin(`/requests/${requestId}`);
      const audit = admin.page.getByTestId('contact-reveal-audit');
      await expect(audit).toBeVisible();
      await expect(audit).toContainText(E2E_DISCLOSURE_VERSION);
      for (const forbidden of ['Yeniden paylaş', 'Paylaşımı sil', 'Paylaşımı düzenle']) {
        await expect(admin.page.getByRole('button', { name: forbidden })).toHaveCount(0);
      }
      await assertNoErrorScreen(admin.page);
    } finally {
      await Promise.all([customer.close(), admin.close(), winner.close(), loser.close()]);
    }
  });

  test('flag on: a request cannot be sent without the acknowledgement', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();

    const customer = await Actor.open(browser, 'customer', contactSharingRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const values = requestFormValues(location, customerAccount.name);

      await customer.gotoWeb(`/categories/${category.slug}`);
      const form = customer.page.locator('form.form-card');
      await form.locator('input[name="customerName"]').fill(values.customerName);
      await form.locator('input[name="customerPhone"]').fill(values.customerPhone);
      await form.locator('input[name="customerEmail"]').fill(values.customerEmail);
      await form.locator('input[name="city"]').fill(values.city);
      await form.locator('input[name="district"]').fill(values.district);
      await form.locator('textarea[name="description"]').fill(values.description);

      // Left unticked on purpose.
      await customer.page.getByRole('button', { name: 'Talebi Gönder' }).click();

      // Refused in place, with the checkbox still on screen — not a crash, and
      // not a request that quietly went through.
      await expect(customer.page).not.toHaveURL(/\/requests\/success/);
      await expect(customer.page.getByTestId('contact-disclosure-accept')).toBeVisible();
      await assertNoErrorScreen(customer.page);

      expect(
        await prisma().serviceRequest.count({ where: { district: location.district } }),
      ).toBe(0);
    } finally {
      await customer.close();
    }
  });
});
