import { expect, test, type Page } from '@playwright/test';
import { settleActionRedirect } from '../src/action-redirect';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { confirmThrough } from '../src/confirm-dialog';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  createStaffAdmin,
  prisma,
  uniqueLocation,
  uniquePhone,
  uniqueSuffix,
} from '../src/fixtures';
import { seedReview } from '../src/review-fixtures';
import {
  retireShowcasePlacements,
  seedApprovedShowcaseCard,
  seedLiveShowcasePlacement,
  showcaseAreaKey,
} from '../src/showcase-fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESIGN-001 Faz 3C — Vitrin ve değerlendirmeler: /provider-reviews/reports,
 * /provider-reviews/[reviewId], /showcase/reviews, /showcase/reviews/[versionId],
 * /showcase/cards, /showcase/leads, /showcase/packages, /showcase/price-terms,
 * /showcase/placements, /showcase/placements/[placementId], through the real
 * Next screens.
 *
 * What these pin, beyond the per-flow specs that already cover the same
 * screens (provider-review-flow, showcase-cards, showcase-package-first-flow,
 * showcase-package-price, showcase-placement-lead, showcase-screens-viewport):
 *
 * - The three irreversible-or-outward writes ask first — removing a review
 *   (the customer is mailed), refusing a version, cancelling a run — and
 *   closing the dialog with Esc, Vazgeç or × writes nothing; confirming writes
 *   exactly what the dialog said.
 * - Each write behind its own permission for a staff account (role ADMIN):
 *   PROVIDER_REVIEWS_MODERATE, SHOWCASE_REVIEW_DECIDE, SHOWCASE_PACKAGES_WRITE,
 *   SHOWCASE_PLACEMENTS_MODERATE and SHOWCASE_PLACEMENT_CANCEL each open their
 *   own control and nothing else; a read-only account sees no write control;
 *   an account without the read permission lands on /yetkisiz from a direct URL.
 * - The package window is a URL: direct link, Back and Forward, Esc; the slug
 *   is shown and never sent.
 * - Saved views are URLs; no page is wider than the window at 320, 390, 1440.
 *
 * StickyActionBar is not used by any of these screens, so its integration
 * criterion (Faz 2) does not apply to this slice.
 */

const SCREENS_DIR = resolve(artifactsDir, 'faz-3c-screens');

const READ_ALL = [
  'PROVIDER_REVIEWS_READ',
  'SHOWCASE_REVIEW_READ',
  'SHOWCASE_CARDS_READ',
  'SHOWCASE_LEADS_READ',
  'SHOWCASE_PACKAGES_READ',
  'SHOWCASE_TERMS_ACCEPTANCES_READ',
  'SHOWCASE_PLACEMENTS_READ',
];

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  // The design package's width, so the captures compare one to one.
  await actor.page.setViewportSize({ width: 1440, height: 1617 });
  await actor.loginToAdmin(account.email, account.password);
  return { actor, account };
}

async function expectOpen(page: Page, path: RegExp) {
  await expect(page).toHaveURL(path);
  await assertNoErrorScreen(page);
  await expect(page.getByRole('heading', { name: /yetkiniz yok/i })).toHaveCount(0);
}

async function expectNoPageOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label}: page overflow`).toBeLessThanOrEqual(1);
}

async function capture(page: Page, name: string) {
  const project = test.info().project.name;
  mkdirSync(SCREENS_DIR, { recursive: true });
  const width = page.viewportSize()?.width ?? 0;
  // The window only, as the design package's own 1440×1617 captures are.
  await page.screenshot({ path: resolve(SCREENS_DIR, `${project}-${name}-${width}.png`) });
}

async function staffUserId(email: string) {
  const user = await prisma().user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return user.id;
}

/** A live review of a completed job, with one open report from the reviewed business. */
async function seedReportedReview(comment = 'Faz 3C: 40 dakika geç kaldılar ve haber vermediler.') {
  const location = uniqueLocation();
  const category = await createCategory(2, { namePrefix: 'E2E Faz3C Yorum' });
  const provider = await createProvider({ categoryId: category.id, location, credits: 0 });
  const customer = await createCustomer('E2E Faz3C Müşteri');
  const review = await seedReview({
    providerId: provider.id,
    categoryId: category.id,
    customerId: customer.id,
    location,
    rating: 2,
    comment,
  });
  const report = await prisma().providerReviewReport.create({
    data: { reviewId: review.reviewId, reporterProviderId: provider.id, reason: 'NOT_ABOUT_THIS_JOB', note: 'Bu iş bizde değil.' },
    select: { id: true },
  });
  return { provider, customer, reviewId: review.reviewId, reportId: report.id };
}

/** An approved, live card and a second version of it waiting for review. */
async function seedPendingRevision(title: string) {
  const location = uniqueLocation();
  const category = await createCategory(2, { namePrefix: 'E2E Faz3C Kart' });
  const provider = await createProvider({ categoryId: category.id, location, credits: 0 });
  const { card, version } = await seedApprovedShowcaseCard({
    providerId: provider.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
    title: `${title} (yayında)`,
  });
  const pending = await prisma().showcaseCardVersion.create({
    data: {
      cardId: card.id,
      versionNumber: 2,
      kindSnapshot: 'SERVICE',
      title,
      summary: 'Yeni metin: kombi bakımı, filtre temizliği ve basınç kontrolü aynı gün.',
      scopeIncluded: ['Filtre temizliği', 'Basınç kontrolü'],
      scopeExcluded: ['Yedek parça'],
      listedServicePriceAmount: 145_000,
      listedServiceCurrency: 'TRY',
      responseSlaUrgentHours: 4,
      responseSlaNormalHours: 24,
      priceTermsVersion: 'v1',
      priceTermsAcceptedAt: new Date(),
      reviewStatus: 'PENDING',
      submittedAt: new Date(),
      areas: {
        create: [
          {
            scope: 'DISTRICT',
            city: location.city,
            district: location.district,
            neighborhood: null,
            areaKey: showcaseAreaKey(location.city, location.district),
          },
        ],
      },
    },
    select: { id: true },
  });
  await prisma().showcaseCard.update({ where: { id: card.id }, data: { draftVersionId: pending.id } });
  return { provider, category, location, card, liveVersion: version, pendingVersionId: pending.id };
}

/** A live run of a live card, with one direct lead on it. */
async function seedPlacementWithLead(title: string) {
  const location = uniqueLocation();
  const category = await createCategory(2, { namePrefix: 'E2E Faz3C Yayın' });
  const provider = await createProvider({ categoryId: category.id, location, credits: 0 });
  const customer = await createCustomer('E2E Faz3C Vitrin Müşterisi');
  const { card, version } = await seedApprovedShowcaseCard({
    providerId: provider.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
    title,
  });
  const { placement, purchase } = await seedLiveShowcasePlacement({
    providerId: provider.id,
    cardId: card.id,
    versionId: version.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
  });
  const db = prisma();
  const now = new Date();
  const request = await db.serviceRequest.create({
    data: {
      categoryId: category.id,
      customerId: customer.id,
      requestNumber: `TR-E2E-${uniqueSuffix()}`,
      customerName: customer.name,
      customerPhone: uniquePhone(),
      customerEmail: customer.email,
      city: location.city,
      district: location.district,
      description: 'Vitrin kartından gelen talep.',
      status: 'SUBMITTED',
      directShowcaseProviderId: provider.id,
      phoneVerifiedAt: now,
    },
    select: { id: true, requestNumber: true },
  });
  const lead = await db.showcaseLead.create({
    data: {
      requestId: request.id,
      placementId: placement.id,
      cardId: card.id,
      cardVersionId: version.id,
      kindSnapshot: 'SERVICE',
      listedPriceSnapshot: 150_000,
      providerId: provider.id,
      urgencyBucket: 'URGENT',
      slaHoursSnapshot: 3,
      slaDueAt: new Date(now.getTime() + 3 * 60 * 60 * 1000),
      status: 'OPEN',
    },
    select: { id: true },
  });
  await db.serviceRequest.update({ where: { id: request.id }, data: { showcaseLeadId: lead.id } });
  return { provider, card, version, placement, purchase, request, leadId: lead.id };
}

/** Opens a ConfirmDialog from its trigger and closes it the three ways that must not write. */
async function closeWithoutWriting(page: Page, triggerTestId: string, assertUnchanged: () => Promise<void>) {
  const dialog = page.getByTestId(`${triggerTestId}-dialog`);
  for (const how of ['Escape', 'Vazgeç', '×'] as const) {
    await page.getByTestId(triggerTestId).click();
    await expect(dialog, how).toBeVisible();
    if (how === 'Escape') {
      await page.keyboard.press('Escape');
    } else if (how === 'Vazgeç') {
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
    } else {
      await dialog.getByRole('button', { name: 'Kapat' }).click();
    }
    await expect(dialog, how).toBeHidden();
    await assertUnchanged();
  }
}

test.describe('ADMIN-DESIGN-001 Faz 3C — vitrin ve değerlendirmeler', () => {
  test('a review removal asks first; closing the dialog writes nothing, confirming removes and logs it', async ({
    browser,
  }) => {
    const seeded = await seedReportedReview();
    const { actor: staff, account } = await openAs(browser, ['PROVIDER_REVIEWS_READ', 'PROVIDER_REVIEWS_MODERATE']);
    const page = staff.page;
    const staffId = await staffUserId(account.email);
    const moderationRows = () => prisma().providerReviewModeration.count({ where: { reviewId: seeded.reviewId } });

    try {
      await staff.gotoAdmin('/provider-reviews/reports');
      await expectOpen(page, /\/provider-reviews\/reports$/);
      await expect(page.getByRole('heading', { name: 'Şikayet edilen yorumlar' })).toBeVisible();
      const row = page.locator(`[data-testid="review-report-row"][data-review-id="${seeded.reviewId}"]`);
      await expect(row).toContainText('40 dakika geç kaldılar');
      await expect(row.getByTestId('review-report-pending')).toHaveText('Karar bekliyor');
      await capture(page, 'sikayet-edilen-yorumlar');

      await row.getByRole('link', { name: 'Aç' }).click();
      await expectOpen(page, new RegExp(`/provider-reviews/${seeded.reviewId}$`));
      await expect(page.getByTestId('review-detail-header')).toContainText(seeded.provider.businessName);
      await expect(page.getByTestId('review-report-decisions')).toBeVisible();
      await capture(page, 'degerlendirme-detayi');

      await page.getByTestId('moderate-REMOVE_REVIEW').click();
      await page.getByTestId('moderation-reason').selectOption('NOT_ABOUT_THIS_JOB');
      await page.getByTestId('moderation-note').fill('Faz 3C E2E: iş bu firmada değil.');
      const dialog = page.getByTestId('moderation-submit-dialog');
      await page.getByTestId('moderation-submit').click();
      await expect(dialog).toContainText('müşteriye');
      await expect(dialog).toContainText('puan ortalaması');
      await expect(dialog).toContainText('Açık bildirim');
      await capture(page, 'degerlendirme-kaldir-diyalogu');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();

      await closeWithoutWriting(page, 'moderation-submit', async () => {
        expect(await moderationRows()).toBe(0);
        const review = await prisma().providerReview.findUniqueOrThrow({ where: { id: seeded.reviewId } });
        expect(review.removedAt).toBeNull();
      });
      // The fields survive the closed dialog; confirming sends them.
      await expect(page.getByTestId('moderation-reason')).toHaveValue('NOT_ABOUT_THIS_JOB');
      await page.getByTestId('moderation-submit').click();
      await dialog.getByRole('button', { name: 'Evet, değerlendirmeyi kaldır' }).click();

      await expect(page.getByTestId('review-state')).toHaveText('Kaldırıldı');
      await expect(page.getByTestId('review-ok')).toBeVisible();
      const log = await prisma().providerReviewModeration.findMany({ where: { reviewId: seeded.reviewId } });
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ action: 'REMOVE_REVIEW', reason: 'NOT_ABOUT_THIS_JOB', performedById: staffId });
      const report = await prisma().providerReviewReport.findUniqueOrThrow({ where: { id: seeded.reportId } });
      expect(report.resolution).toBe('REVIEW_REMOVED');
      expect(report.resolvedByUserId).toBe(staffId);

      // A restore does not mail anybody and does not ask.
      await page.getByTestId('moderate-RESTORE').click();
      await expect(page.getByTestId('moderation-submit')).not.toHaveAttribute('aria-haspopup', 'dialog');
      await page.getByTestId('moderation-submit').click();
      await expect(page.getByTestId('review-state')).toHaveText('Yayında');
      expect(await moderationRows()).toBe(2);

      // The resolved view is a URL.
      await page.getByTestId('review-detail-header').getByRole('link', { name: /Şikayet edilen yorumlar/ }).click();
      await page.getByTestId('review-report-view-resolved').click();
      await expect(page).toHaveURL(/state=resolved/);
      await expect(page.locator(`[data-testid="review-report-row"][data-review-id="${seeded.reviewId}"]`)).toHaveCount(1);
      await page.goBack();
      await expect(page).toHaveURL(/\/provider-reviews\/reports$/);
      await page.goForward();
      await expect(page).toHaveURL(/state=resolved/);
    } finally {
      await staff.close();
    }
  });

  test('refusing a version asks first; closing writes nothing, confirming leaves the live text on the air', async ({
    browser,
  }) => {
    const seeded = await seedPendingRevision(`E2E Faz3C Revizyon ${uniqueSuffix()}`);
    const { actor: staff, account } = await openAs(browser, ['SHOWCASE_REVIEW_READ', 'SHOWCASE_REVIEW_DECIDE']);
    const page = staff.page;
    const staffId = await staffUserId(account.email);
    const statusOf = async () =>
      (await prisma().showcaseCardVersion.findUniqueOrThrow({ where: { id: seeded.pendingVersionId } })).reviewStatus;

    try {
      await staff.gotoAdmin('/showcase/reviews');
      await expectOpen(page, /\/showcase\/reviews$/);
      await expect(page.getByRole('heading', { name: 'Onay bekleyen kartlar' })).toBeVisible();
      const row = page.locator(`[data-testid="showcase-review-row"][data-version-id="${seeded.pendingVersionId}"]`);
      await expect(row).toContainText('2. sürüm · yayındaki metni değiştirir');
      // No SHOWCASE_CARDS_READ: no way to the full card list.
      await expect(page.getByTestId('showcase-all-cards-link')).toHaveCount(0);
      await capture(page, 'onay-bekleyen-kartlar');

      await row.getByRole('link', { name: 'Aç' }).click();
      await expectOpen(page, new RegExp(`/showcase/reviews/${seeded.pendingVersionId}$`));
      await expect(page.getByRole('button', { name: 'Onayla' })).toBeEnabled();
      await capture(page, 'surum-inceleme-detayi');

      await page.getByLabel('Ret gerekçesi *').fill('Faz 3C E2E: fiyat kapsamla uyuşmuyor.');
      const dialog = page.getByTestId('showcase-reject-dialog');
      await page.getByTestId('showcase-reject').click();
      await expect(dialog).toContainText('Yayındaki 1. sürüm yayında kalır');
      // API-HARDENING-001: the note reaches the provider's panel, and one mail
      // without the note tells them it is there.
      await expect(dialog).toContainText('kart sayfasında “İnceleme notu” olarak görünür');
      await expect(dialog).toContainText('Notunuz e-postaya eklenmez');
      await capture(page, 'surum-reddet-diyalogu');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();

      await closeWithoutWriting(page, 'showcase-reject', async () => {
        expect(await statusOf()).toBe('PENDING');
        expect(await prisma().showcaseCardReview.count({ where: { cardVersionId: seeded.pendingVersionId } })).toBe(0);
      });
      await expect(page.getByLabel('Ret gerekçesi *')).toHaveValue('Faz 3C E2E: fiyat kapsamla uyuşmuyor.');
      await page.getByTestId('showcase-reject').click();
      await dialog.getByRole('button', { name: 'Evet, sürümü reddet' }).click();

      await expect(page.getByTestId('showcase-rejected-notice')).toContainText('Yayındaki sürüm yayında kalır');
      expect(await statusOf()).toBe('REJECTED');
      const card = await prisma().showcaseCard.findUniqueOrThrow({ where: { id: seeded.card.id } });
      expect(card.status).toBe('APPROVED');
      expect(card.liveVersionId).toBe(seeded.liveVersion.id);
      const review = await prisma().showcaseCardReview.findFirstOrThrow({
        where: { cardVersionId: seeded.pendingVersionId },
      });
      expect(review).toMatchObject({ decision: 'REJECTED', reviewedById: staffId });
      const notices = await prisma().notificationLog.findMany({
        where: { dedupeKey: `showcase-card-revision-rejected:${seeded.pendingVersionId}` },
      });
      expect(notices).toHaveLength(1);
    } finally {
      await staff.close();
    }
  });

  test('cancelling a run asks first; closing writes nothing, confirming ends it and flags the purchase', async ({
    browser,
  }) => {
    const seeded = await seedPlacementWithLead(`E2E Faz3C İptal Kartı ${uniqueSuffix()}`);
    const { actor: staff, account } = await openAs(browser, ['SHOWCASE_PLACEMENTS_READ', 'SHOWCASE_PLACEMENT_CANCEL']);
    const page = staff.page;
    const staffId = await staffUserId(account.email);
    const placementOf = () =>
      prisma().showcasePlacement.findUniqueOrThrow({ where: { id: seeded.placement.id } });
    const purchaseOf = () => prisma().packagePurchase.findUniqueOrThrow({ where: { id: seeded.purchase.id } });

    try {
      await staff.gotoAdmin(`/showcase/placements/${seeded.placement.id}`);
      await expectOpen(page, new RegExp(`/showcase/placements/${seeded.placement.id}$`));
      await expect(page.getByTestId('placement-header')).toContainText(seeded.provider.businessName);
      // SHOWCASE_PLACEMENT_CANCEL does not open the hold.
      await expect(page.getByRole('button', { name: 'Yerleşimi durdur' })).toHaveCount(0);
      await capture(page, 'yerlesim-detayi');

      // ADMIN-DESTRUCTIVE-CONFIRMATION-001: the reason is required. Empty,
      // the browser refuses the form and the dialog never opens.
      const dialog = page.getByTestId('placement-cancel-dialog');
      const note = page.getByTestId('placement-cancel-form').getByRole('textbox', { name: 'İptal gerekçesi *' });
      await expect(note).toHaveAttribute('required', '');
      await expect
        .poll(() =>
          page
            .getByTestId('placement-cancel')
            .evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps'))),
        )
        .toBe(true);
      await page.getByTestId('placement-cancel').click();
      await expect(dialog).toBeHidden();
      expect(await note.evaluate((element) => (element as HTMLTextAreaElement).validity.valueMissing)).toBe(true);
      expect((await placementOf()).status).toBe('ACTIVE');

      // With the browser's check taken off, a blank reason reaches the action,
      // which refuses it before any request: nothing changes.
      await note.evaluate((element) => {
        element.removeAttribute('required');
        element.removeAttribute('minlength');
      });
      await note.fill('   kısa   ');
      await page.getByTestId('placement-cancel').click();
      await dialog.getByRole('button', { name: 'Evet, kalıcı olarak iptal et' }).click();
      await expect(page.locator('.notice-error')).toContainText('İptal gerekçesi zorunludur');
      expect((await placementOf()).status).toBe('ACTIVE');
      expect(await prisma().showcasePlacementCancellation.count({ where: { placementId: seeded.placement.id } })).toBe(0);

      await expect(note).toHaveAttribute('required', '');
      await note.fill('Faz 3C E2E iptali');
      await page.getByTestId('placement-cancel').click();
      await expect(dialog).toContainText('Geri alınamaz');
      await expect(dialog).toContainText('Para iadesi yapılmaz');
      await expect(dialog).toContainText('manuel inceleme');
      await expect(dialog).toContainText('iptal eden kişi ve yazdığınız gerekçe yerleşimin kalıcı kaydına yazılır');
      await capture(page, 'yerlesim-iptal-diyalogu');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();

      await closeWithoutWriting(page, 'placement-cancel', async () => {
        expect((await placementOf()).status).toBe('ACTIVE');
        expect((await purchaseOf()).manualReviewAt).toBeNull();
      });
      await page.getByTestId('placement-cancel').click();
      await dialog.getByRole('button', { name: 'Evet, kalıcı olarak iptal et' }).click();

      await expect(page.getByTestId('placement-cancelled-notice')).toContainText('Para iadesi yapılmadı');
      await expect(page.getByTestId('placement-status')).toHaveText('İptal edildi');
      const cancelled = await placementOf();
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancelledAt).not.toBeNull();
      const purchase = await purchaseOf();
      expect(purchase.manualReviewReason).toBe('SHOWCASE_PLACEMENT_CANCELLED');
      expect(purchase.adminNote).toBe('Faz 3C E2E iptali');
      // API-HARDENING-001: who cancelled it is on the record and on the screen.
      const record = await prisma().showcasePlacementCancellation.findUniqueOrThrow({
        where: { placementId: seeded.placement.id },
      });
      expect(record).toMatchObject({ actorUserId: staffId, note: 'Faz 3C E2E iptali' });
      await expect(page.getByTestId('placement-cancelled-by')).toContainText('Faz 3C E2E iptali');
      expect(
        await prisma().showcasePlacementShelf.count({ where: { placementId: seeded.placement.id, active: true } }),
      ).toBe(0);
      // The lead on it is untouched.
      expect((await prisma().showcaseLead.findUniqueOrThrow({ where: { id: seeded.leadId } })).status).toBe('OPEN');
      await expect(page.getByTestId('placement-cancel')).toHaveCount(0);

      // The saved views are URLs with exact counts: the run is under İptal edildi.
      await page.getByTestId('placement-header').getByRole('link', { name: /Yayında olan kartlar/ }).click();
      await page.getByTestId('placement-view-cancelled').click();
      await expect(page).toHaveURL(/status=CANCELLED/);
      await expect(page.getByTestId('placement-row').filter({ hasText: seeded.version.title })).toHaveAttribute(
        'data-status',
        'CANCELLED',
      );
      await page.goBack();
      await expect(page).toHaveURL(/\/showcase\/placements$/);
      await page.goForward();
      await expect(page).toHaveURL(/status=CANCELLED/);
    } finally {
      await staff.close();
      await retireShowcasePlacements([seeded.placement.id]);
    }
  });

  test('each write is behind its own permission; read-only staff sees no write control; no read permission is /yetkisiz', async ({
    browser,
  }) => {
    const reported = await seedReportedReview('Faz 3C: salt okunur personel yorumu.');
    const revision = await seedPendingRevision(`E2E Faz3C Salt Okunur ${uniqueSuffix()}`);
    const run = await seedPlacementWithLead(`E2E Faz3C Salt Okunur Yayın ${uniqueSuffix()}`);
    const pkg = await prisma().showcasePackage.findUniqueOrThrow({ where: { id: run.placement.showcasePackageId } });

    const { actor: reader } = await openAs(browser, READ_ALL);
    const { actor: moderator } = await openAs(browser, ['SHOWCASE_PLACEMENTS_READ', 'SHOWCASE_PLACEMENTS_MODERATE']);
    const { actor: outsider } = await openAs(browser, ['DASHBOARD_READ']);

    try {
      const page = reader.page;

      await reader.gotoAdmin(`/provider-reviews/${reported.reviewId}`);
      await expectOpen(page, new RegExp(`/provider-reviews/${reported.reviewId}$`));
      await expect(page.getByTestId('review-moderation')).toHaveCount(0);
      await expect(page.getByTestId('review-report-decisions')).toHaveCount(0);

      await reader.gotoAdmin(`/showcase/reviews/${revision.pendingVersionId}`);
      await expectOpen(page, new RegExp(`/showcase/reviews/${revision.pendingVersionId}$`));
      await expect(page.getByRole('button', { name: 'Onayla' })).toHaveCount(0);
      await expect(page.getByTestId('showcase-reject')).toHaveCount(0);

      await reader.gotoAdmin(`/showcase/placements/${run.placement.id}`);
      await expectOpen(page, new RegExp(`/showcase/placements/${run.placement.id}$`));
      await expect(page.getByRole('button', { name: 'Yerleşimi durdur' })).toHaveCount(0);
      await expect(page.getByTestId('placement-cancel')).toHaveCount(0);

      await reader.gotoAdmin('/showcase/packages');
      await expectOpen(page, /\/showcase\/packages$/);
      await expect(page.getByTestId('showcase-package-new')).toHaveCount(0);
      // The package window moved to its own screen (Faz 3F.1). The old link
      // lands there, for reading: the values, and no form and no switch.
      await reader.gotoAdmin(`/showcase/packages?paket=${pkg.id}`);
      await expectOpen(page, new RegExp(`/showcase/packages/${pkg.id}$`));
      await expect(page.getByTestId('showcase-package-read-only')).toBeVisible();
      await expect(page.getByTestId('showcase-package-slug')).toContainText(pkg.slug);
      await expect(page.getByTestId('showcase-package-edit-form')).toHaveCount(0);
      await expect(page.locator('input[name="packageId"]')).toHaveCount(0);
      await expect(page.getByTestId('showcase-package-status-toggle')).toHaveCount(0);
      await expect(page.getByTestId('showcase-package-header').getByRole('link', { name: 'Metin onayları' })).toBeVisible();
      // Sales are PACKAGE_PURCHASES_READ: no tab, and asking for it by URL
      // lands on the first tab.
      await expect(page.getByTestId('showcase-package-tab-satislar')).toHaveCount(0);
      await reader.gotoAdmin(`/showcase/packages/${pkg.id}?tab=satislar`);
      await expect(page.getByTestId('showcase-package-panel-bilgiler')).toBeVisible();
      await expect(page.getByTestId('showcase-package-sales')).toHaveCount(0);
      await reader.gotoAdmin(`/showcase/packages/${pkg.id}?tab=gecmis`);
      await expect(page.getByTestId('showcase-package-activity')).toContainText('değişiklik yapılmadı');
      // The new-package window is not a way in either.
      await reader.gotoAdmin('/showcase/packages?paket=yeni');
      await expect(page.getByTestId('showcase-package-dialog')).toHaveCount(0);

      // No card is suspended from the panel (K9): the API has the route, the
      // screen has no caller.
      await reader.gotoAdmin('/showcase/cards');
      await expectOpen(page, /\/showcase\/cards$/);
      await expect(page.getByRole('button', { name: /askıya al/i })).toHaveCount(0);

      // The leads list names no customer contact.
      await reader.gotoAdmin('/showcase/leads');
      await expectOpen(page, /\/showcase\/leads$/);
      const leadsText = await page.locator('main').innerText();
      expect(leadsText).not.toContain('@example.test');

      // SHOWCASE_PLACEMENTS_MODERATE opens the hold and not the cancel.
      await moderator.gotoAdmin(`/showcase/placements/${run.placement.id}`);
      await expectOpen(moderator.page, new RegExp(`/showcase/placements/${run.placement.id}$`));
      await expect(moderator.page.getByRole('button', { name: 'Yerleşimi durdur' })).toBeVisible();
      await expect(moderator.page.getByTestId('placement-cancel')).toHaveCount(0);

      // Without the read permission every route is /yetkisiz, and the menu has
      // no vitrin row.
      for (const path of [
        '/provider-reviews/reports',
        `/provider-reviews/${reported.reviewId}`,
        '/showcase/reviews',
        `/showcase/reviews/${revision.pendingVersionId}`,
        '/showcase/cards',
        '/showcase/leads',
        '/showcase/packages',
        `/showcase/packages/${pkg.id}`,
        '/showcase/price-terms',
        '/showcase/placements',
        `/showcase/placements/${run.placement.id}`,
      ]) {
        await outsider.gotoAdmin(path);
        await expect(outsider.page, path).toHaveURL(/\/yetkisiz$/);
      }
      await outsider.gotoAdmin('/');
      await expect(outsider.page.locator('#admin-sidebar')).not.toContainText('Vitrin');
      await expect(outsider.page.locator('#admin-sidebar')).not.toContainText('Şikayet edilen yorumlar');
    } finally {
      await Promise.all([reader.close(), moderator.close(), outsider.close()]);
      await retireShowcasePlacements([run.placement.id]);
    }
  });

  test('the package has its own screen: the list opens it, an old window link lands on it, the slug is shown and never sent', async ({
    browser,
  }) => {
    const { actor: staff } = await openAs(browser, ['SHOWCASE_PACKAGES_READ', 'SHOWCASE_PACKAGES_WRITE']);
    const page = staff.page;
    const slug = `vitrin-e2e-faz3c-${Date.now()}`;
    const pkg = await prisma().showcasePackage.create({
      data: { name: `E2E Faz3C Paket ${uniqueSuffix()}`, slug, priceAmount: 240_000, currency: 'TRY', durationDays: 30 },
    });
    const screen = new RegExp(`/showcase/packages/${pkg.id}$`);

    try {
      await staff.gotoAdmin('/showcase/packages');
      await expectOpen(page, /\/showcase\/packages$/);
      const row = page.locator(`[data-testid="showcase-package-row"][data-package-id="${pkg.id}"]`);
      await capture(page, 'vitrin-paketleri');

      await row.getByTestId('showcase-package-open').click();
      await expectOpen(page, screen);
      await expect(page.getByTestId('showcase-package-slug')).toContainText(slug);
      const form = page.getByTestId('showcase-package-edit-form');
      await expect(form).toBeVisible();
      await expect(form.locator('[name="slug"]')).toHaveCount(0);
      // Without PACKAGE_PURCHASES_READ there is no sales tab.
      await expect(page.getByTestId('showcase-package-tab-satislar')).toHaveCount(0);
      await capture(page, 'vitrin-paketi-detayi');

      // Back returns to the list, Forward to the package.
      await page.goBack();
      await expect(page).toHaveURL(/\/showcase\/packages$/);
      await page.goForward();
      await expect(page).toHaveURL(screen);

      // Vazgeç puts the fields back and writes nothing.
      const before = (await prisma().showcasePackage.findUniqueOrThrow({ where: { id: pkg.id } })).updatedAt;
      await form.locator('input[name="name"]').fill('Kaydedilmeyecek ad');
      await form.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(form.locator('input[name="name"]')).toHaveValue(pkg.name);
      const untouched = await prisma().showcasePackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(untouched.updatedAt).toEqual(before);
      expect(untouched.name).toBe(pkg.name);

      // Saving writes every field it shows, keeps the slug, and stays here.
      await form.locator('input[name="name"]').fill('E2E Faz3C Paket (yeni ad)');
      await form.locator('input[name="durationDays"]').fill('14');
      // The run length is a sales term: the save asks, old → new (Paket A).
      await confirmThrough(form.getByRole('button', { name: 'Kaydet', exact: true }), 'Evet, kaydet', async (durationDialog) => {
        await expect(durationDialog.getByTestId('showcase-package-commercial-changes')).toContainText('→ 14 gün');
      });
      await expect(page).toHaveURL(new RegExp(`/showcase/packages/${pkg.id}\\?saved=1$`));
      const saved = await prisma().showcasePackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(saved).toMatchObject({ name: 'E2E Faz3C Paket (yeni ad)', durationDays: 14, slug, isActive: true });

      // The form's Durum select is the window's checkbox: "Kapalı" sends false.
      await form.getByTestId('showcase-package-active').selectOption('off');
      await confirmThrough(form.getByRole('button', { name: 'Kaydet', exact: true }), 'Evet, kaydet', async (offDialog) => {
        await expect(offDialog.getByTestId('showcase-package-status-change')).toContainText('Satışta → Kapalı');
      });
      await expect(page).toHaveURL(/saved=1/);
      await expect.poll(async () => (await prisma().showcasePackage.findUniqueOrThrow({ where: { id: pkg.id } })).isActive).toBe(false);

      // The header's switch is the same PATCH with isActive alone.
      await confirmThrough(page.getByTestId('showcase-package-status-toggle'), 'Evet, satışa aç', async (openDialog) => {
        await expect(openDialog).toContainText('14 gün');
      });
      await expect(page).toHaveURL(/activated=1/);
      const reopened = await prisma().showcasePackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(reopened).toMatchObject({ isActive: true, name: 'E2E Faz3C Paket (yeni ad)', durationDays: 14 });
      // Redirects to this same screen: landed before the next goto (settleActionRedirect).
      await settleActionRedirect(page, () =>
        confirmThrough(page.getByTestId('showcase-package-status-toggle'), 'Evet, satıştan kaldır', async (closeDialog) => {
          await expect(closeDialog).toContainText('değişmez');
        }),
      );
      await expect(page).toHaveURL(/deactivated=1/);
      await expect.poll(async () => (await prisma().showcasePackage.findUniqueOrThrow({ where: { id: pkg.id } })).isActive).toBe(false);

      // "Neler oldu" is the package's audit (ADMIN-ACTION-AUDIT-001): each
      // save above with its field diff, newest first.
      await staff.gotoAdmin(`/showcase/packages/${pkg.id}?tab=gecmis`);
      const activity = page.getByTestId('showcase-package-activity');
      await expect(activity.getByTestId('audit-row')).toHaveCount(4);
      await expect(activity.getByTestId('audit-row').first()).toContainText('Durumu değişti');
      await expect(activity.getByTestId('audit-row').first()).toContainText('Aktif → Pasif');
      await expect(activity).toContainText('E2E Faz3C Paket (yeni ad)');
      await expect(page.getByTestId('showcase-package-activity-footnote')).toContainText('kaydedilmediği için');

      // An old window link lands on the screen; one to a package that does
      // not exist says so on the list.
      await staff.gotoAdmin(`/showcase/packages?paket=${pkg.id}`);
      await expect(page).toHaveURL(screen);
      await staff.gotoAdmin('/showcase/packages?paket=yok-boyle-paket');
      await expect(page.getByTestId('showcase-package-missing')).toBeVisible();
      await expect(page.getByTestId('showcase-package-dialog')).toHaveCount(0);
    } finally {
      await prisma().showcasePackage.update({ where: { id: pkg.id }, data: { isActive: false } });
      await staff.close();
    }
  });

  test('every screen fits 320, 390 and 1440px with records on it', async ({ browser }) => {
    const reported = await seedReportedReview('Faz 3C: dar ekranda uzun bir yorum satırı, kaydırma olmadan sarmalı.');
    const revision = await seedPendingRevision(`E2E Faz3C Dar Ekran ${uniqueSuffix()}`);
    const run = await seedPlacementWithLead(`E2E Faz3C Dar Ekran Yayın ${uniqueSuffix()}`);
    const { actor: admin } = await openAs(browser, 'super');
    const page = admin.page;

    const routes: Array<[string, string]> = [
      ['/provider-reviews/reports', 'sikayet-edilen-yorumlar'],
      [`/provider-reviews/${reported.reviewId}`, 'degerlendirme-detayi'],
      ['/showcase/reviews', 'onay-bekleyen-kartlar'],
      [`/showcase/reviews/${revision.pendingVersionId}`, 'surum-inceleme-detayi'],
      ['/showcase/cards', 'vitrin-kartlari'],
      [`/showcase/cards?cardId=${revision.card.id}`, 'vitrin-karti-tek'],
      ['/showcase/leads', 'vitrinden-gelen-talepler'],
      ['/showcase/packages', 'vitrin-paketleri'],
      [`/showcase/packages/${run.placement.showcasePackageId}`, 'vitrin-paketi-detayi'],
      [`/showcase/packages/${run.placement.showcasePackageId}?tab=satislar`, 'vitrin-paketi-satislar'],
      [`/showcase/packages/${run.placement.showcasePackageId}?tab=gecmis`, 'vitrin-paketi-gecmis'],
      ['/showcase/price-terms', 'vitrin-metin-onaylari'],
      ['/showcase/placements', 'yayinda-olan-kartlar'],
      [`/showcase/placements/${run.placement.id}`, 'yerlesim-detayi'],
    ];

    try {
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1617 : 900 });
        for (const [path, name] of routes) {
          await admin.gotoAdmin(path);
          await assertNoErrorScreen(page);
          await expectNoPageOverflow(page, `${path} @${width}`);
          if (width === 1440 || width === 320) await capture(page, `super-${name}`);
        }
      }

      // The package's sales tab lists the run the seeded purchase became.
      await page.setViewportSize({ width: 1440, height: 1617 });
      await admin.gotoAdmin(`/showcase/packages/${run.placement.showcasePackageId}?tab=satislar`);
      await expect(page.getByTestId('showcase-sales-total')).toContainText('1');
      await expect(page.getByTestId('showcase-sales-live')).toContainText('1');
      const sale = page.getByTestId('showcase-sale-row');
      await expect(sale).toHaveCount(1);
      await expect(sale).toContainText('Ödendi');
      await expect(sale).toContainText('Yayında');
      await expect(sale.getByRole('link', { name: 'Yayında' })).toHaveAttribute('href', `/showcase/placements/${run.placement.id}`);
      // ADMIN-BACKEND-TRUTH-001: the figures and the right are the API's. This
      // seeded purchase is a legacy card-bound one: it settled straight into a
      // run and granted no right, which the row says rather than guessing.
      await expect(sale.getByTestId('showcase-sale-right')).toContainText('Doğrudan yayın');
      await expect(page.getByTestId('showcase-sales-rights')).toContainText('0');
      await expect(page.getByTestId('showcase-sales-count')).toContainText('1 satış');

      // The single-card link from the consent ledger now shows that card.
      await admin.gotoAdmin(`/showcase/cards?cardId=${revision.card.id}`);
      await expect(page.getByTestId('card-single-filter')).toBeVisible();
      await expect(page.getByTestId('card-row')).toHaveCount(1);
      await expect(page.locator(`[data-card-id="${revision.card.id}"]`)).toBeVisible();

      // The lead reads the request, the business and the reservation, no contact.
      await admin.gotoAdmin('/showcase/leads?status=OPEN');
      const lead = page.getByTestId('lead-row').filter({ hasText: run.request.requestNumber ?? '' });
      await expect(lead).toContainText('Yalnız bu işletmeye açık');
      await expect(lead).toContainText('3 saat taahhüt');
    } finally {
      await admin.close();
      await retireShowcasePlacements([run.placement.id]);
    }
  });
});
