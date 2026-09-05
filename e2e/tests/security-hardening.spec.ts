import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCustomer } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The transport-level defences, driven through the real stack.
 *
 * Each block below is a defect that was real in this repository, asserted from
 * the outside where it would have been exploited rather than from the unit that
 * fixes it:
 *
 * **The open redirect.** `/login?redirectTo=` was carried into a hidden field
 * and then into the post-sign-in `redirect()` unchecked, so a link could land
 * somebody on an attacker's copy of this site at the one moment they had just
 * proved they trust it. The unit rules live in @taktic/shared's safe-redirect
 * spec; what is checked here is that the browser really does not leave.
 *
 * **Reflected CORS.** The API answered `origin: true` with `credentials: true`,
 * which reflects whatever `Origin` the caller sent — so any page a signed-in
 * person opened could read this API as them.
 *
 * **Missing headers, and one header too many.** All three applications now
 * state the same five, and none of them announces its stack any more.
 *
 * Every hostile origin here is `evil.example`, reserved by RFC 2606.
 */

/** What every response from all three applications has to carry. */
const REQUIRED_HEADERS: Array<[string, string]> = [
  ['strict-transport-security', 'max-age=31536000'],
  ['x-content-type-options', 'nosniff'],
  ['content-security-policy', "frame-ancestors 'self'"],
  ['x-frame-options', 'SAMEORIGIN'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
];

/**
 * Destinations a sign-in must refuse to follow.
 *
 * The encoded pair is the one a `startsWith('/')` check waves through: it is
 * `///evil.example` by the time anything resolves it.
 */
const HOSTILE_DESTINATIONS = [
  'https://evil.example/takeover',
  '//evil.example/takeover',
  '/%2f%2fevil.example/takeover',
];

test.describe('open redirect', () => {
  for (const destination of HOSTILE_DESTINATIONS) {
    test(`signing in with redirectTo=${destination} stays on this site`, async ({ browser }) => {
      const account = await createCustomer();
      const actor = await Actor.open(browser, 'customer', primaryRuntime);

      try {
        await actor.gotoWeb(`/login?redirectTo=${encodeURIComponent(destination)}`);

        // Refused on the way in as well as on the way out: the value never
        // reaches the field the form would post back.
        await expect(actor.page.locator('input[name="redirectTo"]')).toHaveCount(0);

        await actor.page.locator('input[name="email"]').fill(account.email);
        await actor.page.locator('input[name="password"]').fill(account.password);
        await actor.page.getByRole('button', { name: 'Giriş Yap' }).click();

        // The customer's own screen, on this origin — the destination a
        // sign-in with no `redirectTo` at all would have produced.
        await expect(actor.page).toHaveURL(`${primaryRuntime.webUrl}/requests/my`);
        await assertNoErrorScreen(actor.page);
      } finally {
        await actor.close();
      }
    });
  }

  test('a real destination still survives, query string and all', async ({ browser }) => {
    const account = await createCustomer();
    const actor = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      const destination = '/requests/offers?status=NEW';
      await actor.gotoWeb(`/login?redirectTo=${encodeURIComponent(destination)}`);

      await expect(actor.page.locator('input[name="redirectTo"]')).toHaveValue(destination);

      await actor.page.locator('input[name="email"]').fill(account.email);
      await actor.page.locator('input[name="password"]').fill(account.password);
      await actor.page.getByRole('button', { name: 'Giriş Yap' }).click();

      await expect(actor.page).toHaveURL(`${primaryRuntime.webUrl}${destination}`);
      await assertNoErrorScreen(actor.page);
    } finally {
      await actor.close();
    }
  });
});

test.describe('CORS', () => {
  for (const [name, origin] of [
    ['the web application', primaryRuntime.webUrl],
    ['the admin panel', primaryRuntime.adminUrl],
  ] as const) {
    test(`${name} may call the API with the session cookie`, async ({ request }) => {
      const response = await request.get(`${primaryRuntime.apiUrl}/health`, {
        headers: { Origin: origin },
      });

      expect(response.status()).toBe(200);
      expect(response.headers()['access-control-allow-origin']).toBe(origin);
      expect(response.headers()['access-control-allow-credentials']).toBe('true');
    });
  }

  test('a stranger gets no permission of any kind', async ({ request }) => {
    const response = await request.get(`${primaryRuntime.apiUrl}/health`, {
      headers: { Origin: 'https://evil.example' },
    });

    // The request itself is answered — CORS is enforced in the browser — but
    // with nothing that would let the calling page read the answer. Neither
    // reflected nor `*`.
    expect(response.status()).toBe(200);
    expect(response.headers()['access-control-allow-origin']).toBeUndefined();
    expect(response.headers()['access-control-allow-credentials']).toBeUndefined();
  });

  test('a caller that sends no Origin is untouched', async ({ request }) => {
    const response = await request.get(`${primaryRuntime.apiUrl}/health`);

    expect(response.status()).toBe(200);
    expect(response.headers()['access-control-allow-origin']).toBeUndefined();
  });

  test('a real cross-origin call from the web app still reaches the API', async ({ browser }) => {
    const actor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      // The landing page and the category search both call the API straight
      // from the browser with `credentials: 'include'`, which is precisely the
      // shape the allow-list decides. Made from a real page on the web origin,
      // so the browser applies the rule rather than this test describing it.
      await actor.gotoWeb('/');

      const status = await actor.page.evaluate(async (apiUrl) => {
        const response = await fetch(`${apiUrl}/categories?q=e&limit=6`, {
          credentials: 'include',
        });
        return response.status;
      }, primaryRuntime.apiUrl);

      expect(status).toBe(200);
    } finally {
      await actor.close();
    }
  });
});

test.describe('security headers', () => {
  for (const [name, baseUrl, path] of [
    ['the API', primaryRuntime.apiUrl, '/health'],
    ['the web application', primaryRuntime.webUrl, '/login'],
    ['the admin panel', primaryRuntime.adminUrl, '/login'],
  ] as const) {
    test(`${name} states all five, and no longer names its stack`, async ({ request }) => {
      const response = await request.get(`${baseUrl}${path}`);
      const headers = response.headers();

      expect(response.status()).toBe(200);

      for (const [header, value] of REQUIRED_HEADERS) {
        expect(headers[header], `${name} is missing ${header}`).toBe(value);
      }

      expect(headers['x-powered-by']).toBeUndefined();
    });
  }
});
