import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { Actor } from '../src/actors';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * The slogan the home page opens with.
 *
 * It is three sentences with two words picked out in the site's accent red, and
 * that shape is what makes it worth a browser. Three claims are made here that
 * the unit test on the headline data cannot make.
 *
 * **It fits a phone.** The heading is the largest type on the site — 40px at
 * its floor — and the longest of the three sentences is thirty-three
 * characters. A heading that cannot break where it needs to does not look
 * wrong, it makes the whole document wider than the screen and every other
 * thing on the page starts sliding sideways with it.
 *
 * **The accent is the site's, not a new one.** The two words are compared
 * against `--color-accent-700` read from the document itself, so a hand-picked
 * red — however close — fails here rather than passing review.
 *
 * **The rest of the hero is untouched.** The request card beside the heading
 * and the call to action under it are what the slogan is there to lead to.
 */

/** The three sentences, in order, exactly as they must be read. */
const SENTENCES = [
  'İhtiyacını tarif et.',
  'Tak diye doğru ustadan teklif al.',
  'Tick diye işini hallet.',
];

/** The slogan as one run of text — how it is heard rather than how it is laid out. */
const SLOGAN = SENTENCES.join(' ');

/** The wording this replaced. It may not survive anywhere in the hero. */
const RETIRED_SLOGAN = 'Doğru usta sana teklif versin';

/** The phone widths the brief names, narrowest first. */
const PHONE_WIDTHS = [320, 375, 390] as const;
const DESKTOP = { width: 1280, height: 900 } as const;

const SHOTS = resolve(artifactsDir, 'landing-hero');

/** Whitespace as rendered — line breaks included — collapsed to single spaces. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Nothing on the page may make the document wider than the window it is in. */
async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${label}: the page is ${overflow}px wider than the viewport`).toBeLessThanOrEqual(
    0,
  );
}

/** A specific element is inside the viewport on both sides, and has a size. */
async function expectWithinViewport(page: Page, selector: string, label: string) {
  const box = await page.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
  });
  const limit = page.viewportSize()?.width ?? 0;

  expect(box.width, `${label}: "${selector}" has no width`).toBeGreaterThan(0);
  expect(box.left, `${label}: "${selector}" starts ${box.left}px off the left edge`).toBeGreaterThanOrEqual(-1);
  expect(box.right, `${label}: "${selector}" ends ${box.right - limit}px past the right edge`).toBeLessThanOrEqual(
    limit + 1,
  );
}

test.describe('the home page hero slogan', () => {
  test('reads as three sentences with only Tak and Tick in the accent red', async ({ browser }) => {
    const visitor = await Actor.open(browser, 'hero-desktop', primaryRuntime, { viewport: DESKTOP });

    try {
      await visitor.gotoWeb('/');
      const heading = visitor.page.locator('h1.lp-h1');
      await expect(heading).toBeVisible();

      // What the page says, and what a reader is handed: the second is the
      // accessible name the browser itself computes for the heading, so the
      // spans the colour needs cannot have chopped it into fragments.
      expect(collapse(await heading.innerText())).toBe(SLOGAN);
      await expect(visitor.page.getByRole('heading', { level: 1, name: SLOGAN })).toBeVisible();

      // Three sentences, three lines, each starting below the one before it.
      const lines = heading.locator('.lp-h1-line');
      await expect(lines).toHaveCount(3);
      const tops = await lines.evaluateAll((elements) =>
        elements.map((element) => Math.round(element.getBoundingClientRect().top)),
      );
      expect(collapse((await lines.allInnerTexts()).join('\n'))).toBe(SLOGAN);
      const [firstTop = 0, secondTop = 0, thirdTop = 0] = tops;
      expect(secondTop, 'the second sentence starts below the first').toBeGreaterThan(firstTop);
      expect(thirdTop, 'the third sentence starts below the second').toBeGreaterThan(secondTop);

      // Exactly two words are accented, and they are the two brand words.
      const accents = heading.locator('.lp-accent');
      await expect(accents).toHaveCount(2);
      expect(await accents.allInnerTexts()).toEqual(['Tak', 'Tick']);

      // And the colour they are painted in is the site's token, read off the
      // document rather than written down here.
      const colours = await heading.evaluate((element) => {
        const accented = Array.from(element.querySelectorAll<HTMLElement>('.lp-accent'));
        const token = getComputedStyle(document.documentElement)
          .getPropertyValue('--color-accent-700')
          .trim();
        const probe = document.createElement('span');
        probe.style.color = token;
        document.body.append(probe);
        const resolvedToken = getComputedStyle(probe).color;
        probe.remove();
        return {
          resolvedToken,
          accented: accented.map((node) => getComputedStyle(node).color),
          heading: getComputedStyle(element).color,
        };
      });

      expect(colours.resolvedToken, 'the accent token is defined').not.toBe('');
      for (const colour of colours.accented) {
        expect(colour, 'an accented word is painted in --color-accent-700').toBe(
          colours.resolvedToken,
        );
      }
      // The rest of the heading kept the dark heading colour it always had.
      expect(colours.heading).not.toBe(colours.resolvedToken);

      // The hero either side of the slogan is as it was: the request card on
      // the right, and the call to action under the search field.
      await expect(visitor.page.locator('.lp-hero-right')).toBeVisible();
      await expect(
        visitor.page.locator('.lp-hero-search-row').getByRole('button', { name: 'Teklif Al' }),
      ).toBeVisible();
      const card = await visitor.page.locator('.lp-hero-right').boundingBox();
      const left = await visitor.page.locator('.lp-hero-left').boundingBox();
      expect(card, 'the request card has a box').not.toBeNull();
      expect(left, 'the hero text column has a box').not.toBeNull();
      expect(card!.x, 'at 1280px the card is still beside the slogan').toBeGreaterThan(
        left!.x + left!.width - 1,
      );

      await expect(visitor.page.locator('#lp-hero')).not.toContainText(RETIRED_SLOGAN);
      await expectNoHorizontalOverflow(visitor.page, 'home @1280');
      await visitor.page.screenshot({ path: resolve(SHOTS, 'hero-1280.png'), fullPage: false });
    } finally {
      await visitor.close();
    }
  });

  test('fits a phone at 320, 375 and 390px with the heading and the CTA on screen', async ({
    browser,
  }) => {
    for (const width of PHONE_WIDTHS) {
      const visitor = await Actor.open(browser, `hero-${width}`, primaryRuntime, {
        viewport: { width, height: 780 },
      });

      try {
        await visitor.gotoWeb('/');
        const heading = visitor.page.locator('h1.lp-h1');
        await expect(heading).toBeVisible();

        // Still the whole slogan, however many lines it took to get there.
        expect(collapse(await heading.innerText()), `hero text @${width}`).toBe(SLOGAN);
        await expect(visitor.page.locator('#lp-hero')).not.toContainText(RETIRED_SLOGAN);

        await expectNoHorizontalOverflow(visitor.page, `home @${width}`);
        await expectWithinViewport(visitor.page, 'h1.lp-h1', `slogan @${width}`);
        await expectWithinViewport(visitor.page, '.lp-h1-line', `first sentence @${width}`);
        await expectWithinViewport(visitor.page, '.lp-accent', `accent word @${width}`);

        // The heading is on the first screen and the button under it is
        // reachable — the slogan grew by a line, so this is the thing to watch.
        const headingTop = await heading.evaluate((element) => element.getBoundingClientRect().top);
        expect(headingTop, `slogan @${width} starts below the first screen`).toBeLessThan(600);

        const cta = visitor.page.locator('.lp-hero-search-row').getByRole('button', {
          name: 'Teklif Al',
        });
        await expect(cta, `CTA @${width}`).toBeVisible();
        await expectWithinViewport(visitor.page, '.lp-hero-search-row .btn-primary', `CTA @${width}`);

        await visitor.page.screenshot({
          path: resolve(SHOTS, `hero-${width}.png`),
          fullPage: false,
        });
      } finally {
        await visitor.close();
      }
    }
  });
});
