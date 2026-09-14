import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import {
  countRefundTransactions,
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  creditBalance,
  openReportCount,
  prisma,
  requestFormValues,
  uniqueLocation,
  type SeededProvider,
} from '../src/fixtures';
import {
  approveRequest,
  createRequest,
  matchingRequestIds,
  openRequestAsProvider,
  readProviderOfferId,
  reopenRequest,
  reportRequest,
  resolveReports,
  submitOffer,
} from '../src/journeys';
import { emailCountFor } from '../src/outbox';
import { primaryRuntime } from '../src/runtime';

/**
 * A provider reports a request; an operator decides.
 *
 * Two decisions, two tests. "Uygun bulundu" closes the report and changes
 * nothing else — the request stays in front of the same providers. "Talebi
 * kaldır" takes the request down, closes every live offer on it and gives
 * every spent credit back, tells the customer why, and can be undone from
 * the same screen — without reviving the offers it closed.
 *
 * The API suite proves each of those rules on its own. What only a browser
 * can show is that the six screens involved — the provider's request page,
 * their offer detail and matching list, the operator's queue and request
 * screen, the customer's requests board — agree with one another after each
 * decision, through real sessions and real server actions.
 *
 * Three providers, not two. The matching list never shows a provider a
 * request they already offered on, so whether the request is "still in front
 * of providers" can only be read off a provider who has not: the witness
 * matches the request and never offers. The two who did offer are what the
 * refund and the closed-offer screens are about.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;
const CLOSURE_NOTICE = 'Talep yayından kaldırıldı. Harcanan teklif krediniz iade edildi.';

/** The operator's queue row for one request. */
function queueRow(page: Page, requestId: string) {
  return page
    .getByTestId('report-queue-row')
    .filter({ has: page.locator(`a[href="/requests/${requestId}"]`) });
}

/**
 * An approved request with two live offers on it — what both decisions start
 * from. Returns everything the decision's assertions need.
 */
async function requestWithTwoOffers(
  actors: { customer: Actor; admin: Actor; reporter: Actor; bystander: Actor; witness: Actor },
  seed: {
    category: Awaited<ReturnType<typeof createCategory>>;
    customerAccount: Awaited<ReturnType<typeof createCustomer>>;
    adminAccount: Awaited<ReturnType<typeof createAdmin>>;
    reporterAccount: SeededProvider;
    bystanderAccount: SeededProvider;
    witnessAccount: SeededProvider;
    values: ReturnType<typeof requestFormValues>;
  },
) {
  const { customer, admin, reporter, bystander, witness } = actors;

  await customer.loginToWeb(seed.customerAccount.email, seed.customerAccount.password);
  const requestId = await createRequest(customer, seed.category, seed.values);

  await admin.loginToAdmin(seed.adminAccount.email, seed.adminAccount.password);
  await approveRequest(admin, requestId);

  await reporter.loginToWeb(seed.reporterAccount.email, seed.reporterAccount.password);
  await bystander.loginToWeb(seed.bystanderAccount.email, seed.bystanderAccount.password);
  await witness.loginToWeb(seed.witnessAccount.email, seed.witnessAccount.password);

  // The unique district means this list can only hold this request.
  expect(await matchingRequestIds(witness, seed.witnessAccount.id)).toEqual([requestId]);

  await submitOffer(reporter, {
    providerId: seed.reporterAccount.id,
    requestId,
    expectedCreditCost: CATEGORY_COST,
    priceAmount: '1500.00',
    message: 'Montaj ve ilk bakım dahil.',
  });
  await submitOffer(bystander, {
    providerId: seed.bystanderAccount.id,
    requestId,
    expectedCreditCost: CATEGORY_COST,
    priceAmount: '1750.00',
    message: 'Aynı gün montaj yapabiliriz.',
  });

  expect(await creditBalance(seed.reporterAccount.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
  expect(await creditBalance(seed.bystanderAccount.id)).toBe(STARTING_CREDITS - CATEGORY_COST);

  const reporterOfferId = await readProviderOfferId(reporter, seed.reporterAccount.id, requestId);
  const bystanderOfferId = await readProviderOfferId(
    bystander,
    seed.bystanderAccount.id,
    requestId,
  );

  return { requestId, reporterOfferId, bystanderOfferId };
}

test.describe('request report flow', () => {
  test('a dismissed report leaves the request where it was', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const reporterAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });
    const bystanderAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });
    const witnessAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const reporter = await Actor.open(browser, 'reporting-provider', primaryRuntime);
    const bystander = await Actor.open(browser, 'other-provider', primaryRuntime);
    const witness = await Actor.open(browser, 'witness-provider', primaryRuntime);

    try {
      const values = requestFormValues(location, customerAccount.name);
      const { requestId } = await requestWithTwoOffers(
        { customer, admin, reporter, bystander, witness },
        {
          category,
          customerAccount,
          adminAccount,
          reporterAccount,
          bystanderAccount,
          witnessAccount,
          values,
        },
      );

      // ---- the provider reports it --------------------------------------
      await reportRequest(reporter, reporterAccount.id, requestId, 'SPAM');
      expect(await openReportCount(requestId)).toBe(1);

      // Coming back, the page remembers: the badge, and no second button.
      await reporter.gotoWeb(`/providers/${reporterAccount.id}/requests/${requestId}`);
      await expect(reporter.page.getByTestId('report-received')).toHaveCount(1);
      await expect(reporter.page.getByTestId('report-request-button')).toHaveCount(0);

      // ---- the operator's queue counts it once --------------------------
      await admin.gotoAdmin('/requests/reports');
      const row = queueRow(admin.page, requestId);
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('report-count')).toHaveText('1');
      await expect(row.getByRole('link', { name: reporterAccount.businessName })).toBeVisible();
      await assertNoErrorScreen(admin.page);

      // ---- "Uygun bulundu" ----------------------------------------------
      await resolveReports(admin, requestId, 'DISMISSED');
      expect(await openReportCount(requestId)).toBe(0);
      await expect(admin.page.getByTestId('request-status')).toHaveText('Onaylandı');

      await admin.gotoAdmin('/requests/reports');
      await expect(queueRow(admin.page, requestId)).toHaveCount(0);

      // ---- nothing else moved -------------------------------------------
      // Still in front of providers: the one who has not offered still
      // matches it, and the one who reported it can still open it.
      expect(await matchingRequestIds(witness, witnessAccount.id)).toEqual([requestId]);
      await openRequestAsProvider(reporter, reporterAccount.id, requestId);
      await expect(reporter.page.getByTestId('report-received')).toHaveCount(1);
      await expect(reporter.page.getByTestId('offer-closure-notice')).toHaveCount(0);

      expect(await countRefundTransactions(reporterAccount.id)).toBe(0);
      expect(await countRefundTransactions(bystanderAccount.id)).toBe(0);
      expect(await creditBalance(reporterAccount.id)).toBe(STARTING_CREDITS - CATEGORY_COST);

      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('request-status')).toHaveText('Onaylandı');
      await expect(customer.page.getByRole('link', { name: 'Teklifi İncele' })).toHaveCount(2);
      await assertNoErrorScreen(customer.page);
    } finally {
      await Promise.all([
        customer.close(),
        admin.close(),
        reporter.close(),
        bystander.close(),
        witness.close(),
      ]);
    }
  });

  test('removing the request closes the offers, refunds both providers, and can be reopened', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const reporterAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });
    const bystanderAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });
    const witnessAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const reporter = await Actor.open(browser, 'reporting-provider', primaryRuntime);
    const bystander = await Actor.open(browser, 'other-provider', primaryRuntime);
    const witness = await Actor.open(browser, 'witness-provider', primaryRuntime);

    try {
      const values = requestFormValues(location, customerAccount.name);
      const { requestId, reporterOfferId, bystanderOfferId } = await requestWithTwoOffers(
        { customer, admin, reporter, bystander, witness },
        {
          category,
          customerAccount,
          adminAccount,
          reporterAccount,
          bystanderAccount,
          witnessAccount,
          values,
        },
      );

      await reportRequest(reporter, reporterAccount.id, requestId, 'SPAM', 'Deneme gibi görünüyor.');
      expect(await openReportCount(requestId)).toBe(1);

      // ---- "Talebi kaldır" ----------------------------------------------
      await resolveReports(admin, requestId, 'REQUEST_REMOVED');
      expect(await openReportCount(requestId)).toBe(0);

      const removed = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { status: true },
      });
      expect(removed.status).toBe('REJECTED');

      // ---- gone from the providers' list, and from the request URL ------
      expect(await matchingRequestIds(witness, witnessAccount.id)).toEqual([]);

      await witness.gotoWeb(`/providers/${witnessAccount.id}/requests/${requestId}`);
      await expectNotFoundScreen(witness.page);
      await reporter.gotoWeb(`/providers/${reporterAccount.id}/requests/${requestId}`);
      await expectNotFoundScreen(reporter.page);

      // ---- both offers closed, both credits back ------------------------
      for (const [actor, account, offerId] of [
        [reporter, reporterAccount, reporterOfferId],
        [bystander, bystanderAccount, bystanderOfferId],
      ] as const) {
        await actor.gotoWeb(`/providers/${account.id}/offers/${offerId}`);
        await expect(actor.page.getByTestId('offer-status')).toHaveText('Kapatıldı');
        await expect(actor.page.getByTestId('offer-closure-notice')).toHaveText(CLOSURE_NOTICE);
        await assertNoErrorScreen(actor.page);

        expect(await creditBalance(account.id)).toBe(STARTING_CREDITS);
        expect(await countRefundTransactions(account.id)).toBe(1);
      }

      const closedOffers = await prisma().offer.findMany({
        where: { requestId },
        select: { status: true, creditRefundedTransactionId: true },
      });
      expect(closedOffers).toHaveLength(2);
      for (const offer of closedOffers) {
        expect(offer.status).toBe('CANCELLED');
        expect(offer.creditRefundedTransactionId).not.toBeNull();
      }

      // ---- the customer is told, on screen and by mail ------------------
      await customer.gotoWeb('/requests/my');
      await expect(
        customer.page
          .locator(`[data-testid="request-card"][data-request-id="${requestId}"]`)
          .getByTestId('request-status'),
      ).toHaveText('Reddedildi');
      await assertNoErrorScreen(customer.page);

      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('request-status')).toHaveText('Reddedildi');
      await expect(customer.page.getByRole('link', { name: 'Teklifi İncele' })).toHaveCount(0);
      await expect(customer.page.getByTestId('offer-closed-note')).toHaveCount(2);
      await assertNoErrorScreen(customer.page);

      // The notice is sent after the decision commits; the request's own
      // contact address is the recipient, which is the one the form named.
      await expect
        .poll(() => emailCountFor(values.customerEmail, 'request-removed'), {
          message: 'the customer must be mailed once about the removal',
          timeout: 20_000,
          intervals: [100, 200, 500],
        })
        .toBe(1);

      // ---- the operator reopens it --------------------------------------
      await reopenRequest(admin, requestId);

      expect(await matchingRequestIds(witness, witnessAccount.id)).toEqual([requestId]);
      await openRequestAsProvider(witness, witnessAccount.id, requestId);

      await customer.gotoWeb('/requests/my');
      await expect(
        customer.page
          .locator(`[data-testid="request-card"][data-request-id="${requestId}"]`)
          .getByTestId('request-status'),
      ).toHaveText('Onaylandı');

      // Closed offers stay closed and refunds stay given: reopening puts the
      // request back, not the offers.
      await reporter.gotoWeb(`/providers/${reporterAccount.id}/offers/${reporterOfferId}`);
      await expect(reporter.page.getByTestId('offer-status')).toHaveText('Kapatıldı');
      await expect(reporter.page.getByTestId('offer-closure-notice')).toHaveText(CLOSURE_NOTICE);
      // The request page is back for the reporter too, and says the same
      // thing about their offer — no second offer form.
      await openRequestAsProvider(reporter, reporterAccount.id, requestId);
      await expect(reporter.page.getByTestId('offer-closure-notice')).toHaveText(CLOSURE_NOTICE);
      await expect(reporter.page.getByRole('button', { name: 'Teklifi Gönder' })).toHaveCount(0);
      expect(await creditBalance(reporterAccount.id)).toBe(STARTING_CREDITS);
      expect(await countRefundTransactions(reporterAccount.id)).toBe(1);
      expect(await countRefundTransactions(bystanderAccount.id)).toBe(1);

      // The queue records the history rather than reopening the report.
      expect(await openReportCount(requestId)).toBe(0);
      await admin.gotoAdmin('/requests/reports');
      await expect(queueRow(admin.page, requestId)).toHaveCount(0);
      await admin.gotoAdmin('/requests/reports?state=resolved');
      await expect(queueRow(admin.page, requestId).getByTestId('report-reopened')).toBeVisible();
      await assertNoErrorScreen(admin.page);
    } finally {
      await Promise.all([
        customer.close(),
        admin.close(),
        reporter.close(),
        bystander.close(),
        witness.close(),
      ]);
    }
  });
});
