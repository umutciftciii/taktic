import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { clickBeforeHydration, confirmThrough, waitForHydration } from '../src/confirm-dialog';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  prisma,
  uniqueLocation,
  uniqueSuffix,
} from '../src/fixtures';
import { seedReview } from '../src/review-fixtures';
import {
  retireShowcasePlacements,
  seedApprovedShowcaseCard,
  seedLiveShowcasePlacement,
  showcaseAreaKey,
} from '../src/showcase-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Birleşik Paket B, in the browser.
 *
 * The new confirmations that need a real session and real data to mean
 * anything:
 *
 * - a vitrin revision approval asks, counts the card's real runs, and a click
 *   before hydration writes nothing; suspending a run needs a reason and a
 *   dialog, and resuming stays one press with the end date it will produce;
 * - a category created live asks; an edit that moves the slug and the offer
 *   price asks once with both; closing and reopening a category with a live
 *   vitrin run asks with the real count and suspends / resumes that run;
 *   deactivating a question asks and leaves the row in place;
 * - "Uygun bulundu" on a reported review asks and keeps the review live.
 *
 * Support "Çözüldü", invite revoke, the refund request from a ticket, the
 * company settings and the refund window go through their dialogs in the
 * specs that already drive those screens.
 */

async function openAs(browser: Parameters<typeof Actor.open>[0]) {
  const account = await createAdmin();
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.page.setViewportSize({ width: 1440, height: 1200 });
  await actor.loginToAdmin(account.email, account.password);
  return { actor, account };
}

/** A live card with one ACTIVE run, in its own category. */
async function seedLiveRun(title: string, categoryPrefix: string) {
  const location = uniqueLocation();
  const category = await createCategory(2, { namePrefix: categoryPrefix });
  const provider = await createProvider({ categoryId: category.id, location, credits: 0 });
  const { card, version } = await seedApprovedShowcaseCard({
    providerId: provider.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
    title,
  });
  const { placement } = await seedLiveShowcasePlacement({
    providerId: provider.id,
    cardId: card.id,
    versionId: version.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
  });
  return { location, category, provider, card, liveVersion: version, placement };
}

async function placementRow(id: string) {
  return prisma().showcasePlacement.findUniqueOrThrow({
    where: { id },
    select: { status: true, suspendReason: true, pinnedVersionId: true },
  });
}

function refusal(page: Page) {
  return page.locator('.notice-error').filter({ hasText: 'onay penceresinden onay alınamadı' });
}

test.describe('ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Paket B', () => {
  test('vitrin: a revision approval asks with the real run count; a suspension needs a reason and a dialog', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const seeded = await seedLiveRun(`E2E Paket B Revizyon ${uniqueSuffix()}`, 'E2E PaketB Vitrin');
    const pending = await prisma().showcaseCardVersion.create({
      data: {
        cardId: seeded.card.id,
        versionNumber: 2,
        kindSnapshot: 'SERVICE',
        title: `E2E Paket B yeni metin ${uniqueSuffix()}`,
        summary: 'Yeni metin: kombi bakımı, filtre temizliği ve basınç kontrolü aynı gün.',
        scopeIncluded: ['Filtre temizliği'],
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
              city: seeded.location.city,
              district: seeded.location.district,
              neighborhood: null,
              areaKey: showcaseAreaKey(seeded.location.city, seeded.location.district),
            },
          ],
        },
      },
      select: { id: true },
    });
    await prisma().showcaseCard.update({ where: { id: seeded.card.id }, data: { draftVersionId: pending.id } });
    const { actor, account } = await openAs(browser);
    const page = actor.page;
    const reviewUrl = `${primaryRuntime.adminUrl}/showcase/reviews/${pending.id}`;

    try {
      // ---- a click before hydration: refused, nothing approved ------------
      await clickBeforeHydration(page, reviewUrl, page.getByTestId('showcase-revision-approve'));
      await expect(refusal(page)).toBeVisible();
      expect(
        (await prisma().showcaseCardVersion.findUniqueOrThrow({ where: { id: pending.id } })).reviewStatus,
      ).toBe('PENDING');

      // ---- through the dialog: the real count, no way back, the mail ------
      await confirmThrough(
        page.getByTestId('showcase-revision-approve'),
        'Evet, onayla ve yayındakini değiştir',
        async (dialog) => {
          const impact = dialog.getByTestId('showcase-revision-approve-impact');
          await expect(impact).toContainText('2. sürüm, yayındaki 1. sürümün yerini alır');
          await expect(dialog.getByTestId('showcase-revision-approve-placements')).toContainText(
            'bitmemiş 1 yerleşimi var (1 tanesi şu anda yayında)',
          );
          await expect(impact).toContainText('Eski sürüme dönüş yok');
          await expect(impact).toContainText('e-posta gider');
        },
      );
      await expect
        .poll(async () => (await prisma().showcaseCardVersion.findUniqueOrThrow({ where: { id: pending.id } })).reviewStatus)
        .toBe('APPROVED');
      expect((await placementRow(seeded.placement.id)).pinnedVersionId).toBe(pending.id);
      await assertNoErrorScreen(page);

      // ---- suspending: no reason, no dialog; with one, the dialog ----------
      await actor.gotoAdmin(`/showcase/placements/${seeded.placement.id}`);
      const suspend = page.getByTestId('placement-suspend');
      await waitForHydration(suspend);
      await suspend.click();
      await expect(page.getByTestId('placement-suspend-dialog')).toBeHidden();
      expect((await placementRow(seeded.placement.id)).status).toBe('ACTIVE');

      await page.getByTestId('placement-suspend-note').fill('  Şikâyet incelemesi için durduruldu  ');
      await confirmThrough(suspend, 'Evet, yayından kaldır', async (dialog) => {
        const impact = dialog.getByTestId('placement-suspend-impact');
        await expect(impact).toContainText('Ücretli kart yayından iner');
        await expect(impact).toContainText('Yayın süresi durur');
        await expect(impact).toContainText('Hizmet verene e-posta gitmez');
      });
      await expect.poll(async () => (await placementRow(seeded.placement.id)).status).toBe('SUSPENDED');
      const hold = await prisma().showcasePlacementSuspension.findFirstOrThrow({
        where: { placementId: seeded.placement.id, endedAt: null },
      });
      expect(hold).toMatchObject({ reason: 'ADMIN_ACTION', note: 'Şikâyet incelemesi için durduruldu', actorUserId: account.id });

      // ---- resuming stays one press, and says the end date it will produce
      await expect(page.getByTestId('placement-resume-end')).toContainText('yeni bitiş tarihi');
      const resume = page.getByRole('button', { name: 'Yerleşimi sürdür' });
      await waitForHydration(resume);
      await resume.click();
      await expect.poll(async () => (await placementRow(seeded.placement.id)).status).toBe('ACTIVE');
    } finally {
      await retireShowcasePlacements([seeded.placement.id]);
      await actor.close();
    }
  });

  test('categories: a live create, a structural + price edit, a close and a reopen, a question switched off', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const { actor } = await openAs(browser);
    const page = actor.page;
    const slug = `e2e-paketb-${uniqueSuffix()}`;
    const run = await seedLiveRun(`E2E Paket B Kategori Kartı ${uniqueSuffix()}`, 'E2E PaketB Kategori');

    try {
      // ---- created live: asks, names the status, says the catalogue -------
      await actor.gotoAdmin('/categories/new');
      await page.locator('input[name="name"]').fill(`E2E Paket B ${slug}`);
      await page.locator('input[name="slug"]').fill(slug);
      await page.getByTestId('category-new-status').selectOption('ACTIVE');
      await confirmThrough(page.getByTestId('category-create-submit'), 'Evet, oluştur ve yayına al', async (dialog) => {
        await expect(dialog.getByTestId('category-create-summary')).toContainText('Yayında');
        await expect(dialog).toContainText('müşteri kataloğunda yayınlanır');
      });
      await expect(page).toHaveURL(new RegExp(`/categories/${slug}$`));
      expect((await prisma().serviceCategory.findUniqueOrThrow({ where: { slug } })).status).toBe('ACTIVE');

      // ---- the parent and the price in one save: one dialog, both lines ---
      // (SEO-004 PR B: the slug is no longer a field of this form — an address
      // changes only in the SEO slug window, which has its own spec.)
      const group = await createCategory(null, { kind: 'GROUP', namePrefix: 'E2E PaketB Grup' });
      await page.reload();
      const form = page.locator('form', { has: page.getByTestId('category-save') });
      await expect(form.locator('input[name="slug"]')).toHaveCount(0);
      await form.locator('select[name="parentId"]').selectOption(group.id);
      await form.locator('input[name="offerCreditCost"]').fill('5');
      await confirmThrough(form.getByTestId('category-save'), 'Evet, kaydet', async (dialog) => {
        await expect(dialog.getByTestId('category-structure-change')).toContainText(group.name);
        await expect(dialog.getByTestId('category-structure-change')).toContainText('Kategori ağacı değişir');
        await expect(dialog.getByTestId('category-offer-credit-change')).toContainText('1 kredi → 5 kredi');
      });
      await expect
        .poll(async () => {
          const saved = await prisma().serviceCategory.findUnique({ where: { slug } });
          return [saved?.parentId, saved?.offerCreditCost];
        })
        .toEqual([group.id, 5]);

      // ---- a category with a live run: closing counts and suspends it -----
      await actor.gotoAdmin(`/categories/${run.category.slug}`);
      const panel = page.getByTestId('category-status-panel');
      await panel.locator('select[name="status"]').selectOption('INACTIVE');
      await confirmThrough(panel.getByTestId('category-status-submit'), 'Evet, kapalı yap', async (dialog) => {
        await expect(dialog.getByTestId('category-status-deactivate-placements')).toContainText(
          'yayında 1 yerleşim var',
        );
        await expect(dialog).toContainText('yeni talep açılamaz');
      });
      await expect.poll(async () => (await placementRow(run.placement.id)).suspendReason).toBe('CATEGORY_CLOSED');

      // ---- and reopening says the held run comes back ----------------------
      await panel.locator('select[name="status"]').selectOption('ACTIVE');
      await confirmThrough(panel.getByTestId('category-status-submit'), 'Evet, yayına al', async (dialog) => {
        await expect(dialog.getByTestId('category-status-activate')).toContainText('duran 1 yerleşim var');
      });
      await expect.poll(async () => (await placementRow(run.placement.id)).status).toBe('ACTIVE');

      // ---- a question switched off: asked, and the row stays ---------------
      const question = await prisma().serviceRequestQuestion.create({
        data: { categoryId: run.category.id, key: `paketb_${uniqueSuffix()}`, label: 'Paket B sorusu', type: 'TEXT' },
        select: { id: true },
      });
      await actor.gotoAdmin(`/categories/${run.category.slug}?tab=sorular`);
      const row = page.locator('details.question-row').filter({ hasText: 'Paket B sorusu' });
      await row.locator('summary').click();
      await confirmThrough(row.getByTestId(`question-deactivate-${question.id}`), 'Evet, pasifleştir', async (dialog) => {
        await expect(dialog.getByTestId('question-disable-impact')).toContainText('Soru silinmez, pasif olur.');
      });
      await expect
        .poll(async () => (await prisma().serviceRequestQuestion.findUnique({ where: { id: question.id } }))?.isActive)
        .toBe(false);
      await assertNoErrorScreen(page);
    } finally {
      await retireShowcasePlacements([run.placement.id]);
      await actor.close();
    }
  });

  test('a reported review: "Uygun bulundu" asks, closes the report and keeps the review live', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E PaketB Yorum' });
    const provider = await createProvider({ categoryId: category.id, location, credits: 0 });
    const customer = await createCustomer('E2E Paket B Müşteri');
    const review = await seedReview({
      providerId: provider.id,
      categoryId: category.id,
      customerId: customer.id,
      location,
      rating: 2,
      comment: 'Paket B: geç geldiler.',
    });
    const report = await prisma().providerReviewReport.create({
      data: { reviewId: review.reviewId, reporterProviderId: provider.id, reason: 'NOT_ABOUT_THIS_JOB', note: 'Bizim işimiz değil.' },
      select: { id: true },
    });
    const { actor } = await openAs(browser);
    const page = actor.page;

    try {
      await actor.gotoAdmin(`/provider-reviews/${review.reviewId}`);
      await confirmThrough(page.getByTestId('review-dismiss'), 'Evet, uygun bulundu', async (dialog) => {
        const impact = dialog.getByTestId('review-dismiss-impact');
        await expect(impact).toContainText('Açık bildirim kapanır');
        await expect(impact).toContainText('Değerlendirme yayında kalır');
        await expect(impact).toContainText('Geri açılamaz');
      });
      await expect
        .poll(async () => (await prisma().providerReviewReport.findUniqueOrThrow({ where: { id: report.id } })).resolution)
        .toBe('DISMISSED');
      const after = await prisma().providerReview.findUniqueOrThrow({ where: { id: review.reviewId } });
      expect(after.removedAt).toBeNull();
      await assertNoErrorScreen(page);
    } finally {
      await actor.close();
    }
  });
});
