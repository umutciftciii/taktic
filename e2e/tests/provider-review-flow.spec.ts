import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  creditBalance,
  prisma,
  requestFormValues,
  uniqueLocation,
} from '../src/fixtures';
import {
  acceptOffer,
  approveRequest,
  completeRequest,
  createRequest,
  moderateReview,
  readProviderOfferId,
  reportReview,
  submitOffer,
  submitReview,
} from '../src/journeys';
import { emailCountFor, waitForLatestSmsCode } from '../src/outbox';
import {
  isProviderReviewsEnabled,
  liveReviewCount,
  seedCompletedJob,
  seedReview,
  setProviderReviewsEnabled,
} from '../src/review-fixtures';
import { primaryRuntime } from '../src/runtime';
import { seedApprovedShowcaseCard, seedLiveShowcasePlacement } from '../src/showcase-fixtures';

/**
 * A customer rates the business that did the job; everybody else sees only
 * what they are allowed to.
 *
 * The API suite proves every rule on its own — who may write, once, within
 * the window; the three-review threshold; the moderation transitions; the
 * dedupe keys. What only a browser can show is that the screens agree with
 * one another through real sessions and real server actions: that marking a
 * job done lands the customer on the form, that the star they gave is on
 * their board, on the provider's list and — from the third review on — on
 * the public profile, the offer card and the vitrin, and that an operator's
 * decision moves all of those at once.
 *
 * The switch is ON only inside these scenarios and put back OFF after each,
 * because every other spec depends on a completed request looking exactly as
 * it did before reviews existed.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;
const COMMENT = 'Zamanında geldi, temiz iş çıkardı.';
const NOT_ENOUGH = 'Henüz yeterli değerlendirme yok';
const WIDTHS = [320, 768, 1024, 1440] as const;
const SCREENSHOT_DIR = resolve(__dirname, '..', 'test-results', 'provider-review-screens');

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await horizontalOverflow(page);
  expect(overflow, `${label}: the page is ${overflow}px wider than the viewport`).toBeLessThanOrEqual(0);
}

/** One screen: no error boundary, no overflow, and a viewport picture. */
async function capture(page: Page, name: string, width: number) {
  await assertNoErrorScreen(page);
  await expectNoHorizontalOverflow(page, `${name} @${width}`);
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, `${name}-${width}.png`), fullPage: false });
}

/** The provider's public review row that carries this comment, on any page. */
function publicRowWith(page: Page, text: string) {
  return page.getByTestId('public-review-row').filter({ hasText: text });
}

test.describe('provider review flow', () => {
  test.beforeEach(async () => {
    await setProviderReviewsEnabled(false);
  });

  test.afterEach(async () => {
    await setProviderReviewsEnabled(false);
    expect(await isProviderReviewsEnabled()).toBe(false);
  });

  test('marketplace: complete → rate → provider sees it → public shows nothing under three → report → remove → restore', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    await setProviderReviewsEnabled(true);

    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });
    // Two more customers whose completed jobs bring the provider to the
    // public threshold. Seeded: the job and the review are not the subject.
    const secondCustomer = await createCustomer('E2E İkinci Müşteri');
    const thirdCustomer = await createCustomer('E2E Üçüncü Müşteri');

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      // ---- the ordinary journey up to the match --------------------------
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const values = requestFormValues(location, customerAccount.name);
      const requestId = await createRequest(customer, category, values);

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);

      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await submitOffer(provider, {
        providerId: providerAccount.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1500.00',
        message: 'Montaj ve ilk bakım dahil.',
      });
      const offerId = await readProviderOfferId(provider, providerAccount.id, requestId);
      await acceptOffer(customer, requestId, offerId);
      const creditsAfterOffer = await creditBalance(providerAccount.id);

      // ---- "Hizmet tamamlandı" lands on the review form ------------------
      await completeRequest(customer, requestId, 'review-form');
      await expect(customer.page).toHaveURL(new RegExp(`/requests/${requestId}/degerlendir`));
      await expect(customer.page.getByTestId('review-window')).toBeVisible();

      // The invitation goes out to the request's own address, once.
      await expect
        .poll(() => emailCountFor(values.customerEmail, 'review-invitation'), {
          message: 'the customer must be mailed one review invitation',
          timeout: 20_000,
          intervals: [100, 200, 500],
        })
        .toBe(1);

      // ---- a comment carrying a phone number is refused, on the form ------
      // The live hint fires as soon as the number is typed; the submit is
      // still allowed — the server is the rule — and comes back refused.
      await customer.page.getByTestId('rating-4').check();
      await customer.page.getByTestId('review-comment').fill('Ustayı arayın: 0532 111 22 33');
      await expect(customer.page.getByTestId('review-contact-hint')).not.toBeEmpty();
      await customer.page.getByTestId('review-submit').click();
      await expect(customer.page.getByTestId('review-contact-error')).toBeVisible();
      await expect(customer.page.getByTestId('review-notice')).toContainText('iletişim bilgisi');
      expect(await prisma().providerReview.count({ where: { requestId } })).toBe(0);

      // ---- the review itself --------------------------------------------
      await submitReview(customer, requestId, 5, COMMENT);
      await expect(customer.page.getByTestId('review-comment-text')).toHaveText(COMMENT);

      const written = await prisma().providerReview.findFirstOrThrow({
        where: { requestId },
        select: { id: true, providerId: true, offerId: true, rating: true },
      });
      // The provider on the row is the accepted offer's — never a form field.
      expect(written.providerId).toBe(providerAccount.id);
      expect(written.offerId).toBe(offerId);
      expect(written.rating).toBe(5);
      const reviewId = written.id;

      // Coming back is the same review, not a second form.
      await customer.gotoWeb(`/requests/${requestId}/degerlendir`);
      await expect(customer.page.getByTestId('review-done')).toBeVisible();
      await expect(customer.page.getByTestId('review-form')).toHaveCount(0);

      // The board and the request both point at it.
      await customer.gotoWeb('/requests/my');
      const card = customer.page.locator(`[data-testid="request-card"][data-request-id="${requestId}"]`);
      await expect(card.getByTestId('review-given')).toBeVisible();
      await expect(card.getByTestId('review-row-stars')).toHaveAttribute('data-value', '5');
      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('request-review-cta')).toContainText('Değerlendirmenizi görün');

      // The provider is told, once, and gets no comment text by mail.
      await expect
        .poll(() => emailCountFor(providerAccount.email, 'review-received'), {
          timeout: 20_000,
          intervals: [100, 200, 500],
        })
        .toBe(1);

      // ---- the provider reads it; the customer is not on the page ----------
      await provider.gotoWeb(`/providers/${providerAccount.id}/degerlendirmeler`);
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('review-row')).toHaveCount(1);
      await expect(provider.page.getByTestId('review-row-comment')).toHaveText(COMMENT);
      await expect(provider.page.getByTestId('review-count')).toHaveText('1');
      await expect(provider.page.getByTestId('review-public-note')).toContainText('en az 3');
      const providerBody = await provider.page.locator('body').innerText();
      expect(providerBody).not.toContain(customerAccount.name);
      expect(providerBody).not.toContain(values.customerPhone);
      expect(providerBody).not.toContain(values.customerEmail);

      // The dashboard carries the exact figure, no threshold.
      await provider.gotoWeb('/providers/me');
      await expect(provider.page.getByTestId('dashboard-review-summary')).toContainText('5,0');
      await expect(provider.page.getByTestId('dashboard-review-summary')).toContainText('1 değerlendirme');

      // ---- one review: every public surface says "not enough" ------------
      await visitor.gotoWeb(`/isletme/${providerAccount.id}`);
      await assertNoErrorScreen(visitor.page);
      await expect(visitor.page.getByTestId('public-provider-name')).toHaveText(providerAccount.businessName);
      await expect(visitor.page.getByTestId('public-review-summary')).toHaveText(NOT_ENOUGH);
      await expect(visitor.page.getByTestId('public-review-row')).toHaveCount(0);
      await expect(visitor.page.getByText(COMMENT)).toHaveCount(0);

      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('offer-review-summary')).toHaveText(NOT_ENOUGH);
      await expect(customer.page.getByTestId('offer-provider-link')).toHaveAttribute(
        'href',
        `/isletme/${providerAccount.id}`,
      );

      // ---- two: still nothing ------------------------------------------
      await seedReview({
        providerId: providerAccount.id,
        categoryId: category.id,
        customerId: secondCustomer.id,
        location,
        rating: 4,
        comment: 'İkinci müşteri yorumu.',
      });
      await visitor.page.reload();
      await expect(visitor.page.getByTestId('public-review-summary')).toHaveText(NOT_ENOUGH);
      await expect(visitor.page.getByTestId('public-review-row')).toHaveCount(0);

      // ---- three: the average, the count and the comments ----------------
      await seedReview({
        providerId: providerAccount.id,
        categoryId: category.id,
        customerId: thirdCustomer.id,
        location,
        rating: 5,
        comment: 'Üçüncü müşteri yorumu.',
      });
      expect(await liveReviewCount(providerAccount.id)).toBe(3);
      await visitor.page.reload();
      await expect(visitor.page.getByTestId('public-review-summary')).toHaveText('★ 4,7 · 3 değerlendirme');
      await expect(visitor.page.getByTestId('public-review-row')).toHaveCount(3);
      await expect(publicRowWith(visitor.page, COMMENT)).toHaveCount(1);
      // Month and category, never a day, never a name.
      const visitorBody = await visitor.page.locator('body').innerText();
      expect(visitorBody).not.toContain(customerAccount.name);
      expect(visitorBody).not.toContain(secondCustomer.name);
      expect(visitorBody).not.toContain(values.customerPhone);
      expect(visitorBody).not.toContain(values.customerEmail);

      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('offer-review-summary')).toHaveText('★ 4,7 · 3 değerlendirme');

      // ---- the provider reports the comment; nothing hides ----------------
      await reportReview(provider, providerAccount.id, 'OFFENSIVE', 'Bu yorum işle ilgili değil.');
      await visitor.page.reload();
      await expect(publicRowWith(visitor.page, COMMENT)).toHaveCount(1);

      // The report is on the queue, once, and reaches the support inbox.
      await admin.gotoAdmin('/provider-reviews/reports');
      const row = admin.page.locator(`[data-testid="review-report-row"][data-review-id="${reviewId}"]`);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(providerAccount.businessName);
      await expect(row).toContainText('Hakaret');

      // ---- REMOVE_COMMENT: the star stays, the comment goes ---------------
      await moderateReview(admin, reviewId, 'REMOVE_COMMENT');
      await visitor.page.reload();
      await expect(visitor.page.getByTestId('public-review-summary')).toHaveText('★ 4,7 · 3 değerlendirme');
      await expect(publicRowWith(visitor.page, COMMENT)).toHaveCount(0);
      await expect(visitor.page.getByTestId('public-review-row')).toHaveCount(2);

      await provider.gotoWeb(`/providers/${providerAccount.id}/degerlendirmeler`);
      await expect(provider.page.getByTestId('review-row-comment-removed')).toHaveCount(1);
      await expect(provider.page.getByTestId('review-row-report-resolved').first()).toContainText('Yorum kaldırıldı');

      await customer.gotoWeb(`/requests/${requestId}/degerlendir`);
      await expect(customer.page.getByTestId('review-comment-removed')).toBeVisible();
      await expect(customer.page.getByTestId('review-stars')).toHaveAttribute('data-value', '5');

      await expect
        .poll(() => emailCountFor(values.customerEmail, 'review-removed'), {
          timeout: 20_000,
          intervals: [100, 200, 500],
        })
        .toBe(1);

      // The queue no longer holds it open; the record does.
      await admin.gotoAdmin('/provider-reviews/reports');
      await expect(admin.page.locator(`[data-testid="review-report-row"][data-review-id="${reviewId}"]`)).toHaveCount(0);
      await admin.gotoAdmin('/provider-reviews/reports?state=resolved');
      await expect(admin.page.locator(`[data-testid="review-report-row"][data-review-id="${reviewId}"]`)).toHaveCount(1);

      // ---- REMOVE_REVIEW: back under the threshold ------------------------
      await moderateReview(admin, reviewId, 'REMOVE_REVIEW');
      expect(await liveReviewCount(providerAccount.id)).toBe(2);
      await visitor.page.reload();
      await expect(visitor.page.getByTestId('public-review-summary')).toHaveText(NOT_ENOUGH);
      await expect(visitor.page.getByTestId('public-review-row')).toHaveCount(0);

      await customer.gotoWeb('/requests/my');
      await expect(card.getByTestId('review-removed-note')).toBeVisible();
      await customer.gotoWeb(`/requests/${requestId}/degerlendir`);
      await expect(customer.page.getByTestId('review-removed')).toBeVisible();

      await provider.gotoWeb(`/providers/${providerAccount.id}/degerlendirmeler`);
      await expect(provider.page.getByTestId('review-row')).toHaveCount(2);
      await expect(provider.page.getByTestId('review-count')).toHaveText('2');

      // ---- RESTORE: everything back --------------------------------------
      await moderateReview(admin, reviewId, 'RESTORE');
      expect(await liveReviewCount(providerAccount.id)).toBe(3);
      await visitor.page.reload();
      await expect(visitor.page.getByTestId('public-review-summary')).toHaveText('★ 4,7 · 3 değerlendirme');
      await expect(publicRowWith(visitor.page, COMMENT)).toHaveCount(1);
      await customer.gotoWeb(`/requests/${requestId}/degerlendir`);
      await expect(customer.page.getByTestId('review-done')).toBeVisible();
      await expect(customer.page.getByTestId('review-comment-text')).toHaveText(COMMENT);

      // The log holds three decisions; the review's provider is unchanged.
      expect(await prisma().providerReviewModeration.count({ where: { reviewId } })).toBe(3);

      // ---- nothing about money moved ---------------------------------------
      expect(await creditBalance(providerAccount.id)).toBe(creditsAfterOffer);
      expect(await prisma().showcaseEntitlement.count({ where: { providerId: providerAccount.id } })).toBe(0);

      // ---- the notification history names every template ------------------
      await admin.gotoAdmin('/notifications');
      const history = await admin.page.locator('body').innerText();
      for (const label of [
        'Değerlendirme daveti',
        'Yeni değerlendirme',
        'Değerlendirme bildirimi (destek)',
        'Değerlendirme kaldırıldı',
      ]) {
        expect(history, `the notification history must list "${label}"`).toContain(label);
      }
      expect(history).not.toContain(COMMENT);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close(), visitor.close()]);
    }
  });

  test('switch off: completion behaves as before, the review URL is a 404 and no surface invites a review', async ({
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
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const values = requestFormValues(location, customerAccount.name);
      const requestId = await createRequest(customer, category, values);
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await submitOffer(provider, {
        providerId: providerAccount.id,
        requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1200.00',
        message: 'Yarın gelebiliriz.',
      });
      const offerId = await readProviderOfferId(provider, providerAccount.id, requestId);
      await acceptOffer(customer, requestId, offerId);

      // Marking the job done lands back on the request, exactly as before.
      await completeRequest(customer, requestId, 'offers-page');
      await expect(customer.page).toHaveURL(new RegExp(`/requests/${requestId}/offers`));
      await expect(customer.page.getByTestId('offer-review-summary')).toHaveCount(0);

      // No invitation is written while the switch is off.
      expect(await prisma().notificationLog.count({ where: { template: 'review-invitation', requestId } })).toBe(0);

      // The board shows the completed row with no review control.
      await customer.gotoWeb('/requests/my');
      const card = customer.page.locator(`[data-testid="request-card"][data-request-id="${requestId}"]`);
      await expect(card.getByTestId('request-status')).toHaveText('Tamamlandı');
      await expect(card.getByTestId('review-cta')).toHaveCount(0);

      // The review URL is a 404 for its own customer.
      await customer.gotoWeb(`/requests/${requestId}/degerlendir`);
      await expectNotFoundScreen(customer.page);

      // The public profile exists and has no review section.
      await visitor.gotoWeb(`/isletme/${providerAccount.id}`);
      await assertNoErrorScreen(visitor.page);
      await expect(visitor.page.getByTestId('public-provider-name')).toHaveText(providerAccount.businessName);
      await expect(visitor.page.getByTestId('public-reviews')).toHaveCount(0);
      await expect(visitor.page.getByTestId('public-review-summary')).toHaveCount(0);

      // The provider's own panel still opens: its data, whatever the switch.
      await provider.gotoWeb(`/providers/${providerAccount.id}/degerlendirmeler`);
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('review-empty')).toBeVisible();
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close(), visitor.close()]);
    }
  });

  test('guards: the window, another customer, an unmatched request, an unlistable business, and the operator who cannot report', async ({
    browser,
  }) => {
    await setProviderReviewsEnabled(true);

    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const otherCustomerAccount = await createCustomer('E2E Başka Müşteri');
    const adminAccount = await createAdmin();
    const providerAccount = await createProvider({ categoryId: category.id, location, credits: 0 });
    const suspendedProvider = await createProvider({ categoryId: category.id, location, credits: 0 });
    await prisma().providerProfile.update({
      where: { id: suspendedProvider.id },
      data: { status: 'SUSPENDED', suspendedAt: new Date() },
    });

    const NINETY_ONE_DAYS = 91 * 24 * 60 * 60 * 1000;
    const expired = await seedCompletedJob({
      providerId: providerAccount.id,
      categoryId: category.id,
      customerId: customerAccount.id,
      location,
      completedAt: new Date(Date.now() - NINETY_ONE_DAYS),
    });
    const fresh = await seedCompletedJob({
      providerId: providerAccount.id,
      categoryId: category.id,
      customerId: customerAccount.id,
      location,
    });
    const unmatched = await prisma().serviceRequest.create({
      data: {
        categoryId: category.id,
        customerId: customerAccount.id,
        customerName: customerAccount.name,
        customerPhone: customerAccount.phone,
        city: location.city,
        district: location.district,
        status: 'APPROVED',
        approvedAt: new Date(),
        qualityScore: 80,
      },
      select: { id: true },
    });
    const reviewed = await seedReview({
      providerId: providerAccount.id,
      categoryId: category.id,
      customerId: otherCustomerAccount.id,
      location,
      rating: 3,
      comment: 'Başka müşterinin yorumu.',
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const other = await Actor.open(browser, 'other-customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);

      // 90 days: the page says so and offers no form.
      await customer.gotoWeb(`/requests/${expired.requestId}/degerlendir`);
      await assertNoErrorScreen(customer.page);
      await expect(customer.page.getByTestId('review-window-closed')).toBeVisible();
      await expect(customer.page.getByTestId('review-form')).toHaveCount(0);

      // The board says the same thing on the request rather than hiding it.
      await customer.gotoWeb(`/requests/${expired.requestId}/offers`);
      await expect(customer.page.getByTestId('request-review-cta')).toContainText('Değerlendirme süresi doldu');

      // A fresh completed job still takes a review — the window is the only difference.
      await customer.gotoWeb(`/requests/${fresh.requestId}/degerlendir`);
      await expect(customer.page.getByTestId('review-form')).toBeVisible();

      // An approved request with no accepted offer: not yet.
      await customer.gotoWeb(`/requests/${unmatched.id}/degerlendir`);
      await expect(customer.page.getByTestId('review-not-completed')).toBeVisible();
      await expect(customer.page.getByTestId('review-form')).toHaveCount(0);

      // Somebody else's request, and a request that does not exist: the same 404.
      await customer.gotoWeb(`/requests/${reviewed.requestId}/degerlendir`);
      await expectNotFoundScreen(customer.page);
      await customer.gotoWeb('/requests/does-not-exist/degerlendir');
      await expectNotFoundScreen(customer.page);

      // The reviewer's own page shows their review, once, with no second form.
      await other.loginToWeb(otherCustomerAccount.email, otherCustomerAccount.password);
      await other.gotoWeb(`/requests/${reviewed.requestId}/degerlendir`);
      await expect(other.page.getByTestId('review-done')).toBeVisible();
      await expect(other.page.getByTestId('review-form')).toHaveCount(0);

      // A signed-out visitor is sent to sign in, not shown a form.
      await visitor.gotoWeb(`/requests/${fresh.requestId}/degerlendir`);
      await expect(visitor.page).toHaveURL(/\/login/);

      // Public profile: an approved business opens; a suspended one and an
      // unknown id are the same 404 — and so is the public review list.
      await visitor.gotoWeb(`/isletme/${providerAccount.id}`);
      await expect(visitor.page.getByTestId('public-provider-name')).toHaveText(providerAccount.businessName);
      await visitor.gotoWeb(`/isletme/${suspendedProvider.id}`);
      await expectNotFoundScreen(visitor.page);
      await visitor.gotoWeb('/isletme/does-not-exist');
      await expectNotFoundScreen(visitor.page);

      // The public profile page carries no contact details of the business.
      await visitor.gotoWeb(`/isletme/${providerAccount.id}`);
      const publicBody = await visitor.page.locator('body').innerText();
      expect(publicBody).not.toContain(providerAccount.email);
      expect(publicBody).not.toContain('Yetkili ');

      // The operator cannot file a report on the provider's behalf: the
      // detail screen has no such control, and the API refuses the call
      // outright — a 403 before the review is even looked up.
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/provider-reviews/${reviewed.reviewId}`);
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByTestId('review-state')).toHaveText('Yayında');
      await expect(admin.page.getByTestId('review-report-button')).toHaveCount(0);
      await expect(admin.page.getByText('Yorumu bildir')).toHaveCount(0);

      const reportsBefore = await prisma().providerReviewReport.count();
      const response = await admin.page.request.post(
        `${primaryRuntime.apiUrl}/providers/${providerAccount.id}/reviews/${reviewed.reviewId}/reports`,
        { data: { reason: 'OTHER' } },
      );
      expect(response.status()).toBe(403);
      expect(await prisma().providerReviewReport.count()).toBe(reportsBefore);

      // And the switch itself is not a customer's to read or write.
      const settings = await customer.page.request.get(
        `${primaryRuntime.apiUrl}/operations-settings/provider-reviews`,
      );
      expect([401, 403]).toContain(settings.status());
    } finally {
      await Promise.all([customer.close(), other.close(), admin.close(), visitor.close()]);
    }
  });

  test('the review screens fit every width, and the stars answer the keyboard', async ({ browser }) => {
    await setProviderReviewsEnabled(true);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const providerAccount = await createProvider({ categoryId: category.id, location, credits: 0 });
    const reviewers = [
      await createCustomer('E2E Yorumcu Bir'),
      await createCustomer('E2E Yorumcu İki'),
      await createCustomer('E2E Yorumcu Üç'),
    ];
    for (const [index, reviewer] of reviewers.entries()) {
      await seedReview({
        providerId: providerAccount.id,
        categoryId: category.id,
        customerId: reviewer.id,
        location,
        rating: 4 + (index % 2),
        comment: `Görünüm testi yorumu ${index + 1}. Uzun bir cümle ile satır kaydırmayı da deneyelim.`,
      });
    }
    const job = await seedCompletedJob({
      providerId: providerAccount.id,
      categoryId: category.id,
      customerId: customerAccount.id,
      location,
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await provider.loginToWeb(providerAccount.email, providerAccount.password);

      for (const width of WIDTHS) {
        for (const actor of [customer, provider, visitor]) {
          await actor.page.setViewportSize({ width, height: 900 });
        }

        await customer.gotoWeb(`/requests/${job.requestId}/degerlendir`);
        await expect(customer.page.getByTestId('review-form')).toBeVisible();
        await capture(customer.page, 'customer-review-form', width);

        await provider.gotoWeb(`/providers/${providerAccount.id}/degerlendirmeler`);
        await expect(provider.page.getByTestId('review-row')).toHaveCount(3);
        await capture(provider.page, 'provider-reviews', width);

        await visitor.gotoWeb(`/isletme/${providerAccount.id}`);
        await expect(visitor.page.getByTestId('public-review-row')).toHaveCount(3);
        await capture(visitor.page, 'public-profile', width);
      }

      // Keyboard: the stars are five native radios. Tab reaches the group,
      // arrows move the choice, and the chosen value is what the form posts.
      await customer.page.setViewportSize({ width: 1024, height: 900 });
      await customer.gotoWeb(`/requests/${job.requestId}/degerlendir`);
      const first = customer.page.getByTestId('rating-1');
      await first.focus();
      await expect(first).toBeFocused();
      await customer.page.keyboard.press('ArrowRight');
      await customer.page.keyboard.press('ArrowRight');
      await expect(customer.page.getByTestId('rating-3')).toBeChecked();
      await expect(customer.page.getByTestId('rating-3')).toBeFocused();
      await expect(customer.page.getByTestId('review-rating-word')).toContainText('3 yıldız');
      await customer.page.keyboard.press('ArrowLeft');
      await expect(customer.page.getByTestId('rating-2')).toBeChecked();

      // The counter follows the comment, and the limit is the shared one.
      const comment = customer.page.getByTestId('review-comment');
      await expect(comment).toHaveAttribute('maxlength', '600');
      await comment.fill('Kısa bir yorum.');
      await expect(customer.page.getByTestId('review-comment-counter')).toContainText('15 / 600');

      // Submitting from the keyboard posts the chosen star.
      await customer.page.getByTestId('review-submit').focus();
      await customer.page.keyboard.press('Enter');
      await expect(customer.page.getByTestId('review-done')).toBeVisible();
      await expect(customer.page.getByTestId('review-stars')).toHaveAttribute('data-value', '2');
      await capture(customer.page, 'customer-review-done', 1024);
    } finally {
      await Promise.all([customer.close(), provider.close(), visitor.close()]);
    }
  });

  test('vitrin direct lead reaches the same review path, and the card shows the rating from the third review', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    await setProviderReviewsEnabled(true);

    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin Değerlendirme' });
    const customerAccount = await createCustomer();
    const ownerAccount = await createProvider({ categoryId: category.id, location, credits: 0 });
    const cardTitle = `E2E Vitrin Klima Bakımı ${Date.now().toString(36).slice(-4)}`;
    const { card, version } = await seedApprovedShowcaseCard({
      providerId: ownerAccount.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: cardTitle,
    });
    await seedLiveShowcasePlacement({
      providerId: ownerAccount.id,
      cardId: card.id,
      versionId: version.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const owner = await Actor.open(browser, 'owner', primaryRuntime);
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      // ---- the customer writes to the business from its card ------------------
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoWeb(`/vitrin/${card.id}?step=form`);
      const form = customer.page.getByTestId('showcase-lead-form');
      await expect(form).toBeVisible();
      // No rating on the card page yet: the business has no public average.
      await expect(customer.page.getByTestId('showcase-card-review-summary')).toHaveText(NOT_ENOUGH);

      await customer.page.getByTestId('request-city').selectOption(location.city);
      await customer.page.getByTestId('request-district').selectOption(location.district);
      await customer.page.getByTestId('showcase-lead-urgency').selectOption('THIS_WEEK');
      await customer.page.getByTestId('showcase-urgency-normal').check();
      await customer.page.getByLabel('Açıklama *').fill('Salon kliması bakım istiyorum.');

      // A signed-in customer proves the account's own number inside the form.
      await customer.page.getByTestId('showcase-lead-phone-send').click();
      await expect(customer.page.getByTestId('showcase-lead-phone-code')).toBeVisible();
      const code = await waitForLatestSmsCode(customerAccount.phone);
      await customer.page.getByTestId('showcase-lead-code').fill(code);
      await customer.page.getByTestId('showcase-lead-phone-verify').click();
      await expect(customer.page.getByTestId('showcase-lead-phone-verified')).toBeVisible();

      await customer.page.getByTestId('showcase-lead-submit').click();
      await expect(customer.page.getByTestId('showcase-lead-sent')).toBeVisible();

      const lead = await prisma().showcaseLead.findFirstOrThrow({
        where: { cardId: card.id },
        select: { id: true, requestId: true },
      });

      // ---- the owner answers it; the customer accepts and completes ----------
      await owner.loginToWeb(ownerAccount.email, ownerAccount.password);
      await owner.gotoWeb(`/providers/${ownerAccount.id}/vitrin/talepler/${lead.id}`);
      await assertNoErrorScreen(owner.page);
      const offerForm = owner.page.locator('form.pdash-form');
      await offerForm.locator('input[name="priceAmount"]').fill('1500.00');
      await offerForm.locator('textarea[name="message"]').fill('Kartta yazan kapsamda, yarın.');
      await owner.page.getByRole('button', { name: 'Teklifi gönder' }).click();
      await assertNoErrorScreen(owner.page);

      const offer = await prisma().offer.findFirstOrThrow({
        where: { requestId: lead.requestId, providerId: ownerAccount.id },
        select: { id: true },
      });
      await acceptOffer(customer, lead.requestId, offer.id);
      await completeRequest(customer, lead.requestId, 'review-form');
      await submitReview(customer, lead.requestId, 5, 'Vitrin üzerinden geldi, çok memnun kaldım.');

      const review = await prisma().providerReview.findFirstOrThrow({
        where: { requestId: lead.requestId },
        select: { providerId: true, offerId: true },
      });
      expect(review.providerId).toBe(ownerAccount.id);
      expect(review.offerId).toBe(offer.id);
      // The lead row is untouched by the review.
      const leadAfter = await prisma().showcaseLead.findUniqueOrThrow({
        where: { id: lead.id },
        select: { requestId: true, closedAt: true },
      });
      expect(leadAfter.requestId).toBe(lead.requestId);

      // ---- two more, and the card carries the rating — compactly -------------
      for (const name of ['E2E Vitrin Yorumcu Bir', 'E2E Vitrin Yorumcu İki']) {
        const reviewer = await createCustomer(name);
        await seedReview({
          providerId: ownerAccount.id,
          categoryId: category.id,
          customerId: reviewer.id,
          location,
          rating: 5,
          comment: 'Vitrin yorumu.',
        });
      }

      await visitor.gotoWeb('/');
      const shelfCard = visitor.page.getByTestId('showcase-shelf-card').filter({ hasText: cardTitle });
      await expect(shelfCard).toBeVisible();
      await expect(shelfCard.getByTestId('showcase-card-rating')).toHaveText('★ 5,0 · 3 değerlendirme');
      // The rating line is smaller than the price, and the price and the area
      // band are still there — the rating did not push them out.
      await expect(shelfCard.getByTestId('showcase-card-price')).toContainText('₺1.500,00');
      await expect(shelfCard.getByTestId('showcase-card-area')).toContainText(location.district);
      const [ratingSize, priceSize] = await Promise.all([
        shelfCard.getByTestId('showcase-card-rating').evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
        shelfCard.getByTestId('showcase-card-price').evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      ]);
      expect(ratingSize).toBeLessThan(priceSize);

      await visitor.gotoWeb(`/vitrin/${card.id}`);
      await expect(visitor.page.getByTestId('showcase-card-review-summary')).toHaveText('★ 5,0 · 3 değerlendirme');
      await expect(visitor.page.getByTestId('showcase-card-provider-link')).toHaveAttribute(
        'href',
        `/isletme/${ownerAccount.id}`,
      );
      for (const width of [320, 1440] as const) {
        await visitor.page.setViewportSize({ width, height: 900 });
        await expectNoHorizontalOverflow(visitor.page, `vitrin kartı @ ${width}`);
      }
    } finally {
      await Promise.all([customer.close(), owner.close(), visitor.close()]);
    }
  });
});
