import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { Actor } from '../src/actors';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * The request card beside the slogan, walking the process it used to only name.
 *
 * The card is the one place a visitor sees the product before signing up, and
 * what it now shows is a loop: a request is created, offers arrive from the
 * approved businesses in the visitor's area, the job is done. The order and the
 * wording are asserted on the model in `apps/web/test/hero-demo.spec.ts`; what
 * needs a browser is whether any of it actually happens on screen, and — more
 * to the point — whether it stops when it is supposed to.
 *
 * **It reaches all three states, and comes back round.** A loop that stalls on
 * the last state is the failure mode: the card would sit on "İş tamamlandı"
 * forever, which is a screenshot rather than a demonstration.
 *
 * **`prefers-reduced-motion: reduce` gets no loop at all.** Not a slower one —
 * none. The card is emulated at that preference here and has to be standing on
 * the finished state from the first paint and still be standing there several
 * seconds later, with every offer row shown, so the still is a complete
 * statement rather than a truncated one.
 *
 * **It fits a phone.** The card gained a step rail and three offer rows, all of
 * which are text in a fixed-width column, so 320px is where it would push the
 * document sideways and take the call to action off screen with it.
 */

/** The three steps, in the order the loop must reach them. */
const STEPS = ['Talep oluşturuldu', 'Uygun ustalardan teklifler geldi', 'İş tamamlandı'];

/** The lifecycle labels the card prints for those steps. */
const STATUSES = ['Gönderildi', 'Onaylandı', 'Tamamlandı'];

const DESKTOP = { width: 1280, height: 900 } as const;
const SHOTS = resolve(artifactsDir, 'hero-request-demo');

/** The loop is about nine seconds; no single step is held longer than four. */
const STEP_TIMEOUT = 12_000;

/** Long enough to watch one whole loop and see it begin a second one. */
const LOOP_WINDOW_MS = 14_000;

/** Nothing on the page may make the document wider than the window it is in. */
async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(
    overflow,
    `${label}: the page is ${overflow}px wider than the viewport`,
  ).toBeLessThanOrEqual(0);
}

test.describe('the hero request demo', () => {
  test('walks the three states of a request and starts over', async ({ browser }) => {
    const visitor = await Actor.open(browser, 'hero-demo-desktop', primaryRuntime, {
      viewport: DESKTOP,
    });

    try {
      await visitor.gotoWeb('/');
      const card = visitor.page.locator('[data-testid="hero-demo"]');
      const steps = visitor.page.locator('[data-testid="hero-demo-step"]');
      const offers = visitor.page.locator('[data-testid="hero-demo-offer"]');

      await expect(card).toBeVisible();

      // All three captions and all three offer rows are in the document at all
      // times, at the size they will keep. Only which of them has been reached
      // changes, so no step of the loop can move anything else on the page.
      await expect(steps).toHaveCount(3);
      expect(await steps.allInnerTexts()).toEqual(STEPS);
      await expect(offers).toHaveCount(3);

      /*
       * The loop is watched from inside the page rather than polled from
       * outside it. A step is held for under four seconds, so a test that
       * asserted between round trips would be racing the card; an observer
       * catches every change and reads the whole card at the moment it happens,
       * which makes each frame below internally consistent by construction.
       */
      const frames = await visitor.page.evaluate(async (windowMs) => {
        const demo = document.querySelector('[data-testid="hero-demo"]');
        if (!demo) throw new Error('the hero demo card is not on the page');

        const read = () => ({
          stage: demo.getAttribute('data-stage'),
          status: (demo.querySelector('[data-testid="hero-demo-status"]')?.textContent ?? '').trim(),
          detail: (demo.querySelector('[data-testid="hero-demo-detail"]')?.textContent ?? '').trim(),
          steps: Array.from(demo.querySelectorAll('[data-testid="hero-demo-step"]')).map((step) =>
            step.getAttribute('data-state'),
          ),
          offers: Array.from(demo.querySelectorAll('[data-testid="hero-demo-offer"]')).map((offer) =>
            offer.getAttribute('data-visible'),
          ),
        });

        const seen = [read()];
        const observer = new MutationObserver(() => {
          const frame = read();
          if (frame.stage !== seen[seen.length - 1]?.stage) seen.push(frame);
        });
        observer.observe(demo, { attributes: true, attributeFilter: ['data-stage'] });
        await new Promise((done) => setTimeout(done, windowMs));
        observer.disconnect();
        return seen;
      }, LOOP_WINDOW_MS);

      // Created, then the offers, then the finished job — and then round again.
      expect(
        frames.map((frame) => frame.stage).slice(0, 4),
        `the loop went ${frames.map((frame) => frame.stage).join(' → ')}`,
      ).toEqual(['created', 'offers', 'completed', 'created']);

      const [created, arrived, completed] = frames;

      // It opens calm: the request has just been created and nothing else is
      // claimed yet — no offer has arrived, no later step is marked.
      expect(created!.status).toBe(STATUSES[0]);
      expect(created!.detail.length, 'the opening step says what happened').toBeGreaterThan(0);
      expect(created!.steps).toEqual(['done', 'pending', 'pending']);
      expect(created!.offers).toEqual(['false', 'false', 'false']);

      // Then the offers land, all three of them, against the approved status.
      expect(arrived!.status).toBe(STATUSES[1]);
      expect(arrived!.detail, 'each step gets its own sentence').not.toBe(created!.detail);
      expect(arrived!.steps).toEqual(['done', 'done', 'pending']);
      expect(arrived!.offers).toEqual(['true', 'true', 'true']);

      // And the job is finished, with a mark against every one of the steps.
      expect(completed!.status).toBe(STATUSES[2]);
      expect(completed!.detail).not.toBe(arrived!.detail);
      expect(completed!.steps).toEqual(['done', 'done', 'done']);
      expect(completed!.offers).toEqual(['true', 'true', 'true']);

      // The quality bar ends full rather than part-filled. It is polled rather
      // than read once: the fill grows over a transition, so measuring it in
      // the instant the step changed would catch it on its way there.
      await expect(card).toHaveAttribute('data-stage', 'completed', { timeout: STEP_TIMEOUT });
      await expect
        .poll(
          async () =>
            visitor.page.locator('[data-testid="hero-demo-progress"]').evaluate((fill) => {
              const track = (fill.parentElement as HTMLElement).getBoundingClientRect().width;
              return track > 0 ? fill.getBoundingClientRect().width / track : 0;
            }),
          { timeout: 3_000, message: 'the quality bar never filled on the finished step' },
        )
        .toBeGreaterThan(0.99);
      await visitor.page.screenshot({ path: resolve(SHOTS, 'stage-completed.png') });

      // Starting over really starts over: the offer rows go back out rather
      // than staying on screen from the previous pass.
      await expect(card).toHaveAttribute('data-stage', 'created', { timeout: STEP_TIMEOUT });
      await expect
        .poll(
          async () =>
            visitor.page
              .locator('[data-testid="hero-demo-offer"] .lp-rc-offer-title')
              .evaluateAll((rows) =>
                rows.every((row) => Number(getComputedStyle(row).opacity) < 0.05),
              ),
          { timeout: 3_000, message: 'the offer rows stayed on screen after the loop restarted' },
        )
        .toBe(true);
      await visitor.page.screenshot({ path: resolve(SHOTS, 'stage-created.png') });
      await card.screenshot({ path: resolve(SHOTS, 'card-created.png') });

      await expectNoHorizontalOverflow(visitor.page, 'hero demo @1280');
    } finally {
      await visitor.close();
    }
  });

  test('stops the loop dead and shows the finished process when motion is refused', async ({
    browser,
  }) => {
    const visitor = await Actor.open(browser, 'hero-demo-reduced', primaryRuntime, {
      viewport: DESKTOP,
      reducedMotion: 'reduce',
    });

    try {
      await visitor.gotoWeb('/');
      const card = visitor.page.locator('[data-testid="hero-demo"]');
      const steps = visitor.page.locator('[data-testid="hero-demo-step"]');

      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute('data-motion', 'static');
      await expect(card).toHaveAttribute('data-stage', 'completed');

      // The still is the whole process, not the start of it: every step marked,
      // every offer in, the closing status.
      expect(await steps.allInnerTexts()).toEqual(STEPS);
      expect(await steps.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-state'))))
        .toEqual(['done', 'done', 'done']);
      await expect(visitor.page.locator('[data-testid="hero-demo-status"]')).toHaveText(
        STATUSES[2]!,
      );
      await expect(
        visitor.page.locator('[data-testid="hero-demo-offer"][data-visible="true"]'),
      ).toHaveCount(3);

      // Every offer is actually painted, not merely marked visible: what fades
      // in is the content of the slot, and a refused-motion visitor gets no fade.
      const opacities = await visitor.page
        .locator('[data-testid="hero-demo-offer"] .lp-rc-offer-title')
        .evaluateAll((rows) => rows.map((row) => Number(getComputedStyle(row).opacity)));
      for (const opacity of opacities) {
        expect(opacity, 'an offer row is left invisible with motion refused').toBeGreaterThan(0.9);
      }

      // And it is still there, unchanged, longer than a whole loop would take.
      await visitor.page.waitForTimeout(10_000);
      await expect(card).toHaveAttribute('data-stage', 'completed');
      expect(await steps.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-state'))))
        .toEqual(['done', 'done', 'done']);

      await expectNoHorizontalOverflow(visitor.page, 'hero demo reduced-motion @1280');
      await visitor.page.screenshot({ path: resolve(SHOTS, 'reduced-motion.png') });
    } finally {
      await visitor.close();
    }
  });

  test('holds its place while the hero is scrolled out of view', async ({ browser }) => {
    const visitor = await Actor.open(browser, 'hero-demo-offscreen', primaryRuntime, {
      viewport: DESKTOP,
    });

    try {
      await visitor.gotoWeb('/');
      const card = visitor.page.locator('[data-testid="hero-demo"]');
      await expect(card).toBeVisible();

      // Scrolled past, the card is nobody's demonstration — and a timer still
      // firing behind the fold is work done for no one.
      await visitor.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await expect(visitor.page.locator('#lp-hero')).not.toBeInViewport();
      await visitor.page.waitForTimeout(1_000);

      const parked = await card.getAttribute('data-stage');
      expect(parked).not.toBeNull();
      await visitor.page.waitForTimeout(LOOP_WINDOW_MS);
      expect(
        await card.getAttribute('data-stage'),
        'the loop kept running with the hero off screen',
      ).toBe(parked);

      // Scrolled back to, it carries on from where it was parked.
      await visitor.page.evaluate(() => window.scrollTo(0, 0));
      await expect(visitor.page.locator('#lp-hero')).toBeInViewport();
      await expect
        .poll(async () => card.getAttribute('data-stage'), {
          timeout: STEP_TIMEOUT,
          message: 'the loop did not pick up again once the hero was back on screen',
        })
        .not.toBe(parked);
    } finally {
      await visitor.close();
    }
  });

  test('fits a 320px phone with the call to action still on screen', async ({ browser }) => {
    const visitor = await Actor.open(browser, 'hero-demo-320', primaryRuntime, {
      viewport: { width: 320, height: 780 },
    });

    try {
      await visitor.gotoWeb('/');
      const card = visitor.page.locator('[data-testid="hero-demo"]');
      await expect(card).toBeVisible();

      // The card says the same three things at 320px as it does at 1280px.
      expect(await visitor.page.locator('[data-testid="hero-demo-step"]').allInnerTexts()).toEqual(
        STEPS,
      );

      await expectNoHorizontalOverflow(visitor.page, 'hero demo @320');

      // Neither the card nor any row inside it reaches past the right edge.
      const widest = await visitor.page.evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-testid="hero-demo"], [data-testid="hero-demo"] *',
          ),
        );
        return nodes.reduce(
          (worst, node) => Math.max(worst, Math.round(node.getBoundingClientRect().right)),
          0,
        );
      });
      expect(widest, 'something inside the card reaches past a 320px screen').toBeLessThanOrEqual(
        321,
      );

      // The hero's own call to action is untouched by any of this.
      const cta = visitor.page.locator('.lp-hero-search-row').getByRole('button', {
        name: 'Teklif Al',
      });
      await expect(cta).toBeVisible();
      const box = await cta.boundingBox();
      expect(box, 'the CTA has a box').not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, 'the CTA runs off a 320px screen').toBeLessThanOrEqual(321);

      await visitor.page.screenshot({ path: resolve(SHOTS, 'phone-320.png'), fullPage: false });
    } finally {
      await visitor.close();
    }
  });
});
