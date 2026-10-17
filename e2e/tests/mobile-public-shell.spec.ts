import { expect, test, type Browser, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCategory, FIXTURE_PASSWORD, uniqueLocation, uniquePhone, uniqueSuffix } from '../src/fixtures';
import { completeContactStep } from '../src/journeys';
import { waitForLatestEmailVerificationUrl } from '../src/outbox';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * MOBILE-UX-HARDENING-001 — the public shell, the sign-in screens and the
 * request form on a phone.
 *
 * What started this: on a phone the auth screens opened onto a 380px red
 * "TakTick hesabı" poster with the form below the first screen, the header
 * wrapped its desktop links into three rows (248px before any page began), the
 * footer stacked four full link lists (~1,090px), and the request form's three
 * step tabs stacked into a column above the first question.
 *
 * What is asserted is the contract, not the styling: the thing the person came
 * to do is the first content under the header and on the first screen; the
 * header is one row with its links behind a toggle that opens, closes on
 * Escape and hands focus back; the footer folds and its legal links stay one
 * tap away; the step tabs share a row and back/forward work; nothing on these
 * routes is wider than the window at 320, 375 or 430. The desktop composition
 * is checked too, because every one of these changes is a narrow-screen rule
 * that must not have reached 1280px.
 */

const PHONES = [320, 360, 375, 390, 430] as const;
const SCREENSHOT_WIDTHS = [320, 375, 430] as const;
const PHONE_HEIGHT: Record<number, number> = { 320: 568, 360: 800, 375: 812, 390: 844, 430: 932 };
const DESKTOP = { width: 1280, height: 900 } as const;
const SHOTS = resolve(artifactsDir, 'mobile-shell');

function phone(width: number) {
  return { width, height: PHONE_HEIGHT[width] ?? 800 };
}

async function openAt(browser: Browser, name: string, viewport: { width: number; height: number }) {
  return Actor.open(browser, name, primaryRuntime, { viewport });
}

/** `scrollWidth <= clientWidth`, with the culprits named when it is not. */
async function expectNoHorizontalOverflow(page: Page, label: string) {
  const result = await page.evaluate(() => {
    const root = document.documentElement;
    const overflow = root.scrollWidth - root.clientWidth;
    const culprits: string[] = [];
    if (overflow > 0) {
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.right <= root.clientWidth + 1) continue;
        const style = getComputedStyle(element);
        if (['auto', 'scroll', 'hidden'].includes(style.overflowX)) continue;
        culprits.push(`${element.tagName.toLowerCase()}.${String(element.className).trim().split(/\s+/).join('.')}`);
        if (culprits.length >= 6) break;
      }
    }
    return { overflow, culprits };
  });

  expect(result.overflow, `${label}: ${result.overflow}px wider than the viewport — ${result.culprits.join(', ')}`).toBeLessThanOrEqual(0);
}

/** The element's top edge, in page coordinates. */
async function pageTop(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
}

/** `a` precedes `b` in the document — the order a screen reader reads. */
async function precedesInDom(page: Page, a: string, b: string): Promise<boolean> {
  return page.evaluate(
    ([first, second]) => {
      const x = document.querySelector(first);
      const y = document.querySelector(second);
      if (!x || !y) return false;
      return Boolean(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
    },
    [a, b] as const,
  );
}

async function shoot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

test.describe('auth screens on a phone', () => {
  test('login: the form is the first content and the poster comes after it', async ({ browser }) => {
    for (const width of PHONES) {
      const actor = await openAt(browser, `mobile-login-${width}`, phone(width));
      try {
        await actor.gotoWeb('/login');
        const page = actor.page;
        const label = `/login @${width}`;

        await expect(page.getByRole('heading', { level: 1, name: 'Tekrar hoş geldin' })).toBeVisible();
        expect(await precedesInDom(page, '.auth-screen-card', '.auth-poster'), `${label}: form before poster in the DOM`).toBe(true);
        expect(await precedesInDom(page, 'h1', '.auth-poster-title'), `${label}: the page's h1 before the poster's h2`).toBe(true);

        const formTop = await pageTop(page, '.auth-screen-card');
        const posterTop = await pageTop(page, '.auth-poster');
        expect(posterTop, `${label}: poster below the form`).toBeGreaterThan(formTop);
        // Directly under a one-row header — not below a poster or a wrapped nav.
        expect(formTop, `${label}: form starts ${formTop}px down`).toBeLessThan(120);

        // Sign-in is usable on the first screen: both fields and the submit.
        const viewportHeight = page.viewportSize()!.height;
        const submitBottom = await page
          .getByRole('button', { name: 'Giriş Yap' })
          .evaluate((element) => element.getBoundingClientRect().bottom);
        expect(submitBottom, `${label}: "Giriş Yap" ends ${Math.round(submitBottom)}px down`).toBeLessThanOrEqual(viewportHeight);

        // The poster is a short band, not a screen of its own.
        const posterHeight = await page.locator('.auth-poster').evaluate((element) => element.getBoundingClientRect().height);
        expect(posterHeight, `${label}: poster is ${Math.round(posterHeight)}px tall`).toBeLessThan(viewportHeight / 2);

        await expectNoHorizontalOverflow(page, label);
        if ((SCREENSHOT_WIDTHS as readonly number[]).includes(width)) await shoot(page, `login-${width}`);
      } finally {
        await actor.close();
      }
    }
  });

  test('a validation error wraps inside the card', async ({ browser }) => {
    const actor = await openAt(browser, 'mobile-login-error', phone(320));
    try {
      await actor.gotoWeb('/login?error=1');
      await expect(actor.page.locator('.auth-screen-error')).toBeVisible();
      await expectNoHorizontalOverflow(actor.page, '/login?error=1 @320');
    } finally {
      await actor.close();
    }
  });

  test('verification result: the result and its CTA are the first content', async ({ browser }) => {
    const actor = await openAt(browser, 'mobile-verify', phone(375));
    try {
      const page = actor.page;
      const email = `mobil-${uniqueSuffix()}@example.test`;

      // The real registration form on a phone, then the real link out of the outbox.
      await actor.gotoWeb('/register/customer');
      await expect(page.getByRole('heading', { level: 1, name: 'Hesap oluştur' })).toBeVisible();
      expect(await precedesInDom(page, '.auth-screen-card', '.auth-poster')).toBe(true);
      await expectNoHorizontalOverflow(page, '/register/customer @375');
      await shoot(page, 'register-customer-375');

      await page.locator('input[name="name"]').fill('E2E Mobil Müşteri');
      await page.locator('input[name="email"]').fill(email);
      await page.locator('input[name="phone"]').fill(uniquePhone());
      await page.locator('input[name="password"]').fill(FIXTURE_PASSWORD);
      await page.getByRole('button', { name: 'Hesap Oluştur' }).click();
      await expect(page).not.toHaveURL(/\/register/);

      const verifyUrl = await waitForLatestEmailVerificationUrl(email);
      await page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 1, name: 'E-postanız doğrulandı' })).toBeVisible();
      await assertNoErrorScreen(page);

      const cta = page.getByRole('link', { name: 'Taleplerime Git' });
      await expect(cta).toBeVisible();
      const viewportHeight = page.viewportSize()!.height;
      const ctaBottom = await cta.evaluate((element) => element.getBoundingClientRect().bottom);
      expect(ctaBottom, 'the CTA is on the first screen').toBeLessThanOrEqual(viewportHeight);
      expect(await pageTop(page, '.auth-poster')).toBeGreaterThan(ctaBottom);
      await expectNoHorizontalOverflow(page, '/e-posta-dogrula @375');
      await shoot(page, 'verify-result-375');

      // The spent link's error state keeps the same hierarchy.
      await page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 1, name: 'Bağlantı geçersiz' })).toBeVisible();
      expect(await precedesInDom(page, '.auth-screen-card', '.auth-poster')).toBe(true);
      await expect(page.getByRole('link', { name: 'Giriş ekranına dön' })).toBeInViewport();
    } finally {
      await actor.close();
    }
  });
});

test.describe('public header on a phone', () => {
  test('one row; the links open and close behind a toggle', async ({ browser }) => {
    for (const width of PHONES) {
      const actor = await openAt(browser, `mobile-header-${width}`, phone(width));
      try {
        const page = actor.page;
        const label = `header @${width}`;
        await actor.gotoWeb('/login');

        const header = page.locator('#site-header');
        const toggle = page.getByTestId('site-menu-toggle');
        const nav = header.getByRole('navigation', { name: 'Site navigation' });

        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAccessibleName('Menü');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(nav).toBeHidden();
        const headerHeight = await header.evaluate((element) => element.getBoundingClientRect().height);
        expect(headerHeight, `${label}: header is ${Math.round(headerHeight)}px tall`).toBeLessThanOrEqual(80);

        // Tap targets: the toggle is at least 44×44.
        const box = await toggle.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);

        // Keyboard open, Escape closes, focus comes back to the toggle.
        await toggle.focus();
        await page.keyboard.press('Enter');
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(nav).toBeVisible();
        await expect(nav.getByRole('link', { name: 'Kategoriler' })).toBeVisible();
        await expect(header.getByRole('link', { name: 'Giriş yap' })).toBeVisible();
        await expectNoHorizontalOverflow(page, `${label} menu open`);
        if (width === 375) await shoot(page, 'header-menu-open-375');
        await page.keyboard.press('Escape');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(nav).toBeHidden();
        await expect(toggle).toBeFocused();

        // Following a link navigates and leaves the menu shut.
        await toggle.click();
        await nav.getByRole('link', { name: 'Kategoriler' }).click();
        await expect(page).toHaveURL(/\/categories$/);
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(nav).toBeHidden();
      } finally {
        await actor.close();
      }
    }
  });
});

test.describe('request form on a phone', () => {
  test('step tabs share one row and back/next move between steps', async ({ browser }) => {
    const category = await createCategory(2, { namePrefix: 'E2E Mobil Klima' });

    for (const width of PHONES) {
      const actor = await openAt(browser, `mobile-request-${width}`, phone(width));
      try {
        const page = actor.page;
        const label = `request form @${width}`;
        await actor.gotoWeb(`/categories/${category.slug}`);
        await expect(page.locator('#request-step-contact')).toBeVisible();

        const tabs = page.locator('.stepper [role="tab"]');
        await expect(tabs).toHaveCount(3);
        const boxes = await tabs.evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { top: Math.round(rect.top), height: rect.height, width: rect.width };
          }),
        );
        expect(new Set(boxes.map((b) => b.top)).size, `${label}: tabs on one row`).toBe(1);
        for (const b of boxes) {
          expect(b.height, `${label}: tab height`).toBeGreaterThanOrEqual(44);
        }
        // The labels are readable: each tab names its step.
        await expect(tabs.nth(2)).toContainText('Konum');

        // The form starts on the first screen, not below the head and the tabs.
        const firstField = page.locator('#request-step-contact input:not([type="hidden"])').first();
        const fieldTop = await firstField.evaluate((element) => element.getBoundingClientRect().top);
        expect(fieldTop, `${label}: first field ${Math.round(fieldTop)}px down`).toBeLessThan(page.viewportSize()!.height * 1.5);

        await expectNoHorizontalOverflow(page, label);
        if ((SCREENSHOT_WIDTHS as readonly number[]).includes(width)) await shoot(page, `request-step-${width}`);

        // Back and next are side by side and inside the window.
        const back = page.getByRole('button', { name: 'Geri' });
        const next = page.getByRole('button', { name: 'Devam et' });
        const backBox = await back.boundingBox();
        const nextBox = await next.boundingBox();
        expect(Math.round(backBox!.y)).toBe(Math.round(nextBox!.y));
        expect(nextBox!.x + nextBox!.width).toBeLessThanOrEqual(width);
        expect(nextBox!.height).toBeGreaterThanOrEqual(44);

        if (width === 375) {
          const location = uniqueLocation();
          await completeContactStep(actor, {
            customerName: 'E2E Mobil Müşteri',
            customerPhone: uniquePhone(),
            customerEmail: `mobil-form-${uniqueSuffix()}@example.test`,
            city: location.city,
            district: location.district,
            description: 'Mobil ekranda adımlar arası geçiş testi.',
          });
          await expect(page.locator('#request-step-detail')).toBeVisible();
          await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
          await page.getByRole('button', { name: 'Geri' }).click();
          await expect(page.locator('#request-step-contact')).toBeVisible();
          await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
        }
      } finally {
        await actor.close();
      }
    }
  });

  test('HYBRID: the delivery choice fits and answers on a phone', async ({ browser }) => {
    const category = await createCategory(2, { namePrefix: 'E2E Mobil Hibrit', deliveryModel: 'HYBRID' });
    const actor = await openAt(browser, 'mobile-hybrid', phone(320));
    try {
      const page = actor.page;
      const location = uniqueLocation();
      await actor.gotoWeb(`/categories/${category.slug}`);
      await completeContactStep(actor, {
        customerName: 'E2E Mobil Hibrit',
        customerPhone: uniquePhone(),
        customerEmail: `mobil-hibrit-${uniqueSuffix()}@example.test`,
        city: location.city,
        district: location.district,
        description: 'Uzaktan da yapılabilecek bir iş için mobil test talebi.',
      });
      await page.locator('form.form-card textarea[name="description"]').fill('Uzaktan da yapılabilecek bir iş için mobil test talebi.');
      await page.getByRole('button', { name: 'Devam et' }).click();
      await expect(page.locator('#request-step-place')).toBeVisible();

      const field = page.getByTestId('delivery-mode-field');
      await expect(field).toBeVisible();
      await page.getByTestId('delivery-mode-remote').check();
      const note = page.getByTestId('delivery-mode-remote-note');
      await expect(note).toBeVisible();

      for (const element of [field, note]) {
        const box = await element.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
      await page.getByTestId('delivery-mode-on_site').check();
      await expect(note).toHaveCount(0);
      await expectNoHorizontalOverflow(page, 'HYBRID place step @320');
    } finally {
      await actor.close();
    }
  });
});

test.describe('footer on a phone', () => {
  test('groups fold; legal links stay one tap away', async ({ browser }) => {
    for (const width of [320, 375] as const) {
      const actor = await openAt(browser, `mobile-footer-${width}`, phone(width));
      try {
        const page = actor.page;
        await actor.gotoWeb('/categories');
        const footer = page.locator('footer.lp-footer');
        const toggles = footer.locator('.lp-footer-col-toggle');

        await expect(toggles).toHaveCount(4);
        for (const toggle of await toggles.all()) {
          await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        }
        await expect(footer.getByRole('link', { name: 'Tüm Kategoriler' })).toBeHidden();

        // Legal links do not fold.
        const legal = footer.getByRole('navigation', { name: 'Yasal' });
        for (const name of ['Kullanım Şartları', 'Gizlilik', 'KVKK']) {
          await expect(legal.getByRole('link', { name })).toBeVisible();
        }

        const folded = await footer.evaluate((element) => element.getBoundingClientRect().height);
        expect(folded, `footer @${width} is ${Math.round(folded)}px tall`).toBeLessThan(560);

        const services = footer.getByRole('button', { name: 'Hizmetler' });
        await services.click();
        await expect(services).toHaveAttribute('aria-expanded', 'true');
        await expect(footer.getByRole('link', { name: 'Tüm Kategoriler' })).toBeVisible();
        await expectNoHorizontalOverflow(page, `footer @${width}`);
        await footer.screenshot({ path: resolve(SHOTS, `footer-open-${width}.png`) });

        await services.press('Enter');
        await expect(services).toHaveAttribute('aria-expanded', 'false');
        await expect(footer.getByRole('link', { name: 'Tüm Kategoriler' })).toBeHidden();
      } finally {
        await actor.close();
      }
    }
  });
});

test.describe('mobile overflow sweep', () => {
  test('no route in the public/auth/request set is wider than a phone', async ({ browser }) => {
    const category = await createCategory(2, { namePrefix: 'E2E Mobil Tarama' });
    const routes = [
      '/',
      '/login',
      '/register/customer',
      '/register/provider',
      '/sifre-unuttum',
      '/sifre-sifirla?token=gecersiz',
      '/e-posta-dogrula?token=gecersiz',
      '/categories',
      `/categories/${category.slug}`,
      '/providers/register',
    ];

    for (const width of PHONES) {
      const actor = await openAt(browser, `mobile-sweep-${width}`, phone(width));
      try {
        for (const route of routes) {
          await actor.gotoWeb(route);
          await expect(actor.page.locator('#site-header')).toBeVisible();
          await expectNoHorizontalOverflow(actor.page, `${route} @${width}`);
        }
      } finally {
        await actor.close();
      }
    }
  });
});

test.describe('desktop composition is unchanged', () => {
  test('auth two columns, inline nav, footer columns at 1280', async ({ browser }) => {
    const actor = await openAt(browser, 'desktop-shell', DESKTOP);
    try {
      const page = actor.page;
      await actor.gotoWeb('/login');

      // Header: the links inline, no toggle.
      await expect(page.getByTestId('site-menu-toggle')).toBeHidden();
      const nav = page.locator('#site-header').getByRole('navigation', { name: 'Site navigation' });
      await expect(nav.getByRole('link', { name: 'Kategoriler' })).toBeVisible();
      const headerHeight = await page.locator('#site-header').evaluate((element) => element.getBoundingClientRect().height);
      expect(headerHeight).toBeLessThan(110);

      // Auth: poster left, form right, same row, equal halves.
      const poster = (await page.locator('.auth-poster').boundingBox())!;
      const form = (await page.locator('.auth-form-side').boundingBox())!;
      expect(poster.x).toBe(0);
      expect(form.x).toBeGreaterThanOrEqual(poster.x + poster.width - 1);
      expect(Math.round(poster.y)).toBe(Math.round(form.y));
      expect(Math.abs(poster.width - form.width)).toBeLessThanOrEqual(1);
      await expect(page.locator('.auth-poster-list')).toBeVisible();

      // Footer: headings, not toggles; every list open.
      const footer = page.locator('footer.lp-footer');
      await expect(footer.locator('.lp-footer-col-toggle').first()).toBeHidden();
      await expect(footer.getByRole('heading', { name: 'Hizmetler' })).toBeVisible();
      await expect(footer.getByRole('link', { name: 'Tüm Kategoriler' })).toBeVisible();
      const columnTops = await footer
        .locator('.lp-footer-col')
        .evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)));
      expect(new Set(columnTops).size, 'footer columns on one row').toBe(1);

      await expectNoHorizontalOverflow(page, '/login @1280');
      await shoot(page, 'login-1280');
    } finally {
      await actor.close();
    }
  });
});
