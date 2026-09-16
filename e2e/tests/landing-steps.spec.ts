import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * The "3 adımda teklif al" cards on the home page.
 *
 * Each card is a number, an icon, a title and a sentence. They used to be laid
 * out as four rows, which read as four unrelated things — and across three
 * cards the icons lined up into a strip of their own, belonging to no step.
 * The number, the icon and the title are now one heading block per card, and
 * what a browser can prove about that block is proved here at the five
 * widths the brief names:
 *
 * - the icon sits *beside* its title, sharing its vertical span, rather than
 *   above it in a row of its own;
 * - every card's title starts the same distance in from its card's edge, and
 *   every icon box is the same size, whether the cards are three abreast,
 *   two and one at 768px, or stacked on a phone;
 * - nothing overflows the viewport and there is no yawning gap between the
 *   heading block and its sentence;
 * - the cards still fall into the columns they always did, and still say
 *   what they always said.
 *
 * The markup's grouping itself is asserted without a browser in
 * `apps/web/test/landing-steps.spec.ts`.
 */

const WIDTHS = [320, 375, 768, 1024, 1440] as const;

const SCREENSHOT_DIR = resolve(artifactsDir, 'screens');

/** The three steps, in order, exactly as they have always read. */
const TITLES = ['İhtiyacını anlat', 'Teklifleri karşılaştır', 'Uygun olanı seç'];

/** How many cards share the first row at a given width — the behaviour before this change. */
function cardsAbreast(width: number): number {
  if (width >= 1024) return 3;
  if (width >= 768) return 2;
  return 1;
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

type CardGeometry = {
  card: Box;
  head: Box;
  icon: Box;
  num: Box;
  title: Box;
  desc: Box;
};

async function overflowOf(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** The boxes of every part of every card, rounded to whole pixels. */
async function measure(page: Page): Promise<CardGeometry[]> {
  return page.locator('.lp-step-card').evaluateAll((cards) => {
    const box = (element: Element | null): Box => {
      if (!element) throw new Error('a step card is missing one of its parts');
      const rect = element.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    return cards.map((card) => ({
      card: box(card),
      head: box(card.querySelector('.lp-step-head')),
      icon: box(card.querySelector('.lp-step-icon')),
      num: box(card.querySelector('.lp-step-num')),
      title: box(card.querySelector('.lp-step-title')),
      desc: box(card.querySelector('.lp-step-desc')),
    }));
  });
}

test.describe('the home page request steps', () => {
  test('group number, icon and title per card and line up at every width', async ({ browser }) => {
    const visitor = await Actor.open(browser, 'steps', primaryRuntime, {
      viewport: { width: 1440, height: 900 },
    });
    const page = visitor.page;

    try {
      await visitor.gotoWeb('/');
      await assertNoErrorScreen(page);

      const cards = page.locator('.lp-step-card');
      await expect(cards).toHaveCount(3);
      await expect(cards.locator('.lp-step-num')).toHaveText(['01', '02', '03']);
      await expect(cards.locator('h3.lp-step-title')).toHaveText(TITLES);
      // The icons are decoration: three of them, none announced.
      await expect(cards.locator('.lp-step-icon svg[aria-hidden="true"]')).toHaveCount(3);
      // And the section is still reachable as the heading it always was.
      await expect(page.getByRole('heading', { level: 2, name: '3 adımda teklif al' })).toBeVisible();

      for (const width of WIDTHS) {
        const label = `steps @${width}`;
        await page.setViewportSize({ width, height: 900 });
        await page.locator('#nasil-calisir').scrollIntoViewIfNeeded();

        expect(await overflowOf(page), `${label}: the page is wider than the viewport`).toBeLessThanOrEqual(0);

        const geometry = await measure(page);
        expect(geometry).toHaveLength(3);

        for (const [index, g] of geometry.entries()) {
          const card = `${label}, card ${index + 1}`;

          // Inside the viewport on both sides.
          expect(g.card.left, `${card} starts off the left edge`).toBeGreaterThanOrEqual(0);
          expect(g.card.right, `${card} runs past the right edge`).toBeLessThanOrEqual(width);

          // The icon box is the head's first column: flush with the head's
          // left edge, starting at its top, and no taller than it.
          expect(g.icon.left, `${card}: the icon is not at the head's left edge`).toBe(g.head.left);
          expect(Math.abs(g.icon.top - g.head.top), `${card}: the icon does not start with the head`).toBeLessThanOrEqual(1);
          expect(g.icon.bottom, `${card}: the icon hangs below the head`).toBeLessThanOrEqual(g.head.bottom + 1);

          // The icon shares its vertical span with the title — it is beside
          // it, not in a row above it. The old layout put the whole icon
          // above the title's top edge.
          expect(g.icon.bottom, `${card}: the icon sits above the title instead of beside it`).toBeGreaterThan(g.title.top);
          expect(g.icon.top, `${card}: the icon sits below the title`).toBeLessThan(g.title.bottom);
          expect(g.title.left, `${card}: the title is not to the right of the icon`).toBeGreaterThanOrEqual(g.icon.right);

          // The number and the title share a column.
          expect(g.num.left, `${card}: the number and the title start at different x`).toBe(g.title.left);
          expect(g.num.bottom, `${card}: the number is not above the title`).toBeLessThanOrEqual(g.title.top + 1);

          // The sentence follows the head closely: a wide gap is what a
          // stray flex row or a stretched heading looks like.
          expect(g.desc.top - g.head.bottom, `${card}: too much space between the head and the sentence`).toBeLessThanOrEqual(24);
          expect(g.desc.top, `${card}: the sentence overlaps the head`).toBeGreaterThanOrEqual(g.head.bottom);
        }

        // Every card the same: icon box size, and the title's inset from
        // its card's edge — the first card used to drop its left padding.
        const iconSizes = new Set(geometry.map((g) => `${g.icon.width}x${g.icon.height}`));
        expect([...iconSizes], `${label}: the icon boxes differ in size`).toHaveLength(1);
        const insets = new Set(geometry.map((g) => g.title.left - g.card.left));
        expect([...insets], `${label}: the titles start at different insets`).toHaveLength(1);
        const iconInsets = new Set(geometry.map((g) => g.icon.left - g.card.left));
        expect([...iconInsets], `${label}: the icons start at different insets`).toHaveLength(1);

        // The columns are the ones this layout always had. Cards on one row
        // share a top edge; a card on the next row starts below the whole
        // row before it.
        const abreast = cardsAbreast(width);
        const [first, second, third] = geometry as [CardGeometry, CardGeometry, CardGeometry];
        if (abreast === 3) {
          expect(second.card.top, `${label}: three cards should share a row`).toBe(first.card.top);
          expect(third.card.top, `${label}: three cards should share a row`).toBe(first.card.top);
          expect(second.card.left).toBeGreaterThan(first.card.left);
          expect(third.card.left).toBeGreaterThan(second.card.left);
        } else if (abreast === 2) {
          expect(second.card.top, `${label}: the first two cards should share a row`).toBe(first.card.top);
          expect(third.card.top, `${label}: the third card should wrap below`).toBeGreaterThanOrEqual(first.card.bottom);
          expect(third.card.left, `${label}: the wrapped card should start where the first does`).toBe(first.card.left);
        } else {
          expect(second.card.top, `${label}: the cards should stack`).toBeGreaterThanOrEqual(first.card.bottom);
          expect(third.card.top, `${label}: the cards should stack`).toBeGreaterThanOrEqual(second.card.bottom);
          expect(second.card.left).toBe(first.card.left);
          expect(third.card.left).toBe(first.card.left);
        }

        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await page.locator('#nasil-calisir').screenshot({
          path: resolve(SCREENSHOT_DIR, `landing-steps-${width}.png`),
        });
      }
    } finally {
      await visitor.close();
    }
  });
});
