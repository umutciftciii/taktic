import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { seedActiveCampaign } from '../src/campaign-fixtures';
import {
  createAdmin,
  createCategory,
  createProvider,
  createStaffAdmin,
  prisma,
  uniqueLocation,
  uniquePhone,
  uniqueSuffix,
} from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * CMP-006 PR-C — the canonical business registration and the promotion
 * eligibility queue, end to end.
 *
 * 1. An applicant declares a sole proprietorship (a T.C. identity number):
 *    "Beyan etmiyorum" hides the number, a mismatched number comes back as a
 *    sentence (never echoed), and a valid one is stored. An operator with the
 *    detail permission sees it masked and no reveal button; one holding
 *    PROVIDER_REGISTRATION_READ_SENSITIVE reveals it, and that read is logged.
 * 2. An event the gate held is decided from the queue, with a reason, once.
 */

/** Check digits valid. */
const TCKN = '10000000146';
const TCKN_MASKED = '*********46';

/* DASHBOARD_READ so the landing page after sign-in is not /yetkisiz (WebKit race, see package-refund-request.spec). */
const DETAIL = ['DASHBOARD_READ', 'PROVIDERS_READ', 'PROVIDERS_READ_DETAIL'];

test.describe('business registration', () => {
  test('declared on the application, masked everywhere, revealed once with the sensitive permission', async ({ browser }) => {
    const category = await createCategory(3, { namePrefix: 'E2E İşletme Kaydı' });
    const location = uniqueLocation();
    const businessName = `E2E Şahıs ${uniqueSuffix()}`;
    const applicant = await Actor.open(browser, 'applicant', primaryRuntime);
    const viewerAccount = await createStaffAdmin(DETAIL);
    const revealerAccount = await createStaffAdmin([...DETAIL, 'PROVIDER_REGISTRATION_READ_SENSITIVE']);
    const viewer = await Actor.open(browser, 'viewer', primaryRuntime);
    const revealer = await Actor.open(browser, 'revealer', primaryRuntime);

    try {
      await applicant.gotoWeb('/providers/register');
      const form = applicant.page.locator('form.provider-apply-form');
      await form.locator('input[name="businessName"]').fill(businessName);
      await form.locator('input[name="contactName"]').fill('E2E Yetkili');
      await form.locator('input[name="phone"]').fill(uniquePhone());
      await form.locator('select[name="city"]').selectOption(location.city);
      await form.locator('select[name="district"]').selectOption(location.district);
      await form.locator(`input[name="categoryIds"][value="${category.id}"]`).check();
      await form.getByTestId('service-area-city').selectOption(location.city);
      await form.getByTestId('service-area-district').selectOption(location.district);
      await form.getByTestId('service-area-add').click();

      const type = form.locator('select[name="businessRegistrationType"]');
      const number = form.locator('input[name="businessRegistrationNumber"]');
      await type.selectOption('NONE_DECLARED');
      await expect(number).toHaveCount(0);
      await type.selectOption('SOLE_PROPRIETOR_TR_ID');
      await expect(number).toBeVisible();

      // A number whose check digits fail: refused with a sentence, and not echoed in the URL.
      await number.fill('10000000147');
      await form.getByRole('button', { name: 'Başvuruyu Gönder' }).click();
      await expect(applicant.page).toHaveURL(/error=registration-number-invalid/);
      expect(applicant.page.url()).not.toContain('10000000147');
      await expect(applicant.page.getByRole('alert').filter({ hasText: 'türle uyumlu değil' })).toBeVisible();
      expect(await prisma().providerProfile.count({ where: { businessName } })).toBe(0);

      // The form is fresh after the redirect: fill it again, correctly.
      const again = applicant.page.locator('form.provider-apply-form');
      await again.locator('input[name="businessName"]').fill(businessName);
      await again.locator('input[name="contactName"]').fill('E2E Yetkili');
      await again.locator('input[name="phone"]').fill(uniquePhone());
      await again.locator('select[name="city"]').selectOption(location.city);
      await again.locator('select[name="district"]').selectOption(location.district);
      await again.locator(`input[name="categoryIds"][value="${category.id}"]`).check();
      await again.getByTestId('service-area-city').selectOption(location.city);
      await again.getByTestId('service-area-district').selectOption(location.district);
      await again.getByTestId('service-area-add').click();
      await again.locator('select[name="businessRegistrationType"]').selectOption('SOLE_PROPRIETOR_TR_ID');
      await again.locator('input[name="businessRegistrationNumber"]').fill(`${TCKN.slice(0, 3)} ${TCKN.slice(3)}`);
      await again.getByRole('button', { name: 'Başvuruyu Gönder' }).click();
      await expect(applicant.page).toHaveURL(/\/providers\/success$/);
      await assertNoErrorScreen(applicant.page);

      const provider = await prisma().providerProfile.findFirstOrThrow({
        where: { businessName },
        select: { id: true, businessRegistration: { select: { type: true, numberCanonical: true, numberMasked: true } } },
      });
      expect(provider.businessRegistration).toEqual({ type: 'SOLE_PROPRIETOR_TR_ID', numberCanonical: TCKN, numberMasked: TCKN_MASKED });

      // The detail permission shows the mask and no way to the raw value.
      await viewer.loginToAdmin(viewerAccount.email, viewerAccount.password);
      await viewer.gotoAdmin(`/providers/${provider.id}`);
      await assertNoErrorScreen(viewer.page);
      await expect(viewer.page.getByTestId('registration-masked')).toHaveText(TCKN_MASKED);
      await expect(viewer.page.getByTestId('registration-reveal')).toHaveCount(0);
      expect(await viewer.page.content()).not.toContain(TCKN);
      await viewer.gotoAdmin('/providers');
      await expect(viewer.page.getByTestId('provider-registration').filter({ hasText: TCKN_MASKED })).toHaveCount(1);
      expect(await viewer.page.content()).not.toContain(TCKN);

      // The sensitive permission reveals it — and that is one logged read.
      await revealer.loginToAdmin(revealerAccount.email, revealerAccount.password);
      await revealer.gotoAdmin(`/providers/${provider.id}`);
      expect(await revealer.page.content()).not.toContain(TCKN);
      expect(await prisma().sensitiveDataAccessLog.count({ where: { providerId: provider.id } })).toBe(0);
      await revealer.page.getByTestId('registration-reveal').click();
      await expect(revealer.page.getByTestId('registration-raw-number')).toHaveText(TCKN);
      const reads = await prisma().sensitiveDataAccessLog.findMany({ where: { providerId: provider.id } });
      expect(reads).toHaveLength(1);
      expect(reads[0]!.actorId).toBe(revealerAccount.id);
      expect(JSON.stringify(reads)).not.toContain(TCKN);
    } finally {
      await applicant.close();
      await viewer.close();
      await revealer.close();
    }
  });
});

test.describe('promotion eligibility queue', () => {
  test('a held event is decided once, with a reason, and CAMPAIGNS_READ alone cannot open the queue', async ({ browser }) => {
    const owner = await createAdmin();
    const category = await createCategory(3, { namePrefix: 'E2E Uygunluk' });
    const provider = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 0 });
    const seeded = await seedActiveCampaign(owner.id, `e2e-uygunluk-${Date.now().toString(36)}`);
    const event = await prisma().campaignTriggerEvent.create({
      data: {
        triggerEventKey: `PROVIDER_APPROVED:${provider.id}`,
        trigger: 'PROVIDER_APPROVED',
        providerId: provider.id,
        status: 'HELD_FOR_REVIEW',
        attemptCount: 1,
      },
    });
    await prisma().promotionEligibilityHold.create({
      data: {
        triggerEventId: event.id,
        providerId: provider.id,
        snapshotVersion: 1,
        signals: { outcome: 'REVIEW', signals: [{ code: 'REGISTRATION_NONE_DECLARED' }] },
      },
    });
    await prisma().campaignEvaluationLog.create({
      data: {
        triggerEventId: event.id,
        providerId: provider.id,
        campaignId: seeded.campaign.id,
        campaignVersionId: seeded.version.id,
        outcome: 'PROMOTION_REVIEW_HELD',
        reasonCode: 'REGISTRATION_NONE_DECLARED',
      },
    });

    const readerAccount = await createStaffAdmin(['DASHBOARD_READ', 'CAMPAIGNS_READ']);
    const reviewerAccount = await createStaffAdmin(['DASHBOARD_READ', 'PROMOTION_ELIGIBILITY_REVIEW']);
    const reader = await Actor.open(browser, 'reader', primaryRuntime);
    const reviewer = await Actor.open(browser, 'reviewer', primaryRuntime);

    try {
      await reader.loginToAdmin(readerAccount.email, readerAccount.password);
      await expect(reader.page.getByRole('link', { name: 'Uygunluk İncelemesi' })).toHaveCount(0);
      await reader.gotoAdmin('/promotion-eligibility');
      await expect(reader.page).toHaveURL(/\/yetkisiz/);

      await reviewer.loginToAdmin(reviewerAccount.email, reviewerAccount.password);
      await reviewer.gotoAdmin('/promotion-eligibility');
      await assertNoErrorScreen(reviewer.page);
      const row = reviewer.page.locator(`[data-testid="eligibility-row"][data-event="${event.id}"]`);
      await expect(row).toContainText(provider.businessName);
      await expect(row).toContainText('İşletme kaydı beyan edilmedi');
      await row.getByRole('link', { name: 'Detay' }).click();
      await expect(reviewer.page).toHaveURL(new RegExp(`/promotion-eligibility/${event.id}`));
      await expect(reviewer.page.getByTestId('eligibility-signals')).toContainText('İşletme kaydı beyan edilmedi');
      await expect(reviewer.page.getByRole('link', { name: seeded.campaign.name })).toBeVisible();

      // No reason: the browser stops it; nothing is recorded.
      await reviewer.page.getByTestId('eligibility-decision-select').selectOption('INELIGIBLE');
      await reviewer.page.getByTestId('eligibility-submit').click();
      expect(await prisma().promotionEligibilityReview.count({ where: { triggerEventId: event.id } })).toBe(0);

      await reviewer.page.getByTestId('eligibility-reason').fill('E2E: belge sunulmadı, giriş promosyonu verilmesin.');
      await reviewer.page.getByTestId('eligibility-submit').click();
      await expect(reviewer.page.getByTestId('eligibility-done')).toBeVisible();
      await expect(reviewer.page.getByTestId('eligibility-decision')).toContainText('Uygun değil');
      await expect(reviewer.page.getByTestId('eligibility-form')).toHaveCount(0);

      const stored = await prisma().campaignTriggerEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(stored.status).toBe('EVALUATED');
      expect(await prisma().promotionEligibilityReview.findUniqueOrThrow({ where: { triggerEventId: event.id } })).toMatchObject({
        decision: 'INELIGIBLE',
        decidedById: reviewerAccount.id,
      });
      expect(await prisma().campaignRedemption.count({ where: { providerId: provider.id } })).toBe(0);

      await reviewer.gotoAdmin('/promotion-eligibility');
      await expect(reviewer.page.locator(`[data-testid="eligibility-row"][data-event="${event.id}"]`)).toHaveCount(0);
      await reviewer.gotoAdmin('/promotion-eligibility?filter=decided');
      await expect(reviewer.page.locator(`[data-testid="eligibility-row"][data-event="${event.id}"]`)).toContainText('Uygun değil');
    } finally {
      await reader.close();
      await reviewer.close();
    }
  });
});
