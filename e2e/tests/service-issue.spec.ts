import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  prisma,
  requestFormValues,
  uniqueLocation,
  type SeededCategory,
  type SeededCustomer,
  type SeededProvider,
} from '../src/fixtures';
import {
  acceptOffer,
  approveRequest,
  createRequest,
  istanbulDay,
  matchingRequestIds,
  readProviderOfferId,
  submitOffer,
} from '../src/journeys';
import { seedCustomerRequest } from '../src/request-fixtures';
import { seedOffer } from '../src/offer-fixtures';
import { contactSharingRuntime, primaryRuntime } from '../src/runtime';

/**
 * REL-002 Faz 3 — the customer's service issue, on real screens.
 *
 *   1. marketplace: request → A offers → accepted → A no-show reported →
 *      Round 2 → B offers → accepted; A can no longer open, offer on or write
 *      about the request, B's match is live.
 *   2. a direct vitrin match that failed goes through the ordinary marketplace
 *      publish gate (moderation with auto-publish off).
 *   3. three failed matches → MATCH_REVIEW.
 *   4. the failed match's conversation stays readable, read-only.
 *   5. a legacy match without promised days is sent to support.
 *   6. with the switch off there is no call to action at all.
 *
 * The switch is an operations setting in the shared database; each case sets
 * it, and the suite turns it off again at the end (it ships off).
 */

const CATEGORY_COST = 2;

async function setServiceIssues(enabled: boolean, autoPublish = false) {
  await prisma().operationsSettings.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      unviewedOfferRefundWindowHours: 48,
      serviceIssueReportingEnabled: enabled,
      marketplaceAutoPublishEnabled: autoPublish,
    },
    update: { serviceIssueReportingEnabled: enabled, marketplaceAutoPublishEnabled: autoPublish },
  });
}

test.afterAll(async () => {
  await setServiceIssues(false);
});

/** The accepted offer's promised days, moved relative to today in Istanbul. */
async function promise(offerId: string, start: number | null, end: number | null) {
  await prisma().offer.update({
    where: { id: offerId },
    data: {
      estimatedStartDate: start === null ? null : new Date(`${istanbulDay(start)}T00:00:00.000Z`),
      estimatedCompletionDate: end === null ? null : new Date(`${istanbulDay(end)}T00:00:00.000Z`),
    },
  });
}

/** Opens the dialog, picks a reason, optionally writes a note and submits. */
async function reportIssue(page: Page, requestId: string, reason: string, note?: string) {
  await expect(page.getByTestId('service-issue-open')).toBeVisible();
  await page.getByTestId('service-issue-open').click();
  const dialog = page.getByTestId('service-issue-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId(`service-issue-reason-${reason}`).click();
  if (note) {
    await dialog.getByTestId('service-issue-note').fill(note);
  }
  await expect(dialog.getByTestId('service-issue-consequence')).toContainText('Bu işlem geri alınamaz.');
  await dialog.getByTestId('service-issue-submit').click();
  await expect(page).toHaveURL(new RegExp(`/requests/${requestId}/offers\\?issue=`));
  await expect(page.getByTestId('service-issue-outcome')).toBeVisible();
  await assertNoErrorScreen(page);
}

/** A matched request staged in the tables; the customer's screens are the subject. */
async function seededMatch(options: {
  customer: SeededCustomer;
  provider: SeededProvider;
  category: SeededCategory;
  location: ReturnType<typeof uniqueLocation>;
  start: number | null;
  end: number | null;
}) {
  const request = await seedCustomerRequest({
    customerId: options.customer.id,
    categoryId: options.category.id,
    location: options.location,
    status: 'APPROVED',
    phoneVerifiedAt: new Date(),
    content: 'empty',
  });
  const offer = await seedOffer({ requestId: request.id, providerId: options.provider.id, status: 'SUBMITTED' });
  await promise(offer.id, options.start, options.end);
  return { requestId: request.id, offerId: offer.id };
}

test.describe('customer service issue (REL-002 Faz 3)', () => {
  test('marketplace: A fails, Round 2 opens, B wins; A is shut out, B is live', async ({ browser }) => {
    await setServiceIssues(true);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const aAccount = await createProvider({ categoryId: category.id, location, credits: 10 });
    const bAccount = await createProvider({ categoryId: category.id, location, credits: 10 });

    const customer = await Actor.open(browser, 'customer', contactSharingRuntime);
    const admin = await Actor.open(browser, 'admin', contactSharingRuntime);
    const a = await Actor.open(browser, 'provider-a', contactSharingRuntime);
    const b = await Actor.open(browser, 'provider-b', contactSharingRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const requestId = await createRequest(customer, category, requestFormValues(location, customerAccount.name));
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);

      await a.loginToWeb(aAccount.email, aAccount.password);
      await b.loginToWeb(bAccount.email, bAccount.password);
      await submitOffer(a, {
        providerId: aAccount.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1500,00',
        message: 'Yarın geliyoruz.',
      });
      const offerA = await readProviderOfferId(a, aAccount.id, requestId);
      await acceptOffer(customer, requestId, offerA);

      // Before the start day only the provider's own cancellation is offered.
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('service-issue-open')).toHaveText(
        'Hizmet veren işi yapamayacağını bildirdi',
      );
      await expect(customer.page.getByTestId('service-issue-next-opens')).toBeVisible();

      // A conversation in Round 1, opened before anything went wrong.
      await customer.gotoWeb('/requests/matches');
      await customer.page.getByTestId('match-message-cta').first().click();
      await expect(customer.page).toHaveURL(/\/mesajlar\/[^/]+$/);
      const threadA = customer.page.url().split('/').pop() as string;
      await customer.page.getByTestId('message-input').fill('Yarın sabah bekliyorum.');
      await customer.page.getByTestId('message-send').click();
      await expect(customer.page.getByTestId('message-item')).toHaveCount(1);

      // The promised start day passes.
      await promise(offerA, -2, 4);
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('service-issue-open')).toHaveText('Hizmetle ilgili sorun bildir');
      await reportIssue(customer.page, requestId, 'PROVIDER_NO_SHOW');
      await expect(customer.page.getByTestId('service-issue-outcome')).toContainText('yeniden teklif almaya açıldı');
      await expect(customer.page.getByTestId('previous-matches')).toContainText(aAccount.businessName);
      await expect(customer.page.getByTestId('previous-match-issue')).toContainText('Hizmet veren gelmedi');

      const row = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { status: true, matchedOfferId: true, currentRound: { select: { roundNumber: true, status: true } } },
      });
      expect(row).toEqual({ status: 'APPROVED', matchedOfferId: null, currentRound: { roundNumber: 2, status: 'OPEN' } });

      // A: out of the market for this request, on every surface it can reach.
      expect(await matchingRequestIds(a, aAccount.id)).not.toContain(requestId);
      await a.gotoWeb(`/providers/${aAccount.id}/requests/${requestId}`);
      await expectNotFoundScreen(a.page);
      await a.gotoWeb(`/providers/${aAccount.id}/offers/${offerA}`);
      await expect(a.page.getByTestId('offer-match-failed')).toBeVisible();

      // B (never offered in Round 1) sees Round 2 and wins it.
      expect(await matchingRequestIds(b, bAccount.id)).toContain(requestId);
      await submitOffer(b, {
        providerId: bAccount.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1700,00',
        message: 'Bugün gelebiliriz.',
      });
      const offerB = await readProviderOfferId(b, bAccount.id, requestId);
      await acceptOffer(customer, requestId, offerB);

      // A's old conversation: readable, no composer; B's is live.
      await a.gotoWeb(`/mesajlar/${threadA}`);
      await assertNoErrorScreen(a.page);
      await expect(a.page.getByTestId('thread-closed-tag')).toBeVisible();
      await expect(a.page.getByTestId('thread-read-only')).toBeVisible();
      await expect(a.page.getByTestId('message-input')).toHaveCount(0);
      await expect(a.page.getByTestId('message-item')).toHaveCount(1);
      await b.gotoWeb(`/mesajlar/${threadA}`);
      await expectNotFoundScreen(b.page);

      await customer.gotoWeb('/requests/matches');
      await customer.page.getByTestId('match-message-cta').first().click();
      await expect(customer.page).toHaveURL(/\/mesajlar\/[^/]+$/);
      expect(customer.page.url().split('/').pop()).not.toBe(threadA);
      await expect(customer.page.getByTestId('thread-title')).toHaveText(bAccount.businessName);
      await customer.page.getByTestId('message-input').fill('Teşekkürler, bekliyorum.');
      await customer.page.getByTestId('message-send').click();
      await expect(customer.page.getByTestId('message-item')).toHaveCount(1);

      // A's accepted offer stays ACCEPTED and nothing was refunded to A.
      expect((await prisma().offer.findUniqueOrThrow({ where: { id: offerA } })).status).toBe('ACCEPTED');
      expect(
        await prisma().providerCreditTransaction.count({ where: { type: 'OFFER_REFUND', referenceId: offerA } }),
      ).toBe(0);
    } finally {
      await Promise.all([customer.close(), admin.close(), a.close(), b.close()]);
    }
  });

  test('a failed direct vitrin match reopens through the marketplace publish gate', async ({ browser }) => {
    await setServiceIssues(true, false);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const market = await createProvider({ categoryId: category.id, location, credits: 10 });

    // The vitrin owner's match, staged: the request was reserved for the owner
    // (DIRECT_SHOWCASE round) and the owner's offer was accepted.
    const { requestId, offerId } = await seededMatch({
      customer: customerAccount,
      provider: owner,
      category,
      location,
      start: -2,
      end: 3,
    });
    await prisma().serviceRequest.update({ where: { id: requestId }, data: { directShowcaseProviderId: owner.id } });
    await prisma().serviceRequestMatchRound.updateMany({
      where: { requestId, roundNumber: 1 },
      data: { source: 'DIRECT_SHOWCASE' },
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const marketActor = await Actor.open(browser, 'provider', primaryRuntime);
    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await acceptOffer(customer, requestId, offerId);
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await reportIssue(customer.page, requestId, 'WORK_NOT_STARTED');
      await expect(customer.page.getByTestId('service-issue-outcome')).toContainText('kısa bir incelemeden sonra');

      const row = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { status: true, directShowcaseProviderId: true, currentRound: { select: { source: true, publishedAt: true } } },
      });
      expect(row).toEqual({
        status: 'SUBMITTED',
        directShowcaseProviderId: null,
        currentRound: { source: 'MARKETPLACE', publishedAt: null },
      });

      // Moderation approves it like any marketplace request; the market sees it.
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);
      await marketActor.loginToWeb(market.email, market.password);
      expect(await matchingRequestIds(marketActor, market.id)).toContain(requestId);
    } finally {
      await Promise.all([customer.close(), admin.close(), marketActor.close()]);
    }
  });

  test('three failed matches: the request waits for the team (MATCH_REVIEW)', async ({ browser }) => {
    await setServiceIssues(true);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const providers = [
      await createProvider({ categoryId: category.id, location, credits: 10 }),
      await createProvider({ categoryId: category.id, location, credits: 10 }),
      await createProvider({ categoryId: category.id, location, credits: 10 }),
    ];
    const request = await seedCustomerRequest({
      customerId: customerAccount.id,
      categoryId: category.id,
      location,
      status: 'APPROVED',
      phoneVerifiedAt: new Date(),
      content: 'empty',
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      for (const [index, provider] of providers.entries()) {
        const offer = await seedOffer({ requestId: request.id, providerId: provider.id, status: 'SUBMITTED' });
        await acceptOffer(customer, request.id, offer.id);
        await promise(offer.id, -2, 3);
        await customer.gotoWeb(`/requests/${request.id}/offers`);
        if (index === 2) {
          await customer.page.getByTestId('service-issue-open').click();
          await expect(customer.page.getByTestId('service-issue-consequence')).toContainText(
            'ekibimiz tarafından incelenmek üzere beklemeye alınır',
          );
          await customer.page.getByRole('button', { name: 'Vazgeç' }).click();
        }
        await reportIssue(customer.page, request.id, 'PROVIDER_NO_SHOW');
      }

      await expect(customer.page.getByTestId('request-match-review')).toContainText(
        'Talebiniz ekibimiz tarafından inceleniyor.',
      );
      await expect(customer.page.getByTestId('service-issue-open')).toHaveCount(0);
      // All three ended matches, the failed current Round 3 included.
      await expect(customer.page.getByTestId('previous-match')).toHaveCount(3);
      const row = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: request.id },
        select: { status: true, currentRound: { select: { roundNumber: true, status: true } } },
      });
      expect(row).toEqual({ status: 'MATCH_REVIEW', currentRound: { roundNumber: 3, status: 'FAILED' } });
      expect(await prisma().serviceRequestMatchRound.count({ where: { requestId: request.id } })).toBe(3);
    } finally {
      await customer.close();
    }
  });

  test('the failed match’s conversation stays readable, read-only, from the request page', async ({ browser }) => {
    await setServiceIssues(true);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const provider = await createProvider({ categoryId: category.id, location, credits: 10 });
    const { requestId, offerId } = await seededMatch({
      customer: customerAccount,
      provider,
      category,
      location,
      start: -2,
      end: 3,
    });

    const customer = await Actor.open(browser, 'customer', contactSharingRuntime);
    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await acceptOffer(customer, requestId, offerId);
      await customer.gotoWeb('/requests/matches');
      await customer.page.getByTestId('match-message-cta').first().click();
      await expect(customer.page).toHaveURL(/\/mesajlar\/[^/]+$/);
      await customer.page.getByTestId('message-input').fill('Saat kaçta gelirsiniz?');
      await customer.page.getByTestId('message-send').click();
      await expect(customer.page.getByTestId('message-item')).toHaveCount(1);

      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await reportIssue(customer.page, requestId, 'OTHER', 'Usta iki kez randevu verdi, ikisinde de gelmedi.');

      await customer.page.getByTestId('previous-match-thread').click();
      await expect(customer.page).toHaveURL(/\/mesajlar\/[^/]+$/);
      await expect(customer.page.getByTestId('thread-closed-tag')).toBeVisible();
      await expect(customer.page.getByTestId('message-item')).toHaveCount(1);
      await expect(customer.page.getByTestId('message-input')).toHaveCount(0);

      await customer.gotoWeb('/mesajlar');
      await expect(customer.page.getByTestId('thread-closed-tag')).toBeVisible();
    } finally {
      await customer.close();
    }
  });

  test('a match without promised days is sent to support, never to the form', async ({ browser }) => {
    await setServiceIssues(true);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const provider = await createProvider({ categoryId: category.id, location, credits: 10 });
    const { requestId, offerId } = await seededMatch({
      customer: customerAccount,
      provider,
      category,
      location,
      start: null,
      end: null,
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await acceptOffer(customer, requestId, offerId);
      await promise(offerId, null, null);
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('service-issue-support')).toBeVisible();
      await expect(customer.page.getByTestId('service-issue-open')).toHaveCount(0);
    } finally {
      await customer.close();
    }
  });

  test('with the switch off there is no call to action', async ({ browser }) => {
    await setServiceIssues(false);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const provider = await createProvider({ categoryId: category.id, location, credits: 10 });
    const { requestId, offerId } = await seededMatch({
      customer: customerAccount,
      provider,
      category,
      location,
      start: -3,
      end: -1,
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await acceptOffer(customer, requestId, offerId);
      await promise(offerId, -3, -1);
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByRole('button', { name: 'Hizmet tamamlandı' })).toBeVisible();
      await expect(customer.page.getByTestId('service-issue-entry')).toHaveCount(0);
      await expect(customer.page.getByTestId('service-issue-support')).toHaveCount(0);

      await setServiceIssues(true);
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('service-issue-open')).toHaveText('Hizmetle ilgili sorun bildir');
    } finally {
      await customer.close();
      await setServiceIssues(false);
    }
  });
});
