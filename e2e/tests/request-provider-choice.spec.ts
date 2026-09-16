import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createCategory,
  createCustomer,
  createProvider,
  createSelectQuestion,
  prisma,
  requestFormValues,
  uniqueLocation,
  uniqueSuffix,
} from '../src/fixtures';
import { completeContactStep } from '../src/journeys';
import { isProviderReviewsEnabled, seedReview, setProviderReviewsEnabled } from '../src/review-fixtures';
import {
  retireShowcasePlacements,
  seedApprovedShowcaseCard,
  seedLiveShowcasePlacement,
} from '../src/showcase-fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

const SCREENSHOT_DIR = resolve(artifactsDir, 'screens');

/**
 * The businesses offered inside the marketplace form, as a choice.
 *
 * What these journeys prove:
 *
 * 1. **Choosing is not sending.** Ticking a card changes the primary button
 *    and nothing else: no request exists until somebody presses "Talebi
 *    Gönder" on the general path or completes the card's own form. The
 *    request count is read from the database before and after the click.
 * 2. **Everything typed travels.** The description, a category answer, the
 *    location, the address note, the date range, the budget and the urgency
 *    are all on the card's form when the customer arrives — through the draft
 *    the browser holds as an opaque cookie, never through the URL, which
 *    carries the card id and the page's own `step` switch and nothing else.
 * 3. **A guest is told about the telephone step before leaving**, and the
 *    contact fields are *not* carried: the card's form asks for them.
 * 4. **A card that went off the air is refused safely**: an error beside the
 *    cards, the choice falls back to the general request, every field keeps
 *    its value, and nothing was written.
 * 5. **The keyboard works**: Tab reaches the group, the arrow keys move the
 *    choice, and the selected card is the one the form holds.
 * 6. **No rating below the threshold or with the switch off**, and a rating
 *    when both hold — decided by the API, only rendered here.
 * 7. **No horizontal overflow** on the form with the cards at 320, 768, 1024
 *    and 1440 pixels.
 */

const WIDTHS = [320, 768, 1024, 1440] as const;

/** Every run this file put on the air, retired after each test so the home shelf stays other specs'. */
const placementsOnAir: string[] = [];

test.afterEach(async () => {
  await retireShowcasePlacements(placementsOnAir.splice(0));
});

async function overflowOf(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function seedCardFor(options: {
  providerId: string;
  categoryId: string;
  city: string;
  district: string;
  title: string;
}) {
  const { card, version } = await seedApprovedShowcaseCard(options);
  const { placement } = await seedLiveShowcasePlacement({
    providerId: options.providerId,
    cardId: card.id,
    versionId: version.id,
    categoryId: options.categoryId,
    city: options.city,
    district: options.district,
  });
  placementsOnAir.push(placement.id);
  return { card, placement };
}

/** Walks a guest to the place step with a description and one answer filled. */
async function reachPlaceStep(
  visitor: Actor,
  category: { slug: string; name: string },
  values: ReturnType<typeof requestFormValues>,
  answerOptionKey: string,
) {
  await visitor.gotoWeb(`/categories/${category.slug}`);
  await assertNoErrorScreen(visitor.page);
  await completeContactStep(visitor, values);
  await visitor.page.locator('select[name="answer_unit"]').selectOption(answerOptionKey);
  await visitor.page.locator('textarea[name="description"]').fill(values.description);
  await visitor.page.getByRole('button', { name: 'Devam et' }).click();
  await expect(visitor.page.locator('#request-step-place')).toBeVisible();
  await visitor.page.getByTestId('request-city').selectOption(values.city);
  await visitor.page.getByTestId('request-district').selectOption(values.district);
}

test.describe('request form — provider choice and hand-off', () => {
  test('choosing a card only changes the form; the hand-off carries every field to the card\'s form', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Seçim' });
    await createSelectQuestion({
      categoryId: category.id,
      key: 'unit',
      label: 'Klima tipi',
      options: [
        { key: 'split', label: 'Split' },
        { key: 'multi', label: 'Multi' },
      ],
    });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const { card } = await seedCardFor({
      providerId: owner.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: `E2E Seçim Kartı ${uniqueSuffix()}`,
    });

    const visitor = await Actor.open(browser, 'web', primaryRuntime);
    const values = requestFormValues(location, 'E2E Seçim Müşterisi', {
      description: 'Salon kliması soğutmuyor, iki iç ünite var; hafta içi uygunum.',
    });

    try {
      await reachPlaceStep(visitor, category, values, 'multi');
      const page = visitor.page;

      await page.locator('textarea[name="addressNote"]').fill('Zemin kat, kapıcıya haber verin.');
      await page.getByTestId('request-urgency').selectOption('THIS_WEEK');
      const start = await page.getByTestId('request-preferred-date').inputValue();
      const end = await page.getByTestId('request-preferred-date-end').inputValue();
      expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(end >= start).toBe(true);
      await page.getByTestId('request-budget-min').fill('2500');
      await page.getByTestId('request-budget-max').fill('4000');
      await page.getByTestId('request-budget-max').blur();

      // ---- the choice ------------------------------------------------------
      const group = page.getByTestId('provider-choice-group');
      await expect(group).toBeVisible();
      await expect(page.getByTestId('provider-choice-general')).toHaveAttribute('data-selected', 'true');
      await expect(page.getByRole('button', { name: 'Talebi Gönder' })).toBeVisible();

      const choice = group.locator(`[data-testid="provider-choice-card"][data-card-id="${card.id}"]`);
      // Five facts and no more.
      await expect(choice.getByText(owner.businessName)).toBeVisible();
      await expect(choice.getByText(category.name)).toBeVisible();
      await expect(choice.getByText(`${location.district}, ${location.city}`)).toBeVisible();
      await expect(choice.getByText('Acil 3 sa · Normal 24 sa içinde dönüş')).toBeVisible();
      await expect(choice.getByText('Standart kapsamda', { exact: false })).toHaveCount(0);
      await expect(choice.getByText('₺')).toHaveCount(0);

      const before = await prisma().serviceRequest.count();
      await choice.click();
      await expect(choice).toHaveAttribute('data-selected', 'true');
      await expect(page.getByTestId('provider-choice-general')).toHaveAttribute('data-selected', 'false');

      const note = page.getByTestId('provider-choice-selected-note');
      await expect(note).toContainText(`Talebiniz yalnız ${owner.businessName} işletmesine iletilir`);
      await expect(note).toContainText('Seçili işletmeye talep göndermek için telefonunuzu doğrulamanız gerekir.');
      await expect(page.getByRole('button', { name: 'Talebi Gönder' })).toHaveCount(0);
      const cta = page.getByTestId('request-handoff-cta');
      await expect(cta).toHaveText(/Seçili işletmeye devam et/);
      expect(await prisma().serviceRequest.count()).toBe(before);

      // Un-choosing is one click, and the general submit is back.
      await page.getByTestId('provider-choice-general').click();
      await expect(page.getByRole('button', { name: 'Talebi Gönder' })).toBeVisible();
      await choice.click();

      // ---- the hand-off ----------------------------------------------------
      await cta.click();
      await expect(page).toHaveURL(new RegExp(`/vitrin/${card.id}\\?step=form$`));
      await assertNoErrorScreen(page);
      // Nothing personal and no form content in the address bar.
      const url = new URL(page.url());
      expect([...url.searchParams.keys()]).toEqual(['step']);
      expect(await prisma().serviceRequest.count()).toBe(before);
      expect(await prisma().showcaseLead.count({ where: { cardId: card.id } })).toBe(0);

      const lead = page.getByTestId('showcase-lead-form');
      await expect(lead).toBeVisible();
      await expect(lead.locator('textarea[name="description"]')).toHaveValue(values.description);
      await expect(lead.locator('select[name="answer_unit"]')).toHaveValue('multi');
      await expect(lead.locator('select[name="city"]')).toHaveValue(location.city);
      await expect(lead.locator('select[name="district"]')).toHaveValue(location.district);
      await expect(lead.getByTestId('showcase-lead-address-note')).toHaveValue('Zemin kat, kapıcıya haber verin.');
      await expect(lead.getByTestId('showcase-lead-urgency')).toHaveValue('THIS_WEEK');
      await expect(lead.getByTestId('request-preferred-date')).toHaveValue(start);
      await expect(lead.getByTestId('request-preferred-date-end')).toHaveValue(end);
      await expect(lead.getByTestId('request-budget-min')).toHaveValue('2.500,00');
      await expect(lead.getByTestId('request-budget-max')).toHaveValue('4.000,00');
      // The contact is asked again here, empty: it never travelled.
      await expect(lead.locator('input[name="customerPhone"]')).toHaveValue('');
      await expect(lead.locator('input[name="customerEmail"]')).toHaveValue('');
    } finally {
      await visitor.close();
    }
  });

  test('a card that went off the air is refused without losing the form; the general request still goes', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Seçim Kapalı' });
    await createSelectQuestion({
      categoryId: category.id,
      key: 'unit',
      label: 'Klima tipi',
      options: [{ key: 'split', label: 'Split' }],
    });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const { card, placement } = await seedCardFor({
      providerId: owner.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: `E2E Kapanan Kart ${uniqueSuffix()}`,
    });

    const visitor = await Actor.open(browser, 'web', primaryRuntime);
    const values = requestFormValues(location, 'E2E Seçim Kapalı Müşterisi');

    try {
      await reachPlaceStep(visitor, category, values, 'split');
      const page = visitor.page;
      const choice = page.locator(`[data-testid="provider-choice-card"][data-card-id="${card.id}"]`);
      await choice.click();
      await page.locator('textarea[name="addressNote"]').fill('Arka bina.');

      // The run ends between the card being shown and the button being pressed.
      // Both ends in the past: the row's CHECK keeps start before end.
      await prisma().showcasePlacement.update({
        where: { id: placement.id },
        data: { startAt: new Date(Date.now() - 120_000), endAt: new Date(Date.now() - 60_000) },
      });

      const before = await prisma().serviceRequest.count();
      await page.getByTestId('request-handoff-cta').click();
      const error = page.getByTestId('provider-choice-error');
      await expect(error).toHaveText(
        'Bu işletme artık bu bölge için seçilemiyor. Genel talep olarak devam edebilirsiniz.',
      );
      await expect(page).toHaveURL(new RegExp(`/categories/${category.slug}`));
      await assertNoErrorScreen(page);
      expect(await prisma().serviceRequest.count()).toBe(before);
      expect(await prisma().requestDraft.count({ where: { cardId: card.id } })).toBe(0);

      // The choice fell back to the general request; nothing typed was lost.
      await expect(page.getByTestId('provider-choice-general')).toHaveAttribute('data-selected', 'true');
      await expect(page.locator('textarea[name="addressNote"]')).toHaveValue('Arka bina.');
      await expect(page.locator('select[name="district"]')).toHaveValue(location.district);

      await page.getByRole('button', { name: 'Talebi Gönder' }).click();
      await expect(page).toHaveURL(/\/requests\/success\?id=[^&]+$/);
      await assertNoErrorScreen(page);
      const stored = await prisma().serviceRequest.findFirstOrThrow({
        where: { customerEmail: values.customerEmail },
        select: { directShowcaseProviderId: true, showcaseLeadId: true, addressNote: true },
      });
      expect(stored.directShowcaseProviderId).toBeNull();
      expect(stored.showcaseLeadId).toBeNull();
      expect(stored.addressNote).toBe('Arka bina.');
    } finally {
      await visitor.close();
    }
  });

  test('the group works from the keyboard, hides the rating when it is not public, and never overflows', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Seçim Klavye' });
    await createSelectQuestion({
      categoryId: category.id,
      key: 'unit',
      label: 'Klima tipi',
      options: [{ key: 'split', label: 'Split' }],
    });
    const rated = await createProvider({ categoryId: category.id, location, credits: 0 });
    const unrated = await createProvider({ categoryId: category.id, location, credits: 0 });
    const ratedCard = await seedCardFor({
      providerId: rated.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: `E2E Puanlı ${uniqueSuffix()}`,
    });
    const unratedCard = await seedCardFor({
      providerId: unrated.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: `E2E Puansız ${uniqueSuffix()}`,
    });
    // Three live reviews put the rated business over the public threshold.
    for (const rating of [5, 4, 5]) {
      const reviewer = await createCustomer('E2E Seçim Değerlendiren');
      await seedReview({
        providerId: rated.id,
        categoryId: category.id,
        customerId: reviewer.id,
        location,
        rating,
      });
    }

    const reviewsWereEnabled = await isProviderReviewsEnabled();
    const visitor = await Actor.open(browser, 'web', primaryRuntime);
    const values = requestFormValues(location, 'E2E Seçim Klavye Müşterisi');

    try {
      // ---- switch off: no rating anywhere ---------------------------------
      await setProviderReviewsEnabled(false);
      await reachPlaceStep(visitor, category, values, 'split');
      const page = visitor.page;
      await expect(page.getByTestId('provider-choice-group')).toBeVisible();
      await expect(page.getByTestId('provider-choice-review-summary')).toHaveCount(0);
      await expect(page.getByText('Henüz yeterli değerlendirme yok')).toHaveCount(0);

      // ---- switch on: the rated one shows a rating, the other shows nothing --
      await setProviderReviewsEnabled(true);
      await page.getByTestId('request-district').selectOption(location.district);
      await page.getByTestId('request-city').selectOption(location.city);
      await page.getByTestId('request-district').selectOption(location.district);
      const ratedChoice = page.locator(
        `[data-testid="provider-choice-card"][data-card-id="${ratedCard.card.id}"]`,
      );
      const unratedChoice = page.locator(
        `[data-testid="provider-choice-card"][data-card-id="${unratedCard.card.id}"]`,
      );
      await expect(ratedChoice.getByTestId('provider-choice-review-summary')).toContainText('4,7');
      await expect(unratedChoice.getByTestId('provider-choice-review-summary')).toHaveCount(0);
      await expect(unratedChoice.getByText('Henüz yeterli değerlendirme yok')).toHaveCount(0);

      // ---- keyboard: focus the group, arrow through it -----------------------
      const general = page.getByTestId('provider-choice-general').locator('input');
      await general.focus();
      await expect(general).toBeFocused();
      await page.keyboard.press('ArrowUp');
      // The option before "general" in DOM order is the last card.
      const lastCard = page.locator('[data-testid="provider-choice-card"]').last();
      await expect(lastCard.locator('input')).toBeFocused();
      await expect(lastCard).toHaveAttribute('data-selected', 'true');
      await expect(page.getByTestId('request-handoff-cta')).toBeVisible();
      await page.keyboard.press('ArrowDown');
      await expect(general).toBeFocused();
      await expect(page.getByTestId('provider-choice-general')).toHaveAttribute('data-selected', 'true');
      await expect(page.getByRole('button', { name: 'Talebi Gönder' })).toBeVisible();

      // ---- widths -----------------------------------------------------------
      await ratedChoice.click();
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 1000 });
        await page.getByTestId('provider-choice-group').scrollIntoViewIfNeeded();
        expect(await overflowOf(page), `provider choice @ ${width}px`).toBeLessThanOrEqual(0);
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: resolve(SCREENSHOT_DIR, `request-provider-choice-${width}.png`),
          fullPage: false,
        });
      }
    } finally {
      await setProviderReviewsEnabled(reviewsWereEnabled);
      await visitor.close();
    }
  });
});
