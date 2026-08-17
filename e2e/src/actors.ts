import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { Runtime } from './runtime';

/**
 * One browser context per actor.
 *
 * Cookies ignore ports, so the web app and the admin app — both on 127.0.0.1 —
 * share a cookie jar inside a single context. Logging the admin in would
 * silently replace the customer's session and the next customer assertion would
 * fail for a reason that has nothing to do with the feature. A context per
 * actor is also what makes "customer B cannot see customer A's request" a real
 * test rather than a same-session illusion.
 */
export class Actor {
  private constructor(
    readonly name: string,
    readonly context: BrowserContext,
    readonly page: Page,
    readonly runtime: Runtime,
  ) {}

  static async open(browser: Browser, name: string, runtime: Runtime): Promise<Actor> {
    const context = await browser.newContext();
    const page = await context.newPage();
    return new Actor(name, context, page, runtime);
  }

  async close() {
    await this.context.close();
  }

  webUrl(path: string): string {
    return `${this.runtime.webUrl}${path}`;
  }

  adminUrl(path: string): string {
    return `${this.runtime.adminUrl}${path}`;
  }

  async gotoWeb(path: string) {
    await this.page.goto(this.webUrl(path), { waitUntil: 'domcontentloaded' });
  }

  async gotoAdmin(path: string) {
    await this.page.goto(this.adminUrl(path), { waitUntil: 'domcontentloaded' });
  }

  /**
   * Signs in through the real form, so the session cookie under test is the one
   * the login server action actually set — the single most common way a change
   * to cookie flags or redirect handling breaks the product silently.
   */
  async loginToWeb(email: string, password: string, redirectTo?: string) {
    const query = redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : '';
    await this.gotoWeb(`/login${query}`);
    await this.page.locator('input[name="email"]').fill(email);
    await this.page.locator('input[name="password"]').fill(password);
    await this.page.getByRole('button', { name: 'Giriş Yap' }).click();

    // The action redirects on success and back to /login?error=1 on failure, so
    // landing anywhere else than /login is the signal that the session exists.
    await expect(this.page).not.toHaveURL(/\/login/);
    await assertNoErrorScreen(this.page);
  }

  async loginToAdmin(email: string, password: string) {
    await this.gotoAdmin('/login');
    await this.page.locator('input[name="email"]').fill(email);
    await this.page.locator('input[name="password"]').fill(password);
    await this.page.getByRole('button', { name: 'Giriş Yap' }).click();

    await expect(this.page).not.toHaveURL(/\/login/);
    await assertNoErrorScreen(this.page);
  }
}

/**
 * Fails on the generic error boundary of either app.
 *
 * A server action that throws — a bad cookie, an unhandled API status, a
 * serialization mismatch — renders this screen instead of the page, and every
 * subsequent locator would then fail with a confusing "not found". Checking for
 * it explicitly turns that class of regression into a clear failure, and it is
 * why the suite asserts it after every navigation that follows a mutation.
 */
export async function assertNoErrorScreen(page: Page) {
  await expect(page.getByText('Bir şeyler ters gitti')).toHaveCount(0);
  await expect(page.getByText('Application error')).toHaveCount(0);
}

/** The shared 404 experience: present, and free of raw API detail. */
export async function expectNotFoundScreen(page: Page) {
  await expect(page.getByRole('heading', { name: 'Sayfa bulunamadı' })).toBeVisible();
  await assertNoErrorScreen(page);

  const body = (await page.locator('body').innerText()).toLowerCase();
  for (const leak of ['not found', 'forbidden', 'statuscode', 'nestjs', 'prisma']) {
    expect(body, `the 404 page must not surface raw API text ("${leak}")`).not.toContain(leak);
  }
}
