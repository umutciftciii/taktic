import { expect, test, type Locator, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { settleActionRedirect } from '../src/action-redirect';
import { confirmThrough } from '../src/confirm-dialog';
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
import { acceptOffer, completeRequest, istanbulDay, matchingRequestIds, readProviderOfferId, submitOffer } from '../src/journeys';
import { seedCustomerRequest } from '../src/request-fixtures';
import { seedOffer } from '../src/offer-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * REL-002 Faz 5 — staff recovery from MATCH_REVIEW, on real screens.
 *
 *   1. three failed matches (A, B, C) → MATCH_REVIEW → an ADMIN reading
 *      requests sees the timeline but no action → the SUPER_ADMIN opens
 *      Round 4 through the confirmation → A, B and C cannot reach it, D bids,
 *      wins and completes; the customer never sees the staff note.
 *   2. two super admins open Round 4 at once: one round, the other is told.
 *   3. a direct vitrin chain: DIRECT Round 1 fails → marketplace Rounds 2–3
 *      fail → MATCH_REVIEW → staff Round 4 is a marketplace round; the vitrin
 *      owner stays out.
 *   4. a legacy match with no promised days says so on the timeline.
 *
 * The service-issue switch is an operations setting in the shared database;
 * each case sets it, and the suite turns it off again at the end (it ships off).
 */

const CATEGORY_COST = 2;
const NOTE = 'Müşteriyle görüşüldü; talep yeni hizmet verenlere açılacak.';

async function setSwitches(serviceIssues: boolean, autoPublish: boolean) {
  await prisma().operationsSettings.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      unviewedOfferRefundWindowHours: 48,
      serviceIssueReportingEnabled: serviceIssues,
      marketplaceAutoPublishEnabled: autoPublish,
    },
    update: { serviceIssueReportingEnabled: serviceIssues, marketplaceAutoPublishEnabled: autoPublish },
  });
}

test.afterAll(async () => {
  await setSwitches(false, false);
});

async function promise(offerId: string, start: number | null, end: number | null) {
  await prisma().offer.update({
    where: { id: offerId },
    data: {
      estimatedStartDate: start === null ? null : new Date(`${istanbulDay(start)}T00:00:00.000Z`),
      estimatedCompletionDate: end === null ? null : new Date(`${istanbulDay(end)}T00:00:00.000Z`),
    },
  });
}

async function reportIssue(page: Page, requestId: string) {
  await expect(page.getByTestId('service-issue-open')).toBeVisible();
  await page.getByTestId('service-issue-open').click();
  const dialog = page.getByTestId('service-issue-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('service-issue-reason-PROVIDER_NO_SHOW').click();
  await dialog.getByTestId('service-issue-submit').click();
  await expect(page).toHaveURL(new RegExp(`/requests/${requestId}/offers\\?issue=`));
  await expect(page.getByTestId('service-issue-outcome')).toBeVisible();
  await assertNoErrorScreen(page);
}

/** One failed round: the provider's offer is accepted, its start day passes, the customer reports. */
async function failRound(customer: Actor, requestId: string, provider: SeededProvider) {
  const offer = await seedOffer({ requestId, providerId: provider.id, status: 'SUBMITTED' });
  await acceptOffer(customer, requestId, offer.id);
  await promise(offer.id, -2, 3);
  await customer.gotoWeb(`/requests/${requestId}/offers`);
  await reportIssue(customer.page, requestId);
  return offer.id;
}

async function liveRequest(customerAccount: SeededCustomer, category: SeededCategory, location: ReturnType<typeof uniqueLocation>) {
  return seedCustomerRequest({
    customerId: customerAccount.id,
    categoryId: category.id,
    location,
    status: 'APPROVED',
    phoneVerifiedAt: new Date(),
    content: 'empty',
  });
}

async function openRoundsTab(admin: Actor, requestId: string) {
  await admin.gotoAdmin(`/requests/${requestId}?tab=turlar`);
  await expect(admin.page.getByTestId('round-timeline')).toBeVisible();
  await assertNoErrorScreen(admin.page);
}

/** Writes the note and goes through "Yeni tur aç"'s confirmation. */
async function openNextRound(admin: Actor, nextNumber: number, before?: (dialog: Locator) => Promise<void>) {
  const form = admin.page.getByTestId('open-next-round-form');
  await form.getByTestId('open-next-round-note').fill(NOTE);
  await settleActionRedirect(admin.page, () =>
    confirmThrough(form.getByTestId('open-next-round'), `Evet, Tur ${nextNumber}'i aç`, before),
  );
}

test.describe('MATCH_REVIEW recovery (REL-002 Faz 5)', () => {
  test('three failures → MATCH_REVIEW → the super admin opens Round 4 → D wins and completes; A, B, C stay out', async ({ browser }) => {
    await setSwitches(true, true);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const superAccount = await createAdmin();
    const readerAccount = await createStaffAdmin(['REQUESTS_READ']);
    const [aAccount, bAccount, cAccount, dAccount] = [
      await createProvider({ categoryId: category.id, location, credits: 10 }),
      await createProvider({ categoryId: category.id, location, credits: 10 }),
      await createProvider({ categoryId: category.id, location, credits: 10 }),
      await createProvider({ categoryId: category.id, location, credits: 10 }),
    ];
    const request = await liveRequest(customerAccount, category, location);

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const superAdmin = await Actor.open(browser, 'admin', primaryRuntime);
    const reader = await Actor.open(browser, 'staff', primaryRuntime);
    const a = await Actor.open(browser, 'provider-a', primaryRuntime);
    const d = await Actor.open(browser, 'provider-d', primaryRuntime);
    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const failedOffers: string[] = [];
      for (const provider of [aAccount, bAccount, cAccount]) {
        failedOffers.push(await failRound(customer, request.id, provider));
      }
      await expect(customer.page.getByTestId('request-match-review')).toContainText('Talebiniz ekibimiz tarafından inceleniyor.');

      // An operator who reads requests sees the queue and the timeline, not the action.
      await reader.loginToAdmin(readerAccount.email, readerAccount.password);
      await reader.gotoAdmin('/requests?status=MATCH_REVIEW');
      await expect(reader.page.getByTestId('match-review-queue')).toBeVisible();
      await expect(reader.page.locator(`[data-testid="match-review-row"][data-request-id="${request.id}"]`)).toBeVisible();
      await openRoundsTab(reader, request.id);
      await expect(reader.page.getByTestId('round-card')).toHaveCount(3);
      await expect(reader.page.getByTestId('round-open-reserved')).toBeVisible();
      await expect(reader.page.getByTestId('open-next-round-form')).toHaveCount(0);

      // The super admin opens Round 4: the confirmation says what does not change.
      await superAdmin.loginToAdmin(superAccount.email, superAccount.password);
      await openRoundsTab(superAdmin, request.id);
      await openNextRound(superAdmin, 4, async (dialog) => {
        await expect(dialog).toContainText('Kredi iadesi yapılmaz');
        await expect(dialog).toContainText('dışlanmış kalır');
      });
      await expect(superAdmin.page.getByTestId('round-opened-notice')).toBeVisible();
      await expect(superAdmin.page.getByTestId('round-card')).toHaveCount(4);
      const fourth = superAdmin.page.locator('[data-testid="round-card"][data-round="4"]');
      await expect(fourth.getByTestId('round-admin-opened')).toHaveText('Yönetici açtı');
      await expect(fourth.getByTestId('round-opening-note')).toHaveText(NOTE);
      await expect(superAdmin.page.getByTestId('open-next-round-form')).toHaveCount(0);

      const row = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: request.id },
        select: { status: true, currentRound: { select: { roundNumber: true, status: true, openedBy: true, source: true } } },
      });
      expect(row).toEqual({
        status: 'APPROVED',
        currentRound: { roundNumber: 4, status: 'OPEN', openedBy: 'ADMIN', source: 'MARKETPLACE' },
      });

      // A failed provider cannot reach it; D can, at the normal price.
      await a.loginToWeb(aAccount.email, aAccount.password);
      expect(await matchingRequestIds(a, aAccount.id)).not.toContain(request.id);
      await d.loginToWeb(dAccount.email, dAccount.password);
      expect(await matchingRequestIds(d, dAccount.id)).toContain(request.id);
      await submitOffer(d, {
        providerId: dAccount.id,
        requestId: request.id,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1800,00',
        message: 'Yarın sabah gelebiliriz.',
      });
      const offerD = await readProviderOfferId(d, dAccount.id, request.id);
      await acceptOffer(customer, request.id, offerD);
      await completeRequest(customer, request.id, 'offers-page');

      // The customer's page: the whole history, never the staff note.
      await customer.gotoWeb(`/requests/${request.id}/offers`);
      await expect(customer.page.getByTestId('previous-match')).toHaveCount(3);
      expect(await customer.page.content()).not.toContain(NOTE);

      // Credit: the failed winners were never refunded.
      for (const offerId of failedOffers) {
        expect(await prisma().providerCreditTransaction.count({ where: { type: 'OFFER_REFUND', referenceId: offerId } })).toBe(0);
      }
      await openRoundsTab(superAdmin, request.id);
      await expect(fourth.getByTestId('round-status')).toHaveText('Tamamlandı');
    } finally {
      await Promise.all([customer.close(), superAdmin.close(), reader.close(), a.close(), d.close()]);
    }
  });

  test('two super admins open Round 4 at once: one round; the other is told it was already opened', async ({ browser }) => {
    await setSwitches(true, true);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const providers = [
      await createProvider({ categoryId: category.id, location, credits: 10 }),
      await createProvider({ categoryId: category.id, location, credits: 10 }),
      await createProvider({ categoryId: category.id, location, credits: 10 }),
    ];
    const request = await liveRequest(customerAccount, category, location);
    const [oneAccount, twoAccount] = [await createAdmin(), await createAdmin()];

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const one = await Actor.open(browser, 'admin', primaryRuntime);
    const two = await Actor.open(browser, 'admin-2', primaryRuntime);
    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      for (const provider of providers) {
        await failRound(customer, request.id, provider);
      }
      await one.loginToAdmin(oneAccount.email, oneAccount.password);
      await two.loginToAdmin(twoAccount.email, twoAccount.password);
      await openRoundsTab(one, request.id);
      await openRoundsTab(two, request.id);

      await Promise.all([openNextRound(one, 4), openNextRound(two, 4)]);

      const outcomes = await Promise.all(
        [one, two].map(async (actor) => ((await actor.page.getByTestId('round-opened-notice').count()) > 0 ? 'opened' : 'refused')),
      );
      expect([...outcomes].sort()).toEqual(['opened', 'refused']);
      const loser = outcomes[0] === 'refused' ? one : two;
      await expect(loser.page.getByTestId('round-error')).toContainText('zaten açıldı');
      expect(await prisma().serviceRequestMatchRound.count({ where: { requestId: request.id, roundNumber: 4 } })).toBe(1);
      expect(await prisma().serviceRequestRoundOpening.count({ where: { requestId: request.id } })).toBe(1);
    } finally {
      await Promise.all([customer.close(), one.close(), two.close()]);
    }
  });

  test('a direct vitrin chain recovers into a marketplace Round 4; the owner stays out', async ({ browser }) => {
    await setSwitches(true, true);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const superAccount = await createAdmin();
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const second = await createProvider({ categoryId: category.id, location, credits: 10 });
    const third = await createProvider({ categoryId: category.id, location, credits: 10 });

    // Round 1 reserved for the vitrin owner (DIRECT_SHOWCASE), staged.
    const request = await liveRequest(customerAccount, category, location);
    await prisma().serviceRequest.update({ where: { id: request.id }, data: { directShowcaseProviderId: owner.id } });
    await prisma().serviceRequestMatchRound.updateMany({ where: { requestId: request.id, roundNumber: 1 }, data: { source: 'DIRECT_SHOWCASE' } });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const superAdmin = await Actor.open(browser, 'admin', primaryRuntime);
    const ownerActor = await Actor.open(browser, 'provider', primaryRuntime);
    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      for (const provider of [owner, second, third]) {
        await failRound(customer, request.id, provider);
      }
      await superAdmin.loginToAdmin(superAccount.email, superAccount.password);
      await openRoundsTab(superAdmin, request.id);
      await expect(superAdmin.page.locator('[data-testid="round-card"][data-round="1"]')).toContainText('Vitrin (doğrudan)');
      await openNextRound(superAdmin, 4);
      await expect(superAdmin.page.getByTestId('round-opened-notice')).toBeVisible();

      const rounds = await prisma().serviceRequestMatchRound.findMany({
        where: { requestId: request.id },
        orderBy: { roundNumber: 'asc' },
        select: { source: true },
      });
      expect(rounds.map((round) => round.source)).toEqual(['DIRECT_SHOWCASE', 'MARKETPLACE', 'MARKETPLACE', 'MARKETPLACE']);
      expect((await prisma().serviceRequest.findUniqueOrThrow({ where: { id: request.id }, select: { directShowcaseProviderId: true } })).directShowcaseProviderId).toBeNull();
      await ownerActor.loginToWeb(owner.email, owner.password);
      expect(await matchingRequestIds(ownerActor, owner.id)).not.toContain(request.id);
    } finally {
      await Promise.all([customer.close(), superAdmin.close(), ownerActor.close()]);
    }
  });

  test('the rounds tab and its dialog: keyboard, focus return, labels, status in words, phone width', async ({ browser }) => {
    await setSwitches(true, false);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const superAccount = await createAdmin();
    const providers = [
      await createProvider({ categoryId: category.id, location, credits: 10 }),
      await createProvider({ categoryId: category.id, location, credits: 10 }),
      await createProvider({ categoryId: category.id, location, credits: 10 }),
    ];
    const request = await liveRequest(customerAccount, category, location);

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const superAdmin = await Actor.open(browser, 'admin', primaryRuntime);
    const phone = await Actor.open(browser, 'admin-phone', primaryRuntime, { viewport: { width: 375, height: 812 } });
    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      for (const provider of providers) {
        await failRound(customer, request.id, provider);
      }
      await superAdmin.loginToAdmin(superAccount.email, superAccount.password);
      await openRoundsTab(superAdmin, request.id);
      const page = superAdmin.page;

      // One main, one h1; every field named; each round a labelled article
      // whose status is written out.
      const structure = await page.evaluate(() => ({
        mains: document.querySelectorAll('main').length,
        h1s: document.querySelectorAll('h1').length,
        unnamed: Array.from(document.querySelectorAll<HTMLElement>('input:not([type="hidden"]), select, textarea'))
          .filter((field) => {
            const id = field.getAttribute('id');
            return !(
              field.getAttribute('aria-label') ||
              field.getAttribute('aria-labelledby') ||
              field.closest('label') ||
              (id && document.querySelector(`label[for="${CSS.escape(id)}"]`))
            );
          })
          .map((field) => field.getAttribute('name')),
        articles: Array.from(document.querySelectorAll('article.round-card')).map((article) => {
          const labelledBy = article.getAttribute('aria-labelledby');
          return labelledBy ? document.getElementById(labelledBy)?.textContent?.trim() : null;
        }),
      }));
      expect(structure).toEqual({ mains: 1, h1s: 1, unnamed: [], articles: ['Tur 1', 'Tur 2', 'Tur 3'] });
      await expect(page.getByTestId('round-status').first()).toHaveText('Başarısız (hizmet aksaklığı)');
      await expect(page.getByLabel(/İç not/)).toHaveAttribute('required', '');

      // Keyboard: the trigger opens the dialog, focus starts on "Vazgeç",
      // Esc closes it and focus goes back to the trigger; nothing is written.
      const trigger = page.getByTestId('open-next-round-form').getByTestId('open-next-round');
      await expect
        .poll(() => trigger.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps'))))
        .toBe(true);
      await page.getByTestId('open-next-round-note').fill(NOTE);
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.locator('dialog[data-testid="open-next-round-dialog"][open]');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-labelledby', /.+/);
      await expect(dialog.getByRole('button', { name: 'Vazgeç' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(await prisma().serviceRequestRoundOpening.count({ where: { requestId: request.id } })).toBe(0);

      // An empty note never reaches the API: the browser refuses the form.
      await page.getByTestId('open-next-round-note').fill('');
      await trigger.click();
      await expect(page.locator('dialog[data-testid="open-next-round-dialog"][open]')).toHaveCount(0);
      expect(await page.getByTestId('open-next-round-note').evaluate((field) => (field as HTMLTextAreaElement).validity.valid)).toBe(false);

      // Phone width: the tab and its cards fit without a sideways scroll.
      await phone.loginToAdmin(superAccount.email, superAccount.password);
      await openRoundsTab(phone, request.id);
      const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await Promise.all([customer.close(), superAdmin.close(), phone.close()]);
    }
  });

  test('a legacy match with no promised days says so on the timeline', async ({ browser }) => {
    await setSwitches(true, false);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const superAccount = await createAdmin();
    const provider = await createProvider({ categoryId: category.id, location, credits: 10 });
    const request = await liveRequest(customerAccount, category, location);
    const offer = await seedOffer({ requestId: request.id, providerId: provider.id, status: 'SUBMITTED' });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const superAdmin = await Actor.open(browser, 'admin', primaryRuntime);
    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await acceptOffer(customer, request.id, offer.id);
      await promise(offer.id, null, null);
      await customer.gotoWeb(`/requests/${request.id}/offers`);
      await expect(customer.page.getByTestId('service-issue-support')).toBeVisible();

      await superAdmin.loginToAdmin(superAccount.email, superAccount.password);
      await openRoundsTab(superAdmin, request.id);
      await expect(superAdmin.page.getByTestId('round-schedule-missing')).toContainText(
        'Taahhüt tarihi yok — otomatik sorun bildirimi kullanılamaz',
      );
    } finally {
      await Promise.all([customer.close(), superAdmin.close()]);
    }
  });
});
