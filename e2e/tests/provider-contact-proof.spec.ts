import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCategory, createCustomer, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { waitForLatestProviderEmailVerificationUrl, waitForLatestSmsCode } from '../src/outbox';
import { primaryRuntime } from '../src/runtime';

/**
 * AUTH-PROVIDER-CONTACT-001 — a provider proves its own account e-mail and
 * telephone number from the "Hesap iletişimi" card on its business profile.
 *
 * The e-mail link is read from the API's recording mail transport and the
 * one-time code from its recording SMS transport: neither ever comes back over
 * HTTP, so this is the only honest way a browser test completes either. After
 * each proof the badge, its date and the absence of any further action are
 * read from the page as the provider sees it; the column is read from the
 * database as the campaign engine one day will.
 *
 * The Turnstile token the send carries is checked to be nowhere a token may
 * not be — the address bar, the document, both storages, the cookie jar —
 * under the same rule the customer routes are held to.
 */

const TEST_TOKEN = /turnstile-test:/;
const WIDTHS = [320, 768, 1024, 1440] as const;

let addressSerial = 0;

/** A provider with its own OTP address budget (see project note on OTP_MAX_SENDS_PER_IP_PER_HOUR). */
async function openProvider(browser: Browser, testInfo: TestInfo): Promise<Actor> {
  addressSerial += 1;
  return Actor.open(browser, 'provider', primaryRuntime, {
    extraHTTPHeaders: {
      'x-forwarded-for': `10.${91 + testInfo.retry}.${Math.floor(addressSerial / 200)}.${(addressSerial % 200) + 1}`,
    },
  });
}

async function expectNoTokenAnywhere(actor: Actor): Promise<void> {
  const page = actor.page;
  expect(page.url()).not.toMatch(TEST_TOKEN);
  expect(await page.content()).not.toMatch(TEST_TOKEN);
  const stored = await page.evaluate(() => {
    const dump = (storage: Storage) => Object.keys(storage).map((key) => `${key}=${storage.getItem(key) ?? ''}`);
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

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${label}: the page is ${overflow}px wider than the viewport`).toBeLessThanOrEqual(0);
}

async function expectNoClippedButtons(page: Page, selector: string, label: string) {
  const clipped = await page.locator(selector).first().evaluate((element) =>
    Array.from(element.querySelectorAll('button'))
      .filter((button) => button.scrollWidth > button.clientWidth + 1)
      .map((button) => button.textContent?.trim() ?? ''),
  );
  expect(clipped, `${label}: clipped button labels`).toEqual([]);
}

async function seedProvider() {
  const category = await createCategory(2, { namePrefix: 'E2E İletişim Kanıtı' });
  return createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 0 });
}

async function accountProofs(userId: string) {
  return prisma().user.findUniqueOrThrow({
    where: { id: userId },
    select: { emailVerifiedAt: true, phoneVerifiedAt: true },
  });
}

test.describe('provider account contact proof', () => {
  test('both channels start unproven, each is proven by its own real channel, and neither asks again', async ({ browser }, testInfo) => {
    const provider = await seedProvider();
    const actor = await openProvider(browser, testInfo);

    try {
      await actor.loginToWeb(provider.email, provider.password, `/providers/${provider.id}`);
      await actor.gotoWeb(`/providers/${provider.id}`);
      await assertNoErrorScreen(actor.page);

      const card = actor.page.getByTestId('account-contact-card');
      await expect(card).toBeVisible();
      await expect(card.getByTestId('account-email-verification')).toHaveAttribute('data-verified', 'false');
      await expect(card.getByTestId('account-phone-verification')).toHaveAttribute('data-verified', 'false');
      await expect(card.getByTestId('account-email-send')).toBeVisible();
      await expect(card.getByTestId('account-phone-send')).toBeVisible();
      await expect(card).toContainText(provider.email);
      // The account's number, which the fixture also wrote on the profile.
      await expect(card.getByTestId('account-contact-phone')).toContainText(provider.phone.slice(-4));

      // ── e-mail ──
      await card.getByTestId('account-email-send').click();
      await expect(actor.page).toHaveURL(/email=sent/);
      await expect(actor.page.getByTestId('account-email-message')).toContainText('gönderildi');
      await assertNoErrorScreen(actor.page);

      // Asking proves nothing.
      expect((await accountProofs(provider.userId)).emailVerifiedAt).toBeNull();

      const verifyUrl = await waitForLatestProviderEmailVerificationUrl(provider.email);
      expect(verifyUrl).toMatch(/\/e-posta-dogrula\?token=/);
      // The link is opened in a browser with no session, as from an inbox.
      const reader = await Actor.open(browser, 'reader', primaryRuntime);
      try {
        await reader.page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
        await expect(reader.page.getByRole('heading', { name: 'E-postanız doğrulandı' })).toBeVisible();
        await expect(reader.page.getByRole('link', { name: 'Panelime Git' })).toHaveAttribute('href', '/providers/me');
      } finally {
        await reader.close();
      }

      await expect.poll(async () => (await accountProofs(provider.userId)).emailVerifiedAt).not.toBeNull();

      await actor.gotoWeb(`/providers/${provider.id}`);
      await expect(card.getByTestId('account-email-verification')).toHaveAttribute('data-verified', 'true');
      await expect(card.getByTestId('account-email-verified-at')).toContainText('tarihinde doğrulandı');
      await expect(card.getByTestId('account-email-send')).toHaveCount(0);
      // The other channel is untouched.
      await expect(card.getByTestId('account-phone-verification')).toHaveAttribute('data-verified', 'false');
      expect((await accountProofs(provider.userId)).phoneVerifiedAt).toBeNull();

      // ── telefon ──
      await card.getByTestId('account-phone-send').click();
      await expect(actor.page).toHaveURL(/phone=sent/);
      await assertNoErrorScreen(actor.page);
      await expectNoTokenAnywhere(actor);
      await expect(actor.page.getByTestId('account-phone-message')).toContainText('Kod gönderildi');

      const code = await waitForLatestSmsCode(provider.phone);
      await actor.page.locator('#account-phone-code').fill(code);
      await actor.page.getByTestId('account-phone-verify').click();
      await expect.poll(async () => (await accountProofs(provider.userId)).phoneVerifiedAt).not.toBeNull();
      await expect(actor.page).toHaveURL(/phone=verified/);
      await assertNoErrorScreen(actor.page);
      await expectNoTokenAnywhere(actor);

      await expect(card.getByTestId('account-phone-verification')).toHaveAttribute('data-verified', 'true');
      await expect(card.getByTestId('account-phone-verified-at')).toContainText('tarihinde doğrulandı');
      await expect(card.getByTestId('account-phone-send')).toHaveCount(0);
      await expect(card.getByTestId('account-phone-verify')).toHaveCount(0);
      await expect(card.getByTestId('account-email-verification')).toHaveAttribute('data-verified', 'true');

      // The account row: the proof, its number, and the code row that earned it.
      const codeRow = await prisma().phoneVerification.findFirstOrThrow({
        where: { userId: provider.userId },
        select: { requestId: true, consumedAt: true, verifiedByTestBypass: true },
      });
      expect(codeRow).toEqual({ requestId: null, consumedAt: expect.any(Date), verifiedByTestBypass: false });

      // Nothing was granted: no credit moved for this business.
      expect(await prisma().providerCreditTransaction.count({ where: { providerId: provider.id } })).toBe(0);
    } finally {
      await actor.close();
    }
  });

  test('a wrong code is refused on the card and writes nothing', async ({ browser }, testInfo) => {
    const provider = await seedProvider();
    const actor = await openProvider(browser, testInfo);

    try {
      await actor.loginToWeb(provider.email, provider.password, `/providers/${provider.id}`);
      await actor.gotoWeb(`/providers/${provider.id}`);
      const card = actor.page.getByTestId('account-contact-card');

      await card.getByTestId('account-phone-send').click();
      await expect(actor.page).toHaveURL(/phone=sent/);
      const code = await waitForLatestSmsCode(provider.phone);
      const wrong = code === '000000' ? '000001' : '000000';

      await actor.page.locator('#account-phone-code').fill(wrong);
      await actor.page.getByTestId('account-phone-verify').click();
      await expect(actor.page).toHaveURL(/phone=invalid/);
      await expect(actor.page.getByTestId('account-phone-message')).toContainText('Kod geçersiz');
      await expect(actor.page.locator('#account-phone-code')).toHaveAttribute('aria-invalid', 'true');
      await expect(card.getByTestId('account-phone-verification')).toHaveAttribute('data-verified', 'false');
      expect((await accountProofs(provider.userId)).phoneVerifiedAt).toBeNull();
      await expectNoTokenAnywhere(actor);
    } finally {
      await actor.close();
    }
  });

  test('the card fits every width the brief names, unproven and proven', async ({ browser }, testInfo) => {
    const provider = await seedProvider();
    const actor = await openProvider(browser, testInfo);

    try {
      await actor.loginToWeb(provider.email, provider.password, `/providers/${provider.id}`);

      for (const proven of [false, true]) {
        if (proven) {
          await prisma().user.update({
            where: { id: provider.userId },
            data: { emailVerifiedAt: new Date(), phoneVerifiedAt: new Date() },
          });
        }
        for (const width of WIDTHS) {
          await actor.page.setViewportSize({ width, height: 900 });
          await actor.gotoWeb(`/providers/${provider.id}`);
          const label = `${width}px ${proven ? 'proven' : 'unproven'}`;
          await expect(actor.page.getByTestId('account-contact-card')).toBeVisible();
          await expectNoHorizontalOverflow(actor.page, label);
          await expectNoClippedButtons(actor.page, '[data-testid="account-contact-card"]', label);
          // The card never leaves its column.
          const box = await actor.page.getByTestId('account-contact-card').boundingBox();
          expect(box, label).not.toBeNull();
          expect(box!.x + box!.width, `${label}: card past the right edge`).toBeLessThanOrEqual(width + 1);
          if (proven) {
            await expect(actor.page.getByTestId('account-email-send')).toHaveCount(0);
            await expect(actor.page.getByTestId('account-phone-send')).toHaveCount(0);
          }
        }
      }
    } finally {
      await actor.close();
    }
  });

  test('a customer keeps their own settings badges and gets no provider card', async ({ browser }, testInfo) => {
    // Regression guard for the customer surface the card was modelled on.
    const customer = await createCustomer('E2E Müşteri Rozet');
    const actor = await openProvider(browser, testInfo);
    try {
      await actor.loginToWeb(customer.email, customer.password);
      await actor.gotoWeb('/account/profile');
      await expect(actor.page.getByTestId('account-email-verification')).toHaveAttribute('data-verified', 'false');
      await expect(actor.page.getByTestId('account-phone-verification')).toHaveAttribute('data-verified', 'false');
      await expect(actor.page.getByTestId('account-contact-card')).toHaveCount(0);
      await expect(actor.page.getByTestId('account-phone-send')).toHaveCount(0);
    } finally {
      await actor.close();
    }
  });
});
