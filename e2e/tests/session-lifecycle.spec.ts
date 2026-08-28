import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCustomer, prisma } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * Scenario 10 — the session lifecycle, in a real browser.
 *
 * Nothing here waits out a real timeout. The idle clock is `Session.lastSeenAt`
 * in the database, so moving that column back is the injected clock: it puts a
 * session in exactly the state half an hour of silence would, and the decision
 * is then made by the production code path against the real row. A suite that
 * waited thirty minutes would prove the same thing and cost thirty minutes; one
 * that faked timers in the page would prove only that the page believes itself.
 *
 * The browser's own clock is tested too, and separately — as something that
 * must NOT matter. A tab whose `Date` is years out is still signed in, because
 * the server is what decides and the countdown in the page is measured on a
 * monotonic clock rather than a wall one.
 */

const AUTH_COOKIE = 'taktic_session';

/** The session behind an actor's cookie jar. */
async function sessionIdOf(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name === AUTH_COOKIE);
  expect(session, 'the actor must be holding a session cookie').toBeTruthy();
  return decodeURIComponent(session!.value);
}

/** Moves a session's last activity into the past — the injected idle clock. */
async function idleFor(sessionId: string, seconds: number): Promise<void> {
  await prisma().session.update({
    where: { id: sessionId },
    data: { lastSeenAt: new Date(Date.now() - seconds * 1000) },
  });
}

test.describe('session lifecycle', () => {
  test('an ordinary session is not persistent, and a remembered one is', async ({ browser }) => {
    const plain = await createCustomer();
    const remembered = await createCustomer();

    const first = await Actor.open(browser, 'plain', primaryRuntime);
    const second = await Actor.open(browser, 'remembered', primaryRuntime);

    try {
      // ---- no "beni hatırla": a session cookie ---------------------------
      await first.gotoWeb('/login');
      await expect(first.page.locator('input[name="rememberMe"]')).not.toBeChecked();
      await first.page.locator('input[name="email"]').fill(plain.email);
      await first.page.locator('input[name="password"]').fill(plain.password);
      await first.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(first.page).not.toHaveURL(/\/login/);

      const plainCookie = (await first.page.context().cookies()).find(
        (cookie) => cookie.name === AUTH_COOKIE,
      );
      expect(plainCookie?.httpOnly, 'the session cookie must be HttpOnly').toBe(true);
      expect(plainCookie?.sameSite).toBe('Lax');
      // -1 is how Playwright reports a session cookie: no expiry, so the
      // browser drops it on exit.
      expect(plainCookie?.expires, 'an ordinary session must not survive the browser').toBe(-1);

      const plainSession = await prisma().session.findUniqueOrThrow({
        where: { id: decodeURIComponent(plainCookie!.value) },
      });
      expect(plainSession.rememberMe).toBe(false);

      // ---- "beni hatırla": a persistent one -------------------------------
      await second.gotoWeb('/login');
      await second.page.locator('input[name="email"]').fill(remembered.email);
      await second.page.locator('input[name="password"]').fill(remembered.password);
      await second.page.locator('input[name="rememberMe"]').check();
      await second.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(second.page).not.toHaveURL(/\/login/);

      const rememberedCookie = (await second.page.context().cookies()).find(
        (cookie) => cookie.name === AUTH_COOKIE,
      );
      expect(rememberedCookie?.httpOnly).toBe(true);
      expect(rememberedCookie?.expires ?? -1).toBeGreaterThan(0);

      const rememberedSession = await prisma().session.findUniqueOrThrow({
        where: { id: decodeURIComponent(rememberedCookie!.value) },
      });
      expect(rememberedSession.rememberMe).toBe(true);
      // A month, not eight hours.
      const lifetimeDays =
        (rememberedSession.expiresAt.getTime() - rememberedSession.createdAt.getTime()) /
        (24 * 60 * 60 * 1000);
      expect(lifetimeDays).toBeGreaterThan(25);

      // ---- and nothing about it is in the browser's own storage ----------
      const stored = await second.page.evaluate(() => ({
        local: Object.entries(window.localStorage),
        session: Object.entries(window.sessionStorage),
      }));
      expect(stored.local, '"remember me" must write nothing to localStorage').toEqual([]);
      expect(stored.session).toEqual([]);
      // And the cookie is unreadable from script, HttpOnly being the whole point.
      expect(await second.page.evaluate(() => document.cookie)).not.toContain(AUTH_COOKIE);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  test('inactivity ends both an ordinary and a remembered session', async ({ browser }) => {
    const plain = await createCustomer();
    const remembered = await createCustomer();

    const first = await Actor.open(browser, 'plain', primaryRuntime);
    const second = await Actor.open(browser, 'remembered', primaryRuntime);

    try {
      await first.loginToWeb(plain.email, plain.password);
      const plainSessionId = await sessionIdOf(first.page);

      await second.gotoWeb('/login');
      await second.page.locator('input[name="email"]').fill(remembered.email);
      await second.page.locator('input[name="password"]').fill(remembered.password);
      await second.page.locator('input[name="rememberMe"]').check();
      await second.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(second.page).not.toHaveURL(/\/login/);
      const rememberedSessionId = await sessionIdOf(second.page);

      // Twenty-nine minutes of silence: still inside the window, for both.
      await idleFor(plainSessionId, 29 * 60);
      await idleFor(rememberedSessionId, 29 * 60);
      await first.gotoWeb('/requests/my');
      await expect(first.page).not.toHaveURL(/\/login/);
      await second.gotoWeb('/requests/my');
      await expect(second.page).not.toHaveURL(/\/login/);

      // Thirty-one is not — and "beni hatırla" buys a longer maximum, never a
      // longer silence.
      await idleFor(plainSessionId, 31 * 60);
      await idleFor(rememberedSessionId, 31 * 60);

      await first.gotoWeb('/requests/my');
      await expect(first.page).toHaveURL(/\/login/);
      await second.gotoWeb('/requests/my');
      await expect(second.page).toHaveURL(/\/login/);

      // The remembered session still has weeks of absolute life left, and none
      // of it is reachable.
      const stillFuture = await prisma().session.findUniqueOrThrow({
        where: { id: rememberedSessionId },
      });
      expect(stillFuture.expiresAt.getTime()).toBeGreaterThan(Date.now());

      await assertNoErrorScreen(first.page);
      await assertNoErrorScreen(second.page);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  test('the tab warns before the cut-off, and "devam et" keeps the session', async ({
    browser,
  }) => {
    const account = await createCustomer();
    const actor = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await actor.loginToWeb(account.email, account.password);
      const sessionId = await sessionIdOf(actor.page);

      await actor.gotoWeb('/requests/my');
      await expect(actor.page.getByTestId('session-warning')).toHaveCount(0);

      // Ninety seconds short of the thirty-minute cut-off, which is inside the
      // two-minute warning window. The tab has not been told; it finds out on
      // its own next poll, which is the behaviour under test.
      await idleFor(sessionId, 30 * 60 - 90);

      const warning = actor.page.getByTestId('session-warning');
      await expect(warning).toBeVisible({ timeout: 45_000 });
      await expect(actor.page.getByTestId('session-warning-countdown')).toBeVisible();

      // Staying signed in is one click, and it moves the mark on the server.
      const before = await prisma().session.findUniqueOrThrow({ where: { id: sessionId } });
      await actor.page.getByTestId('session-warning-extend').click();
      await expect(warning).toHaveCount(0, { timeout: 20_000 });

      const after = await prisma().session.findUniqueOrThrow({ where: { id: sessionId } });
      expect(after.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
      // Extending slides the idle window and nothing else: the absolute expiry
      // is exactly where it was, so a session cannot renew itself forever.
      expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());

      // And the page is still usable, not a shell behind a dismissed dialog.
      await actor.gotoWeb('/requests/my');
      await expect(actor.page).not.toHaveURL(/\/login/);
      await assertNoErrorScreen(actor.page);
    } finally {
      await actor.close();
    }
  });

  test('an unanswered warning ends in a sign-out that remembers where you were', async ({
    browser,
  }) => {
    const account = await createCustomer();
    const actor = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await actor.loginToWeb(account.email, account.password);
      const sessionId = await sessionIdOf(actor.page);

      await actor.gotoWeb('/requests/matches');
      await expect(actor.page).toHaveURL(/\/requests\/matches/);

      // Nobody answered, and the window ran out.
      await idleFor(sessionId, 31 * 60);

      // The tab notices by itself — no navigation, no click.
      await expect(actor.page).toHaveURL(/\/login\?/, { timeout: 45_000 });
      const url = new URL(actor.page.url());
      expect(url.searchParams.get('reason')).toBe('session-expired');
      // The destination is carried, so signing in again lands where they were.
      expect(url.searchParams.get('redirectTo')).toBe('/requests/matches');

      // And the screen says what happened rather than looking like a random
      // logout.
      await expect(actor.page.getByTestId('session-expired-notice')).toBeVisible();
      await assertNoErrorScreen(actor.page);

      // Signing in again honours the destination.
      await actor.page.locator('input[name="email"]').fill(account.email);
      await actor.page.locator('input[name="password"]').fill(account.password);
      await actor.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(actor.page).toHaveURL(/\/requests\/matches/);
    } finally {
      await actor.close();
    }
  });

  test('logging out in one tab drops the others, and revokes on the server', async ({
    browser,
  }) => {
    const account = await createCustomer();
    const actor = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await actor.loginToWeb(account.email, account.password);
      const sessionId = await sessionIdOf(actor.page);

      // A second tab in the same browser, on a signed-in screen.
      const secondTab = await actor.context.newPage();
      await secondTab.goto(`${primaryRuntime.webUrl}/requests/matches`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(secondTab).toHaveURL(/\/requests\/matches/);

      // Sign out in the first one, through the real menu.
      await actor.gotoWeb('/requests/my');
      await actor.page.locator('.cdash-user-summary').click();
      await actor.page.getByTestId('customer-logout').click();
      await expect(actor.page).toHaveURL(new RegExp(`^${primaryRuntime.webUrl}/$`));

      // The session is revoked on the server, not merely forgotten by this
      // browser — which is what makes the cookie worthless everywhere it exists.
      const revoked = await prisma().session.findUniqueOrThrow({ where: { id: sessionId } });
      expect(revoked.revokedAt).not.toBeNull();

      // And the other tab leaves the signed-in screen by itself.
      await expect(secondTab).toHaveURL(/\/login/, { timeout: 45_000 });
      await assertNoErrorScreen(secondTab);
      await secondTab.close();
    } finally {
      await actor.close();
    }
  });

  test('moving the browser clock changes nothing about the session', async ({ browser }) => {
    const account = await createCustomer();
    const actor = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await actor.loginToWeb(account.email, account.password);
      const sessionId = await sessionIdOf(actor.page);

      // The page's wall clock, ten years into the future.
      //
      // Only `Date.now` is replaced, deliberately: it is the reading a page
      // would use to work out how much time it has left, and swapping the whole
      // `Date` constructor would break React and Next long before it proved
      // anything about sessions. `performance.now()` — the monotonic clock the
      // countdown actually measures against — is untouched, because a page
      // cannot move it.
      await actor.page.addInitScript(() => {
        const skewMs = 10 * 365 * 24 * 60 * 60 * 1000;
        const realNow = Date.now.bind(Date);
        Date.now = () => realNow() + skewMs;
      });

      await actor.gotoWeb('/requests/my');

      // The clock really is skewed in this page…
      const skewYears = await actor.page.evaluate(
        (realNow) => (Date.now() - realNow) / (365 * 24 * 60 * 60 * 1000),
        Date.now(),
      );
      expect(skewYears).toBeGreaterThan(5);

      // …and the session is untouched: no warning, no sign-out, and the screen
      // still renders.
      await actor.page.waitForTimeout(35_000);
      await expect(actor.page).not.toHaveURL(/\/login/);
      await expect(actor.page.getByTestId('session-warning')).toHaveCount(0);
      await assertNoErrorScreen(actor.page);

      // The other direction is the one that matters more: a clock moved
      // backwards must not keep a session the server has already ended.
      await idleFor(sessionId, 31 * 60);
      await actor.gotoWeb('/requests/my');
      await expect(actor.page).toHaveURL(/\/login/);
    } finally {
      await actor.close();
    }
  });

  test('the admin panel signs in with the same policy, and warns the same way', async ({
    browser,
  }) => {
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      // ---- "beni hatırla" is on the admin form too -------------------------
      await admin.gotoAdmin('/login');
      await expect(admin.page.locator('input[name="rememberMe"]')).toBeVisible();
      await admin.page.locator('input[name="email"]').fill(adminAccount.email);
      await admin.page.locator('input[name="password"]').fill(adminAccount.password);
      await admin.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(admin.page).not.toHaveURL(/\/login/);

      const sessionId = await sessionIdOf(admin.page);
      const session = await prisma().session.findUniqueOrThrow({ where: { id: sessionId } });
      // The same server-authoritative policy as every other surface: an
      // ordinary session, not a remembered one, because the box was not ticked.
      expect(session.rememberMe).toBe(false);

      // ---- and the same idle rule ------------------------------------------
      await admin.gotoAdmin('/requests');
      await idleFor(sessionId, 31 * 60);

      await expect(admin.page).toHaveURL(/\/login/, { timeout: 45_000 });
      await expect(admin.page.getByTestId('session-expired-notice')).toBeVisible();
      await assertNoErrorScreen(admin.page);
    } finally {
      await admin.close();
    }
  });
});
