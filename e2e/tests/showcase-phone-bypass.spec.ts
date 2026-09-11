import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCategory, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { waitForLatestSmsCode } from '../src/outbox';
import {
  E2E_BYPASS_CODE,
  E2E_BYPASS_PHONE,
  E2E_BYPASS_PHONE_E164,
  phoneGateRuntime,
  primaryRuntime,
} from '../src/runtime';
import { seedApprovedShowcaseCard, seedLiveShowcasePlacement } from '../src/showcase-fixtures';

/**
 * The phone-verification test bypass, from the screen.
 *
 * Two runtimes drive the same card with the same number and the same code.
 * The phone-gate runtime declares itself local and carries every clause of the
 * bypass contract in its environment; the primary runtime carries none. The
 * first reaches the lead form; the second is refused with the ordinary "code
 * invalid" sentence. The request is byte-for-byte the same in both — which is
 * the whole claim: the environment opens the bypass, and nothing a browser
 * sends can.
 *
 * On both runtimes the screen is the ordinary screen. The code is typed into
 * the same field, the SMS is still issued to the same number, and nothing on
 * any page says a test code exists.
 */

async function liveCard() {
  const location = uniqueLocation();
  const category = await createCategory(3, { namePrefix: 'E2E Vitrin Doğrulama' });
  const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
  const { card, version } = await seedApprovedShowcaseCard({
    providerId: owner.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
    title: 'E2E Doğrulama Klima Bakımı',
  });
  await seedLiveShowcasePlacement({
    providerId: owner.id,
    cardId: card.id,
    versionId: version.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
  });
  return { card, location };
}

test.describe('vitrin: telefon doğrulama test modu', () => {
  test('local stack, listed number, test code → the lead form; the same on the primary stack → refused', async ({
    browser,
  }) => {
    const { card } = await liveCard();

    // Any proof left over from an earlier run of this spec would let the form
    // open without a verification at all, which is not what is being tested.
    await prisma().phoneVerification.deleteMany({ where: { normalizedPhone: E2E_BYPASS_PHONE_E164 } });

    const gated = await Actor.open(browser, 'web', phoneGateRuntime);
    const plain = await Actor.open(browser, 'web', primaryRuntime);

    try {
      // ── The runtime with the bypass ─────────────────────────────────────
      await gated.gotoWeb(`/vitrin/${card.id}?step=phone`);
      await assertNoErrorScreen(gated.page);
      await gated.page.getByLabel('Telefon *').fill(E2E_BYPASS_PHONE);
      await gated.page.getByRole('button', { name: 'Kod gönder' }).click();
      await expect(gated.page).toHaveURL(/step=code/);
      await assertNoErrorScreen(gated.page);

      // The ordinary flow ran: a real code was issued to the number, hashed,
      // and handed to the transport like any other.
      const sentCode = await waitForLatestSmsCode(E2E_BYPASS_PHONE);
      expect(sentCode).toMatch(/^\d{6}$/);

      // Nothing on the screen mentions a test code or a test mode.
      const codeScreen = await gated.page.content();
      expect(codeScreen).not.toContain(E2E_BYPASS_CODE);
      expect(codeScreen).not.toMatch(/test kodu|test modu|bypass/i);

      await gated.page.locator('input[name="code"]').fill(E2E_BYPASS_CODE);
      await gated.page.getByRole('button', { name: 'Doğrula', exact: true }).click();
      await expect(gated.page).toHaveURL(/step=form/);
      await assertNoErrorScreen(gated.page);
      await expect(gated.page.getByTestId('showcase-lead-form')).toBeVisible();

      // The proof is the ordinary proof — consumed, unbound — and audited as a
      // test proof. The row holds no code.
      const proof = await prisma().phoneVerification.findFirstOrThrow({
        where: { normalizedPhone: E2E_BYPASS_PHONE_E164 },
        orderBy: { createdAt: 'desc' },
      });
      expect(proof.consumedAt).not.toBeNull();
      expect(proof.requestId).toBeNull();
      expect(proof.verifiedByTestBypass).toBe(true);
      expect(proof.codeHash).not.toBe(E2E_BYPASS_CODE);

      const formScreen = await gated.page.content();
      expect(formScreen).not.toContain(E2E_BYPASS_CODE);

      // ── The same steps on the runtime without it ────────────────────────
      await plain.gotoWeb(`/vitrin/${card.id}?step=phone`);
      await plain.page.getByLabel('Telefon *').fill(E2E_BYPASS_PHONE);
      await plain.page.getByRole('button', { name: 'Kod gönder' }).click();
      await expect(plain.page).toHaveURL(/step=code/);

      await plain.page.locator('input[name="code"]').fill(E2E_BYPASS_CODE);
      await plain.page.getByRole('button', { name: 'Doğrula', exact: true }).click();
      await expect(plain.page).toHaveURL(/step=code.*error=PHONE_VERIFICATION_INVALID/);
      await assertNoErrorScreen(plain.page);
      await expect(plain.page.locator('.cdash-notice-error')).toContainText('Doğrulama kodu geçersiz');
      await expect(plain.page.getByTestId('showcase-lead-form')).toHaveCount(0);

      // And the row it refused against is untouched: not consumed, one
      // attempt spent, no test flag.
      const refused = await prisma().phoneVerification.findFirstOrThrow({
        where: { normalizedPhone: E2E_BYPASS_PHONE_E164, consumedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      expect(refused.attemptCount).toBe(1);
      expect(refused.verifiedByTestBypass).toBe(false);
    } finally {
      await Promise.all([gated.close(), plain.close()]);
    }
  });
});
