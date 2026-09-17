import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { isAutoPublishEnabled, setAutoPublish } from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * The home page's two "an operator reads every request" claims follow the
 * instant-publish switch (REQ-UX-011): the "Admin ön inceleme" trust card and
 * the hero's "Ön inceleme · Her talep" floating card.
 *
 * With the switch off they read exactly as before. With it on, a fresh load
 * says the request reaches approved providers and collects offers, and
 * nothing on the customer path promises a review any more — while the
 * provider-side sentence ("İncelenmiş talepler") and the FAQ about the
 * provider *application* keep their words, because those are about other
 * processes. What the page does with a broken or missing policy answer is
 * `apps/web/test/landing-publish-copy.spec.ts`'s claim.
 */

const REVIEW_TRUST_TITLE = 'Admin ön inceleme';
const REVIEW_TRUST_DESC = 'Talepler yayına alınmadan önce inceleme süreçlerinden geçer.';
const INSTANT_TRUST_TITLE = 'Onaylı hizmet verenlere iletim';
const INSTANT_TRUST_DESC =
  'Talebin bölgendeki uygun ve onaylı hizmet verenlere iletilir; teklifler onlardan toplanır.';

const WIDTHS = [320, 768, 1440] as const;
const SCREENSHOT_DIR = resolve(artifactsDir, 'req-ux-011');

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${label}: the page is ${overflow}px wider than the viewport`).toBeLessThanOrEqual(0);
}

async function expectWithinViewport(page: Page, testId: string, label: string) {
  const box = await page.getByTestId(testId).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
  const limit = page.viewportSize()?.width ?? 0;
  expect(box.left, `${label}: ${testId} starts off the left edge`).toBeGreaterThanOrEqual(-1);
  expect(box.right, `${label}: ${testId} runs past the right edge`).toBeLessThanOrEqual(limit + 1);
  expect(box.scrollWidth, `${label}: ${testId}'s text is wider than it`).toBeLessThanOrEqual(
    box.clientWidth + 1,
  );
}

async function expectLanding(page: Page, state: 'on' | 'off', label: string) {
  const trust = page.getByTestId('landing-trust-cards');
  await expect(trust, `${label}: the trust cards`).toHaveAttribute('data-auto-publish', state);
  const hero = page.getByTestId('landing-hero-publish-card');
  await expect(hero, `${label}: the hero card`).toHaveAttribute('data-auto-publish', state);
  // As written, not as painted: the hero label is uppercased by CSS.
  const trustText = ((await trust.textContent()) ?? '').replace(/\s+/g, ' ');
  const heroText = await hero.evaluate((element) =>
    Array.from(element.querySelectorAll('.lp-floating-label, .lp-floating-val'))
      .map((part) => (part.textContent ?? '').trim())
      .join(' '),
  );
  if (state === 'on') {
    expect(trustText, label).toContain(INSTANT_TRUST_TITLE);
    expect(trustText, label).toContain(INSTANT_TRUST_DESC);
    expect(trustText, label).not.toContain(REVIEW_TRUST_TITLE);
    expect(trustText.toLowerCase(), label).not.toContain('incele');
    expect(heroText, label).toBe('Onaylı hizmet verenler Her talep');
  } else {
    expect(trustText, label).toContain(REVIEW_TRUST_TITLE);
    expect(trustText, label).toContain(REVIEW_TRUST_DESC);
    expect(trustText, label).not.toContain(INSTANT_TRUST_TITLE);
    expect(heroText, label).toBe('Ön inceleme Her talep');
  }
}

test.describe('landing copy and the instant-publish switch', () => {
  test.afterEach(async () => {
    await setAutoPublish(false);
  });

  test('the two review claims follow the switch, and nothing else on the page moves', async ({
    browser,
  }) => {
    const visitor = await Actor.open(browser, 'web', primaryRuntime);
    const page = visitor.page;

    try {
      expect(await isAutoPublishEnabled()).toBe(false);
      await visitor.gotoWeb('/');
      await assertNoErrorScreen(page);
      await expectLanding(page, 'off', 'switch off');
      // `textContent`, not `innerText`: the FAQ answer sits in a closed <details>.
      const offBody = (await page.locator('body').textContent()) ?? '';
      expect(offBody).toContain('İncelenmiş talepler.');
      expect(offBody).toContain('ekibimiz başvurunu inceler');

      await setAutoPublish(true);
      await visitor.gotoWeb('/');
      await assertNoErrorScreen(page);
      await expectLanding(page, 'on', 'switch on');
      const onBody = (await page.locator('body').textContent()) ?? '';
      // Provider-side and provider-application wording: other processes, unchanged.
      expect(onBody).toContain('İncelenmiş talepler.');
      expect(onBody).toContain('ekibimiz başvurunu inceler');
      // The customer path — hero, steps, trust — names no admin review any more.
      const customerPath = [
        await page.locator('.lp-hero').innerText().catch(() => ''),
        await page.getByTestId('landing-trust-cards').innerText(),
        await page.locator('#nasil-calisir').innerText(),
      ]
        .join(' ')
        .toLowerCase();
      expect(customerPath).not.toContain('admin ön inceleme');
      expect(customerPath).not.toContain('ön inceleme');

      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      for (const state of ['on', 'off'] as const) {
        await setAutoPublish(state === 'on');
        for (const width of WIDTHS) {
          const label = `switch ${state} @${width}`;
          await page.setViewportSize({ width, height: 900 });
          await visitor.gotoWeb('/');
          await assertNoErrorScreen(page);
          await expectLanding(page, state, label);
          await expectNoHorizontalOverflow(page, label);
          await page.getByTestId('landing-hero-publish-card').scrollIntoViewIfNeeded();
          await expectWithinViewport(page, 'landing-hero-publish-card', label);
          await page.screenshot({
            path: resolve(SCREENSHOT_DIR, `landing-hero-${state}-${width}.png`),
            fullPage: false,
          });
          await page.getByTestId('landing-trust-cards').scrollIntoViewIfNeeded();
          await expectWithinViewport(page, 'landing-trust-cards', label);
          await page.screenshot({
            path: resolve(SCREENSHOT_DIR, `landing-trust-${state}-${width}.png`),
            fullPage: false,
          });
        }
      }

      await setAutoPublish(false);
      await page.setViewportSize({ width: 1280, height: 900 });
      await visitor.gotoWeb('/');
      await expectLanding(page, 'off', 'switch off again');
    } finally {
      await visitor.close();
    }
  });
});
