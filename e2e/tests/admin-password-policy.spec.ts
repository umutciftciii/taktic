import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import policy from '../../packages/shared/staff-password-policy.json';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, generateFixturePassword, prisma, uniqueSuffix } from '../src/fixtures';
import { waitForLatestPasswordResetUrl } from '../src/outbox';
import { primaryRuntime } from '../src/runtime';

/**
 * ADMIN-AUTH-002 — the staff password rule on the panel's two password screens.
 *
 * Driven through the real invite and reset screens: the criteria tick as the
 * operator types, a password the rule refuses is turned back with the shared
 * sentence, the server-side check holds when the browser's own length check is
 * bypassed, and a staff password set before the rule still signs in.
 */

/** Long enough for the input's own minlength, but carrying a guessable word. */
const GUESSABLE = 'Benim-admin-hesabim-mavi-9';
/** Long enough, but only two distinct characters. */
const REPETITIVE = 'ab'.repeat(15);

async function criterionMet(page: Page, key: string) {
  return page.getByTestId(`password-criterion-${key}`).getAttribute('data-met');
}

async function fillPasswords(page: Page, password: string, confirm = password) {
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="passwordConfirm"]').fill(confirm);
}

async function createInvitedAdmin() {
  const suffix = uniqueSuffix();
  const email = `e2e-policy-invite-${suffix}@example.test`;
  const rawToken = randomBytes(32).toString('base64url');
  const user = await prisma().user.create({
    data: { email, name: `E2E Politika ${suffix}`, role: 'ADMIN', isActive: true, passwordHash: null },
    select: { id: true },
  });
  await prisma().adminInviteToken.create({
    data: {
      userId: user.id,
      tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { id: user.id, email, rawToken };
}

test.describe('admin password policy', () => {
  test('the invite screen lists the staff rule and refuses what it refuses', async ({ browser }) => {
    const invited = await createInvitedAdmin();
    const strong = generateFixturePassword();
    const invitee = await Actor.open(browser, 'policy-invitee', primaryRuntime);

    try {
      await invitee.gotoAdmin(`/admin-invite?token=${encodeURIComponent(invited.rawToken)}`);
      await expect(invitee.page.getByRole('heading', { name: 'Şifre belirleyin' })).toBeVisible();
      await expect(invitee.page.getByTestId('password-criterion-length')).toContainText(
        `En az ${policy.minLength}, en fazla ${policy.maxLength} karakter`,
      );
      await expect(invitee.page.locator('input[name="password"]')).toHaveAttribute(
        'minlength',
        String(policy.minLength),
      );
      await expect(invitee.page.locator('input[name="password"]')).toHaveAttribute(
        'maxlength',
        String(policy.maxLength),
      );

      // Live criteria: an eight-character password no longer meets the length.
      await fillPasswords(invitee.page, 'Sekiz-12');
      expect(await criterionMet(invitee.page, 'length')).toBe('false');
      expect(await criterionMet(invitee.page, 'match')).toBe('true');

      await fillPasswords(invitee.page, GUESSABLE);
      expect(await criterionMet(invitee.page, 'length')).toBe('true');
      expect(await criterionMet(invitee.page, 'guessable')).toBe('false');

      // Submitted anyway: turned back with the shared sentence, nothing set.
      await invitee.page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();
      await expect(invitee.page.locator('.error-message')).toHaveText(policy.messages.guessable);
      await assertNoErrorScreen(invitee.page);
      expect(
        (await prisma().user.findUniqueOrThrow({ where: { id: invited.id } })).passwordHash,
      ).toBeNull();

      // Past the browser's own minlength: the panel's server route still refuses.
      const bypass = await invitee.page.request.post(`${primaryRuntime.adminUrl}/admin-invite/submit`, {
        form: { token: invited.rawToken, password: 'Sekiz-12', passwordConfirm: 'Sekiz-12' },
        // The form route accepts a same-origin post only, as a browser sends it.
        headers: { origin: primaryRuntime.adminUrl },
        maxRedirects: 0,
      });
      expect(bypass.status()).toBe(303);
      expect(bypass.headers()['location']).toContain('error=policy');
      expect(bypass.headers()['location']).toContain('rule=minLength');
      expect(
        (await prisma().user.findUniqueOrThrow({ where: { id: invited.id } })).passwordHash,
      ).toBeNull();

      await fillPasswords(invitee.page, strong);
      for (const key of ['length', 'distinct', 'guessable', 'match']) {
        expect(await criterionMet(invitee.page, key), key).toBe('true');
      }
      await invitee.page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();
      await expect(invitee.page.getByRole('heading', { name: 'Şifreniz oluşturuldu' })).toBeVisible();

      await invitee.loginToAdmin(invited.email, strong);
    } finally {
      await invitee.close();
    }
  });

  test('a staff password set before the rule signs in, and its reset meets the rule', async ({
    browser,
  }) => {
    const admin = await createAdmin();
    // Shorter than the rule: what an account created before ADMIN-AUTH-002 may hold.
    const legacy = 'Eski-sifre-9';
    await prisma().user.update({
      where: { id: admin.id },
      data: { passwordHash: await bcrypt.hash(legacy, 4) },
    });
    const strong = generateFixturePassword();
    const operator = await Actor.open(browser, 'policy-legacy-admin', primaryRuntime);

    try {
      await operator.loginToAdmin(admin.email, legacy);

      await operator.gotoAdmin('/sifre-unuttum');
      await operator.page.locator('input[name="email"]').fill(admin.email);
      await operator.page.getByRole('button', { name: 'Sıfırlama Bağlantısı Gönder' }).click();
      await expect(operator.page.getByRole('heading', { name: 'Bağlantı gönderildi' })).toBeVisible();

      const resetUrl = await waitForLatestPasswordResetUrl(admin.email);
      await operator.page.goto(resetUrl, { waitUntil: 'domcontentloaded' });
      await expect(operator.page.getByRole('heading', { name: 'Yeni şifre belirleyin' })).toBeVisible();

      await fillPasswords(operator.page, REPETITIVE);
      expect(await criterionMet(operator.page, 'distinct')).toBe('false');
      await operator.page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();
      await expect(operator.page.locator('.error-message')).toHaveText(policy.messages.distinctCharacters);

      // Turned back before the link was used: the same link takes a good one.
      await fillPasswords(operator.page, strong);
      await operator.page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();
      await expect(operator.page.getByRole('heading', { name: 'Şifreniz güncellendi' })).toBeVisible();
      await assertNoErrorScreen(operator.page);

      await operator.loginToAdmin(admin.email, strong);
    } finally {
      await operator.close();
    }
  });
});
