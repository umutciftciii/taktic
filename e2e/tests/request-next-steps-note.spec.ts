import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createCategory,
  createProvider,
  isAutoPublishEnabled,
  setAutoPublish,
  uniqueLocation,
  uniqueSuffix,
} from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';
import {
  retireShowcasePlacements,
  seedApprovedShowcaseCard,
  seedLiveShowcasePlacement,
} from '../src/showcase-fixtures';

/**
 * The "Sırada ne var?" note on the marketplace request form follows the
 * instant-publish switch — and so does the sentence under the form's heading
 * when the category has no description of its own.
 *
 * With the switch off an operator reads every request first, and the note says
 * so. With it on, providers see the request at once and the note must not
 * promise a review that will not happen. The switch is one row shared by the
 * whole run and every other spec depends on it being OFF, so it is flipped
 * directly through the fixture here — the admin screen that flips it is
 * `request-auto-publish.spec.ts`'s subject — and `afterEach` puts it back.
 *
 * Each read is a fresh page load: the page asks the API on every request and
 * nothing is cached in the browser, so the sentence follows the switch with no
 * deploy and no wait. What the form does with a broken or missing answer is
 * `apps/web/test/request-next-steps.spec.ts`'s claim.
 */

const TITLE = 'Sırada ne var?';
const REVIEW_SENTENCE =
  'Talebiniz ön incelemeden geçtikten sonra bölgenizdeki onaylı hizmet verenlere iletilir ve 14 gün boyunca teklif alır.';
const INSTANT_SENTENCE =
  'Talebiniz bölgenizdeki onaylı hizmet verenlere iletilir ve 14 gün boyunca teklif alır.';
const REVIEW_INTRO =
  'Soruları yanıtla, talebin ön incelemeden geçtikten sonra bölgendeki onaylı ustalara iletilir.';
const INSTANT_INTRO = 'Soruları yanıtla, talebin bölgendeki uygun hizmet verenlere iletilir.';
const CATEGORY_DESCRIPTION = 'Uçtan uca test kategorisi';

/** The widths the note is measured at: the narrowest phone, a tablet, a desktop. */
const WIDTHS = [320, 768, 1440] as const;

const SCREENSHOT_DIR = resolve(artifactsDir, 'screens');

async function expectNote(page: Page, state: 'on' | 'off', label: string) {
  const note = page.getByTestId('request-next-steps');
  await expect(note, `${label}: the note is on screen`).toBeVisible();
  await expect(note).toHaveAttribute('data-auto-publish', state);
  expect((await note.innerText()).replace(/\s+/g, ' ').trim(), `${label}: the note's wording`).toBe(
    `${TITLE} ${state === 'on' ? INSTANT_SENTENCE : REVIEW_SENTENCE}`,
  );
  await expect(note.locator('strong')).toHaveText(TITLE);
}

/**
 * The sentence under the heading. With no category description it follows
 * the switch; with one, the description is shown in either state and the
 * switch changes nothing.
 */
async function expectIntro(page: Page, expected: string, label: string) {
  const intro = page.getByTestId('request-form-intro');
  await expect(intro, `${label}: the intro is on screen`).toBeVisible();
  expect((await intro.innerText()).replace(/\s+/g, ' ').trim(), `${label}: the intro's wording`).toBe(
    expected,
  );
}

/** The element fits its column and its text fits the element, at this width. */
async function expectFits(page: Page, testId: string, label: string) {
  const note = page.getByTestId(testId);
  const geometry = await note.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
  const viewport = page.viewportSize()?.width ?? 0;
  expect(geometry.left, `${label}: the note starts off screen`).toBeGreaterThanOrEqual(0);
  expect(geometry.right, `${label}: the note runs past the right edge`).toBeLessThanOrEqual(viewport + 1);
  expect(geometry.scrollWidth, `${label}: the note's text is wider than the note`).toBeLessThanOrEqual(
    geometry.clientWidth + 1,
  );
  expect(geometry.scrollHeight, `${label}: the note's text is cut off`).toBeLessThanOrEqual(
    geometry.clientHeight + 1,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    `${label}: the page is wider than the viewport`,
  ).toBeLessThanOrEqual(0);
}

const placementsOnAir: string[] = [];

test.describe('request form next-steps note', () => {
  test.afterEach(async () => {
    await setAutoPublish(false);
    await retireShowcasePlacements(placementsOnAir.splice(0));
  });

  test('says whether an operator reads the request first, following the switch', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    // No description of its own, so the sentence under the heading is the
    // platform's fallback — the one that has to follow the switch.
    const category = await createCategory(2, { namePrefix: 'E2E Sırada', description: null });
    // And one with a description, which is shown whatever the switch says.
    const described = await createCategory(2, { namePrefix: 'E2E Sırada Açıklamalı' });
    const visitor = await Actor.open(browser, 'web', primaryRuntime);
    const page = visitor.page;

    try {
      // ---- switch off: the review sentence ------------------------------
      expect(await isAutoPublishEnabled()).toBe(false);
      await visitor.gotoWeb(`/categories/${category.slug}`);
      await assertNoErrorScreen(page);
      await expectNote(page, 'off', 'switch off');
      await expectIntro(page, REVIEW_INTRO, 'switch off');
      await visitor.gotoWeb(`/categories/${described.slug}`);
      await expectIntro(page, CATEGORY_DESCRIPTION, 'switch off, described category');

      // ---- switch on: a fresh load shows the instant sentence -----------
      await setAutoPublish(true);
      await visitor.gotoWeb(`/categories/${category.slug}`);
      await assertNoErrorScreen(page);
      await expectNote(page, 'on', 'switch on');
      await expectIntro(page, INSTANT_INTRO, 'switch on');
      // Nothing above the form promises a review or an approval any more.
      const head = (await page.locator('.req-head').innerText()).toLowerCase();
      expect(head, 'switch on: the form head speaks of a review').not.toContain('ön incele');
      expect(head, 'switch on: the form head speaks of an approval').not.toContain('onay');
      await visitor.gotoWeb(`/categories/${described.slug}`);
      await expectIntro(page, CATEGORY_DESCRIPTION, 'switch on, described category');

      // ---- and it fits at every width, in both states -------------------
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      for (const state of ['on', 'off'] as const) {
        await setAutoPublish(state === 'on');
        for (const width of WIDTHS) {
          const label = `switch ${state} @${width}`;
          await page.setViewportSize({ width, height: 900 });
          await visitor.gotoWeb(`/categories/${category.slug}`);
          await assertNoErrorScreen(page);
          await expectIntro(page, state === 'on' ? INSTANT_INTRO : REVIEW_INTRO, label);
          await expectFits(page, 'request-form-intro', `${label} (intro)`);
          await page.screenshot({
            path: resolve(SCREENSHOT_DIR, `request-form-intro-${state}-${width}.png`),
            fullPage: false,
          });
          await expectNote(page, state, label);
          await expectFits(page, 'request-next-steps', `${label} (note)`);
          await page.getByTestId('request-next-steps').scrollIntoViewIfNeeded();
          await page.screenshot({
            path: resolve(SCREENSHOT_DIR, `request-next-steps-${state}-${width}.png`),
            fullPage: false,
          });
        }
      }

      // ---- switched back off: the review sentences again ---------------
      await setAutoPublish(false);
      await page.setViewportSize({ width: 1280, height: 900 });
      await visitor.gotoWeb(`/categories/${category.slug}`);
      await expectNote(page, 'off', 'switch off again');
      await expectIntro(page, REVIEW_INTRO, 'switch off again');
    } finally {
      await visitor.close();
    }
  });

  test('the vitrin lead form carries neither sentence in either state', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Sırada Vitrin' });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const { card, version } = await seedApprovedShowcaseCard({
      providerId: owner.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: `E2E Sırada Vitrin ${uniqueSuffix()}`,
    });
    const { placement } = await seedLiveShowcasePlacement({
      providerId: owner.id,
      cardId: card.id,
      versionId: version.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
    });
    placementsOnAir.push(placement.id);
    const visitor = await Actor.open(browser, 'web', primaryRuntime);
    const page = visitor.page;

    try {
      for (const state of [false, true]) {
        await setAutoPublish(state);
        await visitor.gotoWeb(`/vitrin/${card.id}?step=form`);
        await assertNoErrorScreen(page);
        await expect(page.getByTestId('showcase-lead-form')).toBeVisible();
        await expect(page.getByTestId('request-next-steps')).toHaveCount(0);
        await expect(page.getByTestId('request-form-intro')).toHaveCount(0);
        const text = await page.locator('body').innerText();
        expect(text, `vitrin form, switch ${state ? 'on' : 'off'}`).not.toContain(TITLE);
        expect(text).not.toContain(REVIEW_SENTENCE);
        expect(text).not.toContain(INSTANT_SENTENCE);
        expect(text).not.toContain(REVIEW_INTRO);
        expect(text).not.toContain(INSTANT_INTRO);
      }
    } finally {
      await visitor.close();
    }
  });
});
