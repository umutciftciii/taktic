import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCategory, createProvider, uniqueLocation } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';
import {
  seedApprovedShowcaseCard,
  seedLiveShowcasePlacement,
  withNoActiveShowcasePlacements,
} from '../src/showcase-fixtures';

/**
 * The vitrin block on the home page: when it exists, and how its head sits.
 *
 * Two facts, each asserted directly against the rendered page.
 *
 * 1. **No live card, no block.** With nothing on the air the home page carries
 *    no eyebrow, no heading, no sentence, no empty grid and no divider for the
 *    vitrin — the block is not in the document at all. With one live card the
 *    block is there in full. The decision is the server's: the section is
 *    either in the HTML the page arrives with or it is not, and nothing is
 *    painted and then hidden.
 *
 * 2. **The heading starts where the eyebrow starts.** At 320, 768 and 1440
 *    pixels the "Öne çıkan hizmetler" heading's left edge is the "Vitrin"
 *    eyebrow's left edge — the same column, the same left alignment every
 *    other section on the page has — and it is not centred. Photographed at
 *    each width under `test-results/showcase-home/`.
 */

const WIDTHS = [320, 768, 1440] as const;
const SCREENSHOT_DIR = resolve(__dirname, '..', 'test-results', 'showcase-home');

async function leftEdge(page: Page, testId: string): Promise<number> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) {
    throw new Error(`${testId} has no box`);
  }
  return box.x;
}

test.describe('vitrin: ana sayfa rafı', () => {
  test('aktif yerleşim yokken alan hiç basılmaz; bir tane olunca tam basılır', async ({
    browser,
  }) => {
    const visitor = await Actor.open(browser, 'web', primaryRuntime);

    try {
      // ── Nothing on the air ─────────────────────────────────────────────
      await withNoActiveShowcasePlacements(async () => {
        await visitor.gotoWeb('/');
        await assertNoErrorScreen(visitor.page);

        // Not hidden: absent. The section, its head, its grid and its empty
        // state are all missing from the document.
        await expect(visitor.page.getByTestId('showcase-section')).toHaveCount(0);
        await expect(visitor.page.getByTestId('showcase-shelf')).toHaveCount(0);
        await expect(visitor.page.getByTestId('showcase-heading')).toHaveCount(0);
        await expect(visitor.page.getByTestId('showcase-eyebrow')).toHaveCount(0);
        await expect(visitor.page.locator('#vitrin')).toHaveCount(0);
        await expect(visitor.page.getByText('Öne çıkan hizmetler')).toHaveCount(0);
        await expect(visitor.page.getByText('Şu anda vitrinde yayında olan bir hizmet yok')).toHaveCount(0);
        // And the rest of the page is still the page.
        await expect(visitor.page.locator('#kategoriler')).toBeVisible();
        await expect(visitor.page.locator('#nasil-calisir')).toBeVisible();

        // The server decided: the HTML that arrived carries no vitrin block.
        const html = await visitor.page.content();
        expect(html).not.toContain('data-testid="showcase-section"');
        expect(html).not.toContain('Öne çıkan hizmetler');
      });

      // ── One live card ──────────────────────────────────────────────────
      const location = uniqueLocation();
      const category = await createCategory(3, { namePrefix: 'E2E Vitrin Raf' });
      const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
      const { card, version } = await seedApprovedShowcaseCard({
        providerId: owner.id,
        categoryId: category.id,
        city: location.city,
        district: location.district,
        title: 'E2E Raf Klima Bakımı',
      });
      await seedLiveShowcasePlacement({
        providerId: owner.id,
        cardId: card.id,
        versionId: version.id,
        categoryId: category.id,
        city: location.city,
        district: location.district,
      });

      await visitor.gotoWeb('/');
      await assertNoErrorScreen(visitor.page);
      await expect(visitor.page.getByTestId('showcase-section')).toHaveCount(1);
      await expect(visitor.page.getByTestId('showcase-eyebrow')).toHaveText('Vitrin');
      await expect(visitor.page.getByTestId('showcase-heading')).toHaveText('Öne çıkan hizmetler');
      await expect(
        visitor.page.getByTestId('showcase-shelf').getByText('E2E Raf Klima Bakımı'),
      ).toBeVisible();
    } finally {
      await visitor.close();
    }
  });

  test('başlık, üstündeki VİTRİN etiketiyle aynı sol hizada başlar — 320, 768 ve 1440px', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin Hiza' });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const { card, version } = await seedApprovedShowcaseCard({
      providerId: owner.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: 'E2E Hiza Klima Bakımı',
    });
    await seedLiveShowcasePlacement({
      providerId: owner.id,
      cardId: card.id,
      versionId: version.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
    });

    mkdirSync(SCREENSHOT_DIR, { recursive: true });

    for (const width of WIDTHS) {
      const visitor = await Actor.open(browser, 'web', primaryRuntime, {
        viewport: { width, height: 900 },
      });

      try {
        await visitor.gotoWeb('/');
        await assertNoErrorScreen(visitor.page);

        const section = visitor.page.getByTestId('showcase-section');
        await expect(section).toBeVisible();
        await section.scrollIntoViewIfNeeded();

        const eyebrowLeft = await leftEdge(visitor.page, 'showcase-eyebrow');
        const headingLeft = await leftEdge(visitor.page, 'showcase-heading');
        const shelfLeft = await leftEdge(visitor.page, 'showcase-shelf');

        // Same column, same left edge — to the pixel.
        expect(
          Math.abs(headingLeft - eyebrowLeft),
          `@${width}: heading left ${headingLeft} vs eyebrow left ${eyebrowLeft}`,
        ).toBeLessThanOrEqual(1);
        // And that column is the section's content column, which the grid
        // below also starts from — so the heading is not centred either.
        expect(
          Math.abs(headingLeft - shelfLeft),
          `@${width}: heading left ${headingLeft} vs grid left ${shelfLeft}`,
        ).toBeLessThanOrEqual(1);

        const textAlign = await visitor.page
          .getByTestId('showcase-heading')
          .evaluate((element) => getComputedStyle(element).textAlign);
        expect(textAlign).not.toBe('center');

        // The head as a whole: on a wide screen the description sits beside
        // the heading; on a phone it drops under it, still left-aligned.
        const heading = await visitor.page.getByTestId('showcase-heading').boundingBox();
        const description = await section.locator('.lp-section-sub').boundingBox();
        if (!heading || !description) {
          throw new Error('head boxes missing');
        }
        if (width >= 1440) {
          expect(description.x).toBeGreaterThan(heading.x + heading.width);
        } else if (width <= 320) {
          expect(description.y).toBeGreaterThanOrEqual(heading.y + heading.height);
          expect(Math.abs(description.x - heading.x)).toBeLessThanOrEqual(1);
        }

        // The block alone, at its own height: the evidence for the head and
        // the grid, without the rest of a long page around it.
        await section.screenshot({ path: resolve(SCREENSHOT_DIR, `home-shelf-${width}.png`) });
      } finally {
        await visitor.close();
      }
    }
  });
});
