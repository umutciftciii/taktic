import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createStaffAdmin, generateFixturePassword, prisma, uniqueSuffix } from '../src/fixtures';
import { emailCountFor, waitForLatestPasswordResetUrl } from '../src/outbox';
import { primaryRuntime } from '../src/runtime';

/**
 * ADMIN-AUTH-001 — "Şifremi Unuttum" on the admin panel.
 *
 * Driven through the real sign-in card, the real link out of the recording
 * transport and the real panel screen it lands on: the property under test is
 * that an operator who forgot a password gets back into the panel — not into
 * the marketplace, which does not serve staff — and that every session the old
 * password opened is closed on the way.
 */

test.describe('admin password reset', () => {
  test('a super admin resets from the sign-in card, and the old session dies with it', async ({
    browser,
  }) => {
    const admin = await createAdmin();
    const newPassword = generateFixturePassword();
    const working = await Actor.open(browser, 'signed-in-admin', primaryRuntime);
    const forgetful = await Actor.open(browser, 'forgetful-admin', primaryRuntime);

    try {
      // The session the reset must close, open on another device.
      await working.loginToAdmin(admin.email, admin.password);
      expect(
        (await prisma().user.findUniqueOrThrow({ where: { id: admin.id } })).emailVerifiedAt,
      ).toBeNull();

      await forgetful.gotoAdmin('/login');
      await forgetful.page.getByRole('link', { name: 'Şifremi Unuttum' }).click();
      await expect(forgetful.page).toHaveURL(/\/sifre-unuttum$/);
      await expect(
        forgetful.page.getByRole('heading', { name: 'Şifrenizi mi unuttunuz?' }),
      ).toBeVisible();

      await forgetful.page.locator('input[name="email"]').fill(admin.email);
      await forgetful.page.getByRole('button', { name: 'Sıfırlama Bağlantısı Gönder' }).click();
      await expect(forgetful.page.getByRole('heading', { name: 'Bağlantı gönderildi' })).toBeVisible();
      await assertNoErrorScreen(forgetful.page);
      // The address is not carried in the URL of the confirmation.
      expect(forgetful.page.url()).not.toContain(encodeURIComponent(admin.email));
      expect(forgetful.page.url()).not.toContain(admin.email);

      // The link lands on the panel, not on the marketplace.
      const resetUrl = await waitForLatestPasswordResetUrl(admin.email);
      expect(resetUrl.startsWith(`${primaryRuntime.adminUrl}/sifre-sifirla?token=`)).toBe(true);

      await forgetful.page.goto(resetUrl, { waitUntil: 'domcontentloaded' });
      await expect(forgetful.page.getByRole('heading', { name: 'Yeni şifre belirleyin' })).toBeVisible();
      await expect(forgetful.page.getByText(`E-posta: ${admin.email}`)).toBeVisible();
      // Outside the shell: no menu, no session probe on a page reached signed out.
      await expect(forgetful.page.locator('.admin-shell')).toHaveCount(0);

      // The client-side mismatch check is advisory; the server one decides.
      await forgetful.page.locator('input[name="password"]').fill(newPassword);
      await forgetful.page.locator('input[name="passwordConfirm"]').fill(`${newPassword}x`);
      await forgetful.page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();
      await expect(forgetful.page.locator('.error-message')).toHaveText('Şifreler eşleşmiyor.');

      await forgetful.page.locator('input[name="password"]').fill(newPassword);
      await forgetful.page.locator('input[name="passwordConfirm"]').fill(newPassword);
      await forgetful.page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();
      await expect(forgetful.page.getByRole('heading', { name: 'Şifreniz güncellendi' })).toBeVisible();
      await assertNoErrorScreen(forgetful.page);

      // The completed link is the mailbox proof (STG-003), and the role is untouched.
      const stored = await prisma().user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(stored.emailVerifiedAt).not.toBeNull();
      expect(stored.role).toBe('SUPER_ADMIN');
      expect(await prisma().session.count({ where: { userId: admin.id, revokedAt: null } })).toBe(0);

      // The other device's session is gone: the panel sends it to sign in.
      await working.gotoAdmin('/');
      await expect(working.page).toHaveURL(/\/login/);

      // The old password no longer works; the new one does.
      await forgetful.gotoAdmin('/login');
      await forgetful.page.locator('input[name="email"]').fill(admin.email);
      await forgetful.page.locator('input[name="password"]').fill(admin.password);
      await forgetful.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(forgetful.page).toHaveURL(/\/login\?error=1/);
      await forgetful.loginToAdmin(admin.email, newPassword);

      // And the link cannot be replayed.
      await forgetful.page.goto(resetUrl, { waitUntil: 'domcontentloaded' });
      await expect(forgetful.page.getByRole('heading', { name: 'Bağlantı geçersiz' })).toBeVisible();
      await expect(forgetful.page.getByRole('link', { name: 'Yeni Bağlantı İste' })).toHaveAttribute(
        'href',
        '/sifre-unuttum',
      );
    } finally {
      await working.close();
      await forgetful.close();
    }
  });

  test('the request screen says the same thing for an address nobody registered', async ({
    browser,
  }) => {
    const visitor = await Actor.open(browser, 'panel-stranger', primaryRuntime);
    const unknown = `panel-bilinmeyen-${uniqueSuffix()}@example.test`;

    try {
      await visitor.gotoAdmin('/sifre-unuttum');
      await visitor.page.locator('input[name="email"]').fill(unknown);
      await visitor.page.getByRole('button', { name: 'Sıfırlama Bağlantısı Gönder' }).click();

      await expect(visitor.page.getByRole('heading', { name: 'Bağlantı gönderildi' })).toBeVisible();
      await assertNoErrorScreen(visitor.page);
      expect(emailCountFor(unknown, 'password-reset')).toBe(0);
    } finally {
      await visitor.close();
    }
  });

  test('a staff account is sent to the panel whichever form asked', async ({ browser }) => {
    const staff = await createStaffAdmin(['REQUESTS_READ']);
    const visitor = await Actor.open(browser, 'staff-on-web-form', primaryRuntime);

    try {
      // The marketplace's own form: the link still goes to the panel, because
      // the account decides, not the form.
      await visitor.gotoWeb('/sifre-unuttum');
      await visitor.page.locator('input[name="email"]').fill(staff.email);
      await visitor.page.getByRole('button', { name: 'Sıfırlama Bağlantısı Gönder' }).click();
      await expect(visitor.page.getByRole('heading', { name: 'Bağlantı gönderildi' })).toBeVisible();

      const resetUrl = await waitForLatestPasswordResetUrl(staff.email);
      expect(resetUrl.startsWith(`${primaryRuntime.adminUrl}/sifre-sifirla?token=`)).toBe(true);
    } finally {
      await visitor.close();
    }
  });
});
