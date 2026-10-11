import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  createStaffAdmin,
  prisma,
  uniqueLocation,
  type SeededCategory,
  type SeededCustomer,
  type SeededProvider,
} from '../src/fixtures';
import { acceptOffer, istanbulDay } from '../src/journeys';
import { seedOffer } from '../src/offer-fixtures';
import { seedCustomerRequest } from '../src/request-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * REL-002 Faz 4 — incident adjudication and provider reliability, on real
 * screens.
 *
 *   1. customer reports → the provider sees the incident (no customer detail)
 *      and answers → a staff admin confirms (and has no correction) → the
 *      provider's reliability card counts it → a SUPER_ADMIN corrects it to
 *      DISMISSED → the count drops, both decisions stay in the timeline.
 *   2. a dismissal leaves the exclusion and the reopened request as they were.
 *   3. three confirmations → ADMIN_REVIEW_REQUIRED, one review in the queue,
 *      acknowledged and resolved.
 *
 * The service-issue switch is an operations setting in the shared database;
 * each case turns it on to let the customer report, and the suite turns it off
 * at the end (it ships off).
 */

const CATEGORY_COST = 2;

async function setServiceIssues(enabled: boolean) {
  await prisma().operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48, serviceIssueReportingEnabled: enabled },
    update: { serviceIssueReportingEnabled: enabled },
  });
}

test.afterAll(async () => {
  await setServiceIssues(false);
});

/**
 * One failed match against `provider`, through the customer's own screens:
 * seeded request and offer, accepted and reported on the web. Returns the
 * incident the report wrote.
 */
async function failedMatch(
  customer: Actor,
  options: { customer: SeededCustomer; provider: SeededProvider; category: SeededCategory; location: ReturnType<typeof uniqueLocation> },
) {
  const request = await seedCustomerRequest({
    customerId: options.customer.id,
    categoryId: options.category.id,
    location: options.location,
    status: 'APPROVED',
    phoneVerifiedAt: new Date(),
    content: 'empty',
  });
  const offer = await seedOffer({ requestId: request.id, providerId: options.provider.id, status: 'SUBMITTED' });
  await acceptOffer(customer, request.id, offer.id);
  await prisma().offer.update({
    where: { id: offer.id },
    data: {
      estimatedStartDate: new Date(`${istanbulDay(-2)}T00:00:00.000Z`),
      estimatedCompletionDate: new Date(`${istanbulDay(3)}T00:00:00.000Z`),
    },
  });
  await customer.gotoWeb(`/requests/${request.id}/offers`);
  await customer.page.getByTestId('service-issue-open').click();
  const dialog = customer.page.getByTestId('service-issue-dialog');
  await dialog.getByTestId('service-issue-reason-PROVIDER_NO_SHOW').click();
  await dialog.getByTestId('service-issue-submit').click();
  await expect(customer.page.getByTestId('service-issue-outcome')).toBeVisible();
  const incident = await prisma().providerServiceIncident.findFirstOrThrow({
    where: { offerId: offer.id },
    select: { id: true, incidentNumber: true },
  });
  return { requestId: request.id, offerId: offer.id, ...incident };
}

async function decide(page: Page, decision: 'confirm' | 'dismiss', rationale: string) {
  await page.getByTestId('incident-rationale').fill(rationale);
  await page.getByTestId(`incident-${decision}`).click();
  await page.locator('dialog[open] [data-testid=incident-decision-submit]').click();
  await expect(page.getByTestId('service-incident-status')).toHaveText(decision === 'confirm' ? 'Doğrulandı' : 'Reddedildi');
  await assertNoErrorScreen(page);
}

test.describe('incident adjudication and provider reliability (REL-002 Faz 4)', () => {
  test('provider answers, staff confirms, the card counts it, a SUPER_ADMIN corrects it', async ({ browser }) => {
    await setServiceIssues(true);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const providerAccount = await createProvider({ categoryId: category.id, location, credits: 10 });
    const staffAccount = await createStaffAdmin(['SERVICE_INCIDENTS_READ', 'SERVICE_INCIDENTS_ADJUDICATE']);
    const superAccount = await createAdmin();

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);
    const staff = await Actor.open(browser, 'staff', primaryRuntime);
    const root = await Actor.open(browser, 'super-admin', primaryRuntime);
    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const failed = await failedMatch(customer, { customer: customerAccount, provider: providerAccount, category, location });
      const request = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: failed.requestId },
        select: { customerName: true, customerPhone: true, customerEmail: true },
      });

      // The provider: the incident, its own words to write, nothing about the customer.
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb(`/providers/${providerAccount.id}/aksakliklar`);
      await expect(provider.page.getByTestId('incident-row')).toHaveCount(1);
      await expect(provider.page.getByTestId('incident-status')).toHaveText('Bildirildi');
      await provider.page.getByTestId('incident-row').getByRole('link').first().click();
      await expect(provider.page).toHaveURL(new RegExp(`/aksakliklar/${failed.id}$`));
      await expect(provider.page.getByTestId('incident-number')).toBeVisible();
      const body = await provider.page.locator('body').innerText();
      for (const secret of [request.customerName, request.customerPhone, request.customerEmail, customerAccount.email]) {
        if (secret) expect(body).not.toContain(secret);
      }
      expect(body.toLowerCase()).not.toContain('strike');
      await provider.page.getByTestId('incident-response-input').fill('Araç arızası yüzünden gelemedim, müşteriye haber veremedim.');
      await provider.page.getByTestId('incident-response-submit').click();
      await expect(provider.page.getByTestId('incident-response-text')).toContainText('Araç arızası');
      await expect(provider.page.getByTestId('incident-status')).toHaveText('Hizmet veren yanıtladı');

      // A staff admin confirms; there is no correction for them.
      await staff.loginToAdmin(staffAccount.email, staffAccount.password);
      await staff.gotoAdmin('/service-incidents');
      await expect(staff.page.getByTestId('service-incident-row').filter({ hasText: failed.incidentNumber })).toBeVisible();
      await staff.gotoAdmin(`/service-incidents/${failed.id}`);
      await expect(staff.page.getByText('Otomatik kredi iadesi yok').first()).toBeVisible();
      await expect(staff.page.getByText('Araç arızası yüzünden gelemedim')).toBeVisible();
      await decide(staff.page, 'confirm', 'Hizmet veren gelmediğini kendisi kabul etti.');
      await expect(staff.page.getByTestId('incident-correct')).toHaveCount(0);
      await expect(staff.page.getByTestId('adjudication-entry')).toHaveCount(1);

      // The provider sees the outcome in safe words, not the rationale.
      await provider.page.reload();
      await expect(provider.page.getByTestId('incident-status')).toHaveText('Doğrulandı');
      await expect(provider.page.getByTestId('incident-outcome')).toBeVisible();
      await expect(provider.page.locator('body')).not.toContainText('kendisi kabul etti');

      // The reliability card counts the confirmation.
      await root.loginToAdmin(superAccount.email, superAccount.password);
      await root.gotoAdmin(`/providers/${providerAccount.id}`);
      const card = root.page.getByTestId('provider-reliability-card');
      await expect(card.getByTestId('reliability-confirmed-count')).toHaveText('1');
      await expect(card.getByTestId('reliability-level')).toHaveText('Normal');

      // The SUPER_ADMIN corrects it; both decisions stay on record.
      await root.gotoAdmin(`/service-incidents/${failed.id}`);
      await root.page.getByTestId('incident-rationale').fill('Yeni belge: müşteri randevuyu kendisi iptal etmiş.');
      await root.page.getByTestId('incident-correct').click();
      await root.page.locator('dialog[open] [data-testid=incident-decision-submit]').click();
      await expect(root.page.getByTestId('service-incident-status')).toHaveText('Reddedildi');
      await expect(root.page.getByTestId('adjudication-entry')).toHaveCount(2);
      await expect(root.page.locator('[data-testid=adjudication-entry][data-effective=true]')).toHaveCount(1);
      await root.gotoAdmin(`/providers/${providerAccount.id}`);
      await expect(root.page.getByTestId('provider-reliability-card').getByTestId('reliability-confirmed-count')).toHaveText('0');

      const chain = await prisma().providerIncidentAdjudication.findMany({
        where: { incidentId: failed.id },
        orderBy: { sequence: 'asc' },
        select: { kind: true, decision: true },
      });
      expect(chain).toEqual([
        { kind: 'INITIAL', decision: 'CONFIRMED' },
        { kind: 'CORRECTION', decision: 'DISMISSED' },
      ]);
    } finally {
      await Promise.all([customer.close(), provider.close(), staff.close(), root.close()]);
    }
  });

  test('a dismissal keeps the exclusion and leaves the reopened request alone', async ({ browser }) => {
    await setServiceIssues(true);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const providerAccount = await createProvider({ categoryId: category.id, location, credits: 10 });
    const adminAccount = await createAdmin();

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const failed = await failedMatch(customer, { customer: customerAccount, provider: providerAccount, category, location });
      const before = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: failed.requestId },
        select: { status: true, currentRoundId: true },
      });

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/service-incidents/${failed.id}`);
      await decide(admin.page, 'dismiss', 'Müşteri beyanı belgeyle desteklenmedi.');

      expect(
        await prisma().serviceRequest.findUniqueOrThrow({ where: { id: failed.requestId }, select: { status: true, currentRoundId: true } }),
      ).toEqual(before);
      expect(await prisma().serviceRequestProviderExclusion.count({ where: { incidentId: failed.id } })).toBe(1);

      // The excluded provider still cannot open the request.
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb(`/providers/${providerAccount.id}/requests/${failed.requestId}`);
      await expectNotFoundScreen(provider.page);
      // The customer's request is still open for offers.
      await customer.gotoWeb(`/requests/${failed.requestId}/offers`);
      await assertNoErrorScreen(customer.page);
      await expect(customer.page.getByTestId('previous-match-issue')).toBeVisible();
    } finally {
      await Promise.all([customer.close(), provider.close(), admin.close()]);
    }
  });

  test('three confirmations: review required, one review in the queue, acknowledged and resolved', async ({ browser }) => {
    await setServiceIssues(true);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const providerAccount = await createProvider({ categoryId: category.id, location, credits: 10 });
    const adminAccount = await createAdmin();

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      for (let i = 0; i < 3; i += 1) {
        const failed = await failedMatch(customer, { customer: customerAccount, provider: providerAccount, category, location });
        await admin.gotoAdmin(`/service-incidents/${failed.id}`);
        await decide(admin.page, 'confirm', `Doğrulanmış aksaklık ${i + 1}: hizmet verilmedi.`);
      }

      await admin.gotoAdmin(`/providers/${providerAccount.id}`);
      const card = admin.page.getByTestId('provider-reliability-card');
      await expect(card.getByTestId('reliability-confirmed-count')).toHaveText('3');
      await expect(card.getByTestId('reliability-level')).toHaveText('Yönetici incelemesi gerekli');
      await expect(admin.page.getByTestId('reliability-review-banner')).toBeVisible();

      await admin.gotoAdmin('/provider-reliability');
      const row = admin.page.getByTestId('reliability-row').filter({ hasText: providerAccount.businessName });
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('reliability-level')).toHaveText('Yönetici incelemesi gerekli');
      await row.getByTestId('review-acknowledge').click();
      await admin.page.locator('dialog[open]').getByRole('button', { name: 'Evet, üstlen' }).click();
      await expect(admin.page.getByText('İnceleme üstlenildi.')).toBeVisible();
      await expect(row).toContainText('Üstlenildi');
      const note = row.getByTestId('review-note');
      await expect(async () => {
        await note.fill('Hizmet verenle görüşüldü, takipte kalacak.');
        await expect(note).toHaveValue('Hizmet verenle görüşüldü, takipte kalacak.', { timeout: 500 });
      }).toPass();
      await row.getByTestId('review-resolve').click();
      await admin.page.locator('dialog[open]').getByRole('button', { name: 'Evet, sonuçlandır' }).click();
      await assertNoErrorScreen(admin.page);

      await expect
        .poll(() =>
          prisma().providerReliabilityReview.findMany({
            where: { providerId: providerAccount.id },
            select: { status: true, note: true },
          }),
        )
        .toEqual([{ status: 'RESOLVED', note: 'Hizmet verenle görüşüldü, takipte kalacak.' }]);
      expect(
        (await prisma().providerProfile.findUniqueOrThrow({ where: { id: providerAccount.id }, select: { status: true } })).status,
      ).toBe('APPROVED');
    } finally {
      await Promise.all([customer.close(), admin.close()]);
    }
  });
});
