import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createCategory,
  createClaimableCustomer,
  createCustomer,
  createProvider,
  prisma,
  requestFormValues,
  uniqueLocation,
  uniquePhone,
  uniqueSuffix,
  type Location,
  type SeededCategory,
} from '../src/fixtures';
import { createRequest, expectIdentityGateOpen, settleIdentityGate } from '../src/journeys';
import { emailCountFor, smsEntriesFor, waitForLatestSmsCode } from '../src/outbox';
import { primaryRuntime } from '../src/runtime';
import { retireShowcasePlacements, seedApprovedShowcaseCard, seedLiveShowcasePlacement } from '../src/showcase-fixtures';

/**
 * The Turnstile gate, driven through the real screens on a stack in the
 * deterministic test mode (see playwright.config.ts): the web app's adapter
 * mints tokens of the shape the API's test verifier accepts, carries them
 * exactly as it would carry Cloudflare's, and the API's guard judges them for
 * real. What this file proves is the part no integration test can — that the
 * token the browser produced is the one the API received, on every protected
 * surface, and that a refusal reaches the customer as one short sentence.
 *
 * A browser test steers the widget through `window.__TAKTIC_TURNSTILE_TEST__`,
 * which the adapter reads at each `acquire` — so an outcome can be set, seen
 * refused, and cleared again inside one scenario, the way a customer would
 * hit "tekrar deneyin" and succeed on the second go.
 *
 *   invalid      a token the API refuses (403 TURNSTILE_FAILED)
 *   unavailable  a token that makes the API's verifier unreachable (503)
 *   error        the widget itself fails; nothing is sent
 *
 * ## What is never on screen
 *
 * A token is a header value for one request. These scenarios read the URL,
 * the page's HTML, both storages and every cookie after each protected call
 * and assert the token's shape appears in none of them.
 */

const TEST_TOKEN = /turnstile-test:/;
const CHALLENGE_REFUSED = 'Güvenlik doğrulaması başarısız oldu. Lütfen tekrar deneyin.';
const CHALLENGE_UNAVAILABLE = 'Güvenlik doğrulaması şu anda yapılamıyor. Lütfen birkaç saniye sonra tekrar deneyin.';
const WIDGET_FAILED = 'Güvenlik doğrulaması tamamlanamadı. Lütfen tekrar deneyin.';
const IDENTITY_UNANSWERED = 'İletişim bilgileri doğrulanamadı, tekrar deneyin.';

type Outcome = 'invalid' | 'unavailable' | 'error' | null;

/** Steers the next challenge(s); null lets the widget succeed again. */
async function steerTurnstile(page: Page, outcome: Outcome): Promise<void> {
  await page.evaluate((value) => {
    if (value === null) delete window.__TAKTIC_TURNSTILE_TEST__;
    else window.__TAKTIC_TURNSTILE_TEST__ = { outcome: value };
  }, outcome);
}

declare global {
  interface Window {
    __TAKTIC_TURNSTILE_TEST__?: { outcome: 'invalid' | 'unavailable' | 'error' };
  }
}

/**
 * Nowhere a token may be: the address bar, the document, the two storages,
 * the cookie jar. Read after every protected call in the scenarios below.
 */
async function expectNoTokenAnywhere(actor: Actor): Promise<void> {
  const page = actor.page;
  expect(page.url()).not.toMatch(TEST_TOKEN);
  expect(await page.content()).not.toMatch(TEST_TOKEN);
  const stored = await page.evaluate(() => {
    const dump = (storage: Storage) =>
      Object.keys(storage).map((key) => `${key}=${storage.getItem(key) ?? ''}`);
    try {
      return [...dump(window.localStorage), ...dump(window.sessionStorage)].join('\n');
    } catch {
      return '';
    }
  });
  expect(stored).not.toMatch(TEST_TOKEN);
  for (const cookie of await actor.context.cookies()) {
    expect(cookie.value, `cookie ${cookie.name}`).not.toMatch(TEST_TOKEN);
  }
}

let addressSerial = 0;

/** A visitor with its own draft and request budgets — the trusted-proxy contract, see request-identity-gate.spec.ts. */
async function openVisitor(browser: Browser, testInfo: TestInfo): Promise<Actor> {
  addressSerial += 1;
  return Actor.open(browser, 'web', primaryRuntime, {
    extraHTTPHeaders: {
      'x-forwarded-for': `10.${88 + testInfo.retry}.${Math.floor(addressSerial / 200)}.${(addressSerial % 200) + 1}`,
    },
  });
}

/** The identity check's own POST — the one browser→web hop whose header this file can read. */
function identityCheckRequest(page: Page) {
  return page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      /\/api\/auth\/request-identity-check$/.test(new URL(request.url()).pathname),
  );
}

async function counts() {
  const db = prisma();
  return {
    requests: await db.serviceRequest.count(),
    leads: await db.showcaseLead.count(),
    verifications: await db.phoneVerification.count(),
    consumedDrafts: await db.requestDraft.count({ where: { consumedAt: { not: null } } }),
  };
}

const placementsOnAir: string[] = [];

test.afterEach(async () => {
  await retireShowcasePlacements(placementsOnAir.splice(0));
});

async function seedShowcase(namePrefix: string): Promise<{ category: SeededCategory; location: Location; cardId: string }> {
  const location = uniqueLocation();
  const category = await createCategory(3, { namePrefix });
  const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
  const { card, version } = await seedApprovedShowcaseCard({
    providerId: owner.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
    title: `${namePrefix} ${uniqueSuffix()}`,
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
  return { category, location, cardId: card.id };
}

test.describe('Turnstile: normal talep formu', () => {
  test('token her korunan çağrıda header ile gider; geçersiz token kısa hata verir, yenisi geçer', async ({ browser }, testInfo) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Turnstile Talep' });
    const visitor = await openVisitor(browser, testInfo);
    const values = requestFormValues(location, 'E2E Turnstile Ziyaretçi');

    try {
      await visitor.gotoWeb(`/categories/${category.slug}`);
      await assertNoErrorScreen(visitor.page);
      const form = visitor.page.locator('form.form-card');
      // The stack renders the test-mode widget, and nothing from Cloudflare.
      await expect(visitor.page.getByTestId('turnstile-slot')).toHaveAttribute('data-turnstile-mode', 'test');
      await expect(visitor.page.getByTestId('turnstile-test-widget')).toHaveCount(1);
      await expect(visitor.page.locator('script[src*="challenges.cloudflare.com"]')).toHaveCount(0);
      const before = await counts();

      // ── identity check: a refused token shuts the gate with the plain
      //    "could not be checked" sentence, and says nothing else ──────────
      await steerTurnstile(visitor.page, 'invalid');
      await form.locator('input[name="customerName"]').fill(values.customerName);
      await form.locator('input[name="customerPhone"]').fill(values.customerPhone);
      await form.locator('input[name="customerEmail"]').fill(values.customerEmail);
      const refusedCheck = identityCheckRequest(visitor.page);
      await form.locator('input[name="customerEmail"]').blur();
      expect((await refusedCheck).headers()['x-turnstile-token']).toMatch(/^turnstile-test:__invalid__:/);
      await expect(visitor.page.getByTestId('identity-error')).toContainText(IDENTITY_UNANSWERED);
      for (const other of ['identity-login-required', 'identity-activation-required', 'identity-conflict', 'identity-unavailable']) {
        await expect(visitor.page.getByTestId(other)).toHaveCount(0);
      }
      await expectNoTokenAnywhere(visitor);

      // ── "Tekrar dene" with the widget working again: a fresh token, minted
      //    for this operation, and the gate opens ──────────────────────────
      await steerTurnstile(visitor.page, null);
      const retriedCheck = identityCheckRequest(visitor.page);
      await visitor.page.getByRole('button', { name: 'Tekrar dene' }).click();
      const retried = await retriedCheck;
      expect(retried.headers()['x-turnstile-token']).toMatch(/^turnstile-test:identity-check:/);
      await expect(visitor.page.getByTestId('identity-checking')).toHaveCount(0);
      await expectIdentityGateOpen(visitor.page);
      await expectNoTokenAnywhere(visitor);

      // ── the rest of the form ──────────────────────────────────────────
      const next = visitor.page.getByRole('button', { name: 'Devam et' });
      await next.click();
      await expect(visitor.page.locator('#request-step-detail')).toBeVisible();
      await form.locator('textarea[name="description"]').fill(values.description);
      await next.click();
      await expect(visitor.page.locator('#request-step-place')).toBeVisible();
      await form.locator('select[name="city"]').selectOption(location.city);
      await form.locator('select[name="district"]').selectOption(location.district);

      // ── submit with a token the API refuses: the banner, no request ────
      await steerTurnstile(visitor.page, 'invalid');
      await visitor.page.getByRole('button', { name: 'Talebi Gönder' }).click();
      await expect(visitor.page.getByTestId('request-submit-error')).toHaveText(CHALLENGE_REFUSED);
      expect(visitor.page.url()).toContain(`/categories/${category.slug}`);
      expect((await counts()).requests).toBe(before.requests);
      await expectNoTokenAnywhere(visitor);

      // ── the widget itself failing: nothing sent, its own sentence ──────
      await steerTurnstile(visitor.page, 'error');
      await visitor.page.getByRole('button', { name: 'Talebi Gönder' }).click();
      await expect(visitor.page.getByTestId('request-submit-error')).toHaveText(WIDGET_FAILED);
      expect((await counts()).requests).toBe(before.requests);

      // ── Cloudflare unreachable on the API's side: fail closed, "try again" ──
      await steerTurnstile(visitor.page, 'unavailable');
      await visitor.page.getByRole('button', { name: 'Talebi Gönder' }).click();
      await expect(visitor.page.getByTestId('request-submit-error')).toHaveText(CHALLENGE_UNAVAILABLE);
      expect((await counts()).requests).toBe(before.requests);

      // ── and the same click with a good token: the old success ──────────
      await steerTurnstile(visitor.page, null);
      await visitor.page.getByRole('button', { name: 'Talebi Gönder' }).click();
      await expect(visitor.page).toHaveURL(/\/requests\/success\?id=/);
      await assertNoErrorScreen(visitor.page);
      expect((await counts()).requests).toBe(before.requests + 1);
      await expectNoTokenAnywhere(visitor);
    } finally {
      await visitor.close();
    }
  });

  test('etkinleştirme bağlantısı: geçersiz token ile mail gitmez, hesap durumu sızmaz; yenisiyle gider', async ({ browser }, testInfo) => {
    const category = await createCategory(3, { namePrefix: 'E2E Turnstile Etkinleştirme' });
    const claimable = await createClaimableCustomer('E2E Turnstile Şifresiz');
    const visitor = await openVisitor(browser, testInfo);

    try {
      await visitor.gotoWeb(`/categories/${category.slug}`);
      const form = visitor.page.locator('form.form-card');
      await form.locator('input[name="customerName"]').fill('E2E Turnstile Etkinleştiren');
      await form.locator('input[name="customerPhone"]').fill(claimable.phone);
      await form.locator('input[name="customerEmail"]').fill(claimable.email);
      const answered = identityCheckRequest(visitor.page);
      await form.locator('input[name="customerEmail"]').blur();
      await answered;
      await expect(visitor.page.getByTestId('identity-activation-required')).toBeVisible();

      // The link is asked for with a token the API refuses: the form reports
      // a failure it may retry, never "sent", and no mail leaves.
      await steerTurnstile(visitor.page, 'invalid');
      await visitor.page.getByTestId('identity-activate-cta').click();
      await expect(visitor.page.getByTestId('identity-error')).toContainText(IDENTITY_UNANSWERED);
      await expect(visitor.page.getByTestId('identity-activation-sent')).toHaveCount(0);
      expect(emailCountFor(claimable.email, 'customer-activation')).toBe(0);
      await expectNoTokenAnywhere(visitor);

      // "Tekrar dene" with the widget working: the link goes.
      await steerTurnstile(visitor.page, null);
      await visitor.page.getByRole('button', { name: 'Tekrar dene' }).click();
      await expect(visitor.page.getByTestId('identity-activation-sent')).toBeVisible();
      await expect.poll(() => emailCountFor(claimable.email, 'customer-activation')).toBe(1);
      await expectNoTokenAnywhere(visitor);
    } finally {
      await visitor.close();
    }
  });
});

test.describe('Turnstile: vitrin direct lead formu', () => {
  test('SMS gönderimi ve lead ayrı token ister; her ret kısa cümle, sonra eski başarı', async ({ browser }, testInfo) => {
    const stage = await seedShowcase('E2E Turnstile Vitrin');
    const visitor = await openVisitor(browser, testInfo);
    const phone = uniquePhone();
    const email = `e2e-turnstile-${uniqueSuffix()}@example.test`;

    try {
      await visitor.gotoWeb(`/vitrin/${stage.cardId}?step=form`);
      await assertNoErrorScreen(visitor.page);
      await expect(visitor.page.getByTestId('showcase-lead-form')).toBeVisible();
      await expect(visitor.page.getByTestId('turnstile-slot')).toHaveAttribute('data-turnstile-mode', 'test');
      const before = await counts();

      await visitor.page.getByLabel('Açıklama *').fill('Salon kliması bakım istiyorum, iki gündür soğutmuyor.');
      await visitor.page.getByTestId('request-city').selectOption(stage.location.city);
      await visitor.page.getByTestId('request-district').selectOption(stage.location.district);
      await visitor.page.getByTestId('showcase-lead-urgency').selectOption('THIS_WEEK');
      await visitor.page.getByTestId('showcase-urgency-urgent').check();

      await visitor.page.getByLabel('Ad soyad *').fill('E2E Turnstile Vitrin Ziyaretçi');
      await visitor.page.getByLabel('E-posta *').fill(email);
      await visitor.page.getByLabel('Telefon *').fill(phone);
      await settleIdentityGate(visitor.page, visitor.page.getByLabel('Telefon *'));

      // ── the SMS send with a refused token: no code, the sentence under the number ──
      await steerTurnstile(visitor.page, 'invalid');
      const send = visitor.page.getByTestId('showcase-lead-phone-send');
      await expect(send).toBeEnabled();
      await send.click();
      await expect(visitor.page.getByTestId('showcase-lead-phone-error')).toHaveText(CHALLENGE_REFUSED);
      expect(smsEntriesFor(phone)).toHaveLength(0);
      expect((await counts()).verifications).toBe(before.verifications);
      await expectNoTokenAnywhere(visitor);

      // ── "Kodu yeniden gönder" with a working widget: the code arrives and
      //    proves the number. A refused send leaves the panel on its code
      //    step with the resend control, as any failed send always has. ──
      await steerTurnstile(visitor.page, null);
      await expect(visitor.page.getByTestId('showcase-lead-phone-code')).toBeVisible();
      await visitor.page.getByRole('button', { name: 'Kodu yeniden gönder' }).click();
      const code = await waitForLatestSmsCode(phone);
      await visitor.page.getByTestId('showcase-lead-code').fill(code);
      await visitor.page.getByTestId('showcase-lead-phone-verify').click();
      await expect(visitor.page.getByTestId('showcase-lead-phone-verified')).toBeVisible();
      await expectNoTokenAnywhere(visitor);

      // ── the lead with the verifier unreachable: fail closed, no lead, proof kept ──
      await steerTurnstile(visitor.page, 'unavailable');
      await visitor.page.getByTestId('showcase-lead-submit').click();
      await expect(visitor.page.getByTestId('showcase-lead-error')).toHaveText(CHALLENGE_UNAVAILABLE);
      await expect(visitor.page.getByTestId('showcase-lead-phone-verified')).toBeVisible();
      expect((await counts()).leads).toBe(before.leads);
      await expectNoTokenAnywhere(visitor);

      // ── and with a good token: sent ───────────────────────────────────
      await steerTurnstile(visitor.page, null);
      await visitor.page.getByTestId('showcase-lead-submit').click();
      await assertNoErrorScreen(visitor.page);
      await expect(visitor.page.getByTestId('showcase-lead-sent')).toBeVisible();
      expect((await counts()).leads).toBe(before.leads + 1);
      await expectNoTokenAnywhere(visitor);
    } finally {
      await visitor.close();
    }
  });
});

test.describe('Turnstile: teklifler sayfasında telefon kodu', () => {
  test('oturumlu müşterinin kod isteği de token ister; ret kısa cümle, sonra kod gelir', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Turnstile OTP' });
    const account = await createCustomer('E2E Turnstile Müşteri');
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(account.email, account.password);
      const values = requestFormValues(location, account.name);
      const requestId = await createRequest(customer, category, values);

      await customer.gotoWeb(`/requests/${requestId}/offers`);
      await expect(customer.page.getByTestId('turnstile-slot')).toHaveAttribute('data-turnstile-mode', 'test');

      await steerTurnstile(customer.page, 'invalid');
      await customer.page.getByRole('button', { name: 'Doğrulama kodu gönder' }).click();
      await expect(customer.page).toHaveURL(/verification=challenge-failed/);
      await expect(customer.page.getByTestId('phone-verification-message')).toHaveText(CHALLENGE_REFUSED);
      expect(smsEntriesFor(values.customerPhone)).toHaveLength(0);
      await expectNoTokenAnywhere(customer);

      // The action's redirect is a client-side navigation — the document,
      // and the override on it, survive — so the widget is let succeed
      // again explicitly before the retry.
      await steerTurnstile(customer.page, null);
      await customer.page.getByRole('button', { name: 'Doğrulama kodu gönder' }).click();
      await expect(customer.page).toHaveURL(/verification=ok/);
      await expect.poll(() => smsEntriesFor(values.customerPhone).length).toBe(1);
      await expectNoTokenAnywhere(customer);
    } finally {
      await customer.close();
    }
  });
});

test.describe('Turnstile: API tarafı', () => {
  test('tarayıcısız bir istek token olmadan 403 alır ve hiçbir şey yazmaz', async ({ request }) => {
    const category = await createCategory(3, { namePrefix: 'E2E Turnstile Bot' });
    const before = await counts();

    const response = await request.post(`${primaryRuntime.apiUrl}/service-requests`, {
      data: {
        categorySlug: category.slug,
        customerName: 'Bot',
        customerPhone: uniquePhone(),
        customerEmail: `bot-${uniqueSuffix()}@example.test`,
        city: 'İstanbul',
        district: 'Kadıköy',
        description: 'Tarayıcısız gönderim.',
        answers: [],
      },
    });

    expect(response.status()).toBe(403);
    expect((await response.json()).code).toBe('TURNSTILE_REQUIRED');
    expect((await counts()).requests).toBe(before.requests);
  });
});
