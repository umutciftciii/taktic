import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCategory, prisma, uniqueLocation, uniqueSuffix } from '../src/fixtures';
import { claimInvitationCount, waitForLatestClaimUrl } from '../src/outbox';
import { primaryRuntime, providerClaimRuntime } from '../src/runtime';

/**
 * Taking ownership of a guest hizmet veren başvurusu.
 *
 * Everything here goes through the real screens: the public application form,
 * the mailed link (read from the test transport, because the API never returns
 * it), the claim screen, and the provider panel the claim is supposed to open.
 * The only shortcuts are fixtures written straight to the database — a category
 * and an admin account — neither of which is what any of these cases is about.
 *
 * The last case runs against the flag-off stack, so "the guest application is
 * unchanged when the feature is off" is demonstrated rather than assumed.
 */

const CLAIM_PASSWORD = 'E2eClaim123!';

type ApplicationValues = {
  email: string;
  businessName: string;
  city: string;
  district: string;
};

function applicationValues(): ApplicationValues {
  const suffix = uniqueSuffix();
  // A real province/district pair: the application form offers the canonical
  // list as dependent selects and the API refuses a pair that does not exist,
  // so an invented district could no longer be submitted here either.
  const location = uniqueLocation();
  return {
    email: `e2e-claim-${suffix}@example.test`,
    businessName: `E2E Başvuru ${suffix}`,
    city: location.city,
    district: location.district,
  };
}

/** Fills and submits the public guest application form. */
async function submitApplication(
  actor: Actor,
  categorySlugId: string,
  values: ApplicationValues,
): Promise<void> {
  await actor.gotoWeb('/providers/register');
  await expect(actor.page.getByRole('heading', { name: 'Hizmet Veren Başvurusu' })).toBeVisible();

  const form = actor.page.locator('form.provider-apply-form');
  await form.locator('input[name="businessName"]').fill(values.businessName);
  await form.locator('input[name="contactName"]').fill('E2E Yetkili');
  await form.locator('input[name="phone"]').fill('05551112233');
  await form.locator('input[name="email"]').fill(values.email);
  // Province and district are dependent selects on both blocks: the district
  // list is empty until a province is chosen, so selecting the district at all
  // proves the cascade populated it.
  await form.locator('select[name="city"]').selectOption(values.city);
  await form.locator('select[name="district"]').selectOption(values.district);
  await form.locator(`input[name="categoryIds"][value="${categorySlugId}"]`).check();
  await form.locator('select[name="serviceAreaCity"]').selectOption(values.city);
  await form.locator('select[name="serviceAreaDistrict"]').selectOption(values.district);

  await form.getByRole('button', { name: 'Başvuruyu Gönder' }).click();
  await expect(actor.page).toHaveURL(/\/providers\/success$/);
  await assertNoErrorScreen(actor.page);
}

test.describe('provider claim', () => {
  test('a guest applicant claims their application and lands in their own panel', async ({
    browser,
  }) => {
    const category = await createCategory(3);
    const values = applicationValues();
    const applicant = await Actor.open(browser, 'applicant', providerClaimRuntime);

    try {
      await submitApplication(applicant, category.id, values);

      // The confirmation names the mailbox, masked, and carries no identifier
      // of any kind in its URL.
      const notice = applicant.page.getByTestId('claim-mail-notice');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('@example.test');
      await expect(notice).not.toContainText(values.email);
      expect(new URL(applicant.page.url()).search).toBe('');

      const claimUrl = await waitForLatestClaimUrl(values.email);

      // Opened as the applicant's browser would open it: the token is in the
      // link, and nowhere else afterwards.
      await applicant.page.goto(claimUrl, { waitUntil: 'domcontentloaded' });
      await expect(
        applicant.page.getByRole('heading', { name: 'Başvurunuzu hesabınıza bağlayın' }),
      ).toBeVisible();
      await expect(applicant.page.getByText(values.businessName)).toBeVisible();
      await expect(applicant.page.locator('body')).not.toContainText(values.email);

      await applicant.page.locator('input[name="password"]').fill(CLAIM_PASSWORD);
      await applicant.page.locator('input[name="passwordConfirm"]').fill(CLAIM_PASSWORD);
      await applicant.page
        .getByRole('button', { name: 'Hesabı oluştur ve başvuruyu bağla' })
        .click();

      // The claim signs them in and drops them on the panel it just gave them.
      await expect(applicant.page).toHaveURL(/\/providers\/me$/);
      await assertNoErrorScreen(applicant.page);
      await expect(
        applicant.page.getByRole('heading', { name: values.businessName }),
      ).toBeVisible();

      const stored = await prisma().providerProfile.findFirstOrThrow({
        where: { businessName: values.businessName },
        select: { userId: true, claimedAt: true, email: true, status: true },
      });
      expect(stored.userId).not.toBeNull();
      expect(stored.claimedAt).not.toBeNull();
      // The claim moved ownership and nothing else: the application is still
      // waiting for moderation, and its own details are untouched.
      expect(stored.status).toBe('PENDING_REVIEW');
      expect(stored.email).toBe(values.email);

      const account = await prisma().user.findUniqueOrThrow({
        where: { email: values.email },
        select: { role: true },
      });
      expect(account.role).toBe('PROVIDER');
    } finally {
      await applicant.close();
    }
  });

  test('a spent link is refused, neutrally and without showing anything', async ({ browser }) => {
    const category = await createCategory(3);
    const values = applicationValues();
    const applicant = await Actor.open(browser, 'applicant', providerClaimRuntime);
    const attacker = await Actor.open(browser, 'attacker', providerClaimRuntime);

    try {
      await submitApplication(applicant, category.id, values);
      const claimUrl = await waitForLatestClaimUrl(values.email);

      await applicant.page.goto(claimUrl, { waitUntil: 'domcontentloaded' });
      await applicant.page.locator('input[name="password"]').fill(CLAIM_PASSWORD);
      await applicant.page.locator('input[name="passwordConfirm"]').fill(CLAIM_PASSWORD);
      await applicant.page
        .getByRole('button', { name: 'Hesabı oluştur ve başvuruyu bağla' })
        .click();
      await expect(applicant.page).toHaveURL(/\/providers\/me$/);

      // Somebody else with the same URL — a forwarded mail, a shared machine.
      await attacker.page.goto(claimUrl, { waitUntil: 'domcontentloaded' });
      await assertNoErrorScreen(attacker.page);
      await expect(
        attacker.page.getByRole('heading', { name: 'Bağlantı kullanılamıyor' }),
      ).toBeVisible();

      // Nothing about the application or the applicant is on the refusal page.
      const body = attacker.page.locator('body');
      await expect(body).not.toContainText(values.email);
      await expect(body).not.toContainText(values.businessName);
      await expect(attacker.page.getByRole('button', { name: /Hesabı oluştur/ })).toHaveCount(0);

      // And the first owner is still the owner.
      const stored = await prisma().providerProfile.findFirstOrThrow({
        where: { businessName: values.businessName },
        select: { userId: true },
      });
      expect(stored.userId).not.toBeNull();
    } finally {
      await Promise.all([applicant.close(), attacker.close()]);
    }
  });

  test('an expired link is refused with the same neutral answer', async ({ browser }) => {
    const category = await createCategory(3);
    const values = applicationValues();
    const applicant = await Actor.open(browser, 'applicant', providerClaimRuntime);

    try {
      await submitApplication(applicant, category.id, values);
      const claimUrl = await waitForLatestClaimUrl(values.email);

      const application = await prisma().providerProfile.findFirstOrThrow({
        where: { businessName: values.businessName },
        select: { id: true },
      });
      await prisma().providerClaimToken.updateMany({
        where: { providerId: application.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await applicant.page.goto(claimUrl, { waitUntil: 'domcontentloaded' });
      await expect(
        applicant.page.getByRole('heading', { name: 'Bağlantı kullanılamıyor' }),
      ).toBeVisible();
      await expect(applicant.page.locator('body')).not.toContainText(values.email);

      const unchanged = await prisma().providerProfile.findUniqueOrThrow({
        where: { id: application.id },
        select: { userId: true },
      });
      expect(unchanged.userId).toBeNull();
    } finally {
      await applicant.close();
    }
  });

  test('a customer’s address cannot be claimed, and their role does not move', async ({
    browser,
  }) => {
    const category = await createCategory(3);
    const values = applicationValues();
    const applicant = await Actor.open(browser, 'applicant', providerClaimRuntime);

    try {
      // The address already belongs to a customer account. There is exactly one
      // role per account and User.email is globally unique, so this is the case
      // that must never quietly turn a customer into a provider.
      const customer = await prisma().user.create({
        data: {
          email: values.email,
          name: 'E2E Müşteri',
          role: 'CUSTOMER',
          isActive: true,
        },
        select: { id: true },
      });

      await submitApplication(applicant, category.id, values);
      const claimUrl = await waitForLatestClaimUrl(values.email);

      await applicant.page.goto(claimUrl, { waitUntil: 'domcontentloaded' });
      await assertNoErrorScreen(applicant.page);
      await expect(
        applicant.page.getByRole('heading', { name: 'Bağlantı kullanılamıyor' }),
      ).toBeVisible();
      await expect(applicant.page.getByText('müşteri hesabına ait')).toBeVisible();
      await expect(applicant.page.getByRole('button', { name: /Hesabı oluştur/ })).toHaveCount(0);

      const unchanged = await prisma().user.findUniqueOrThrow({
        where: { id: customer.id },
        select: { role: true, passwordHash: true },
      });
      expect(unchanged.role).toBe('CUSTOMER');
      expect(unchanged.passwordHash).toBeNull();

      const application = await prisma().providerProfile.findFirstOrThrow({
        where: { businessName: values.businessName },
        select: { id: true, userId: true },
      });
      expect(application.userId).toBeNull();

      // The refusal did not spend the link either.
      const token = await prisma().providerClaimToken.findFirstOrThrow({
        where: { providerId: application.id },
        select: { usedAt: true },
      });
      expect(token.usedAt).toBeNull();
    } finally {
      await applicant.close();
    }
  });

  test('an admin re-sends the invitation without ever seeing the link', async ({ browser }) => {
    const category = await createCategory(3);
    const values = applicationValues();
    const admin = await createAdmin();
    const applicant = await Actor.open(browser, 'applicant', providerClaimRuntime);
    const operator = await Actor.open(browser, 'admin', providerClaimRuntime);

    try {
      await submitApplication(applicant, category.id, values);
      await waitForLatestClaimUrl(values.email);
      const beforeResend = claimInvitationCount(values.email);

      const application = await prisma().providerProfile.findFirstOrThrow({
        where: { businessName: values.businessName },
        select: { id: true },
      });

      await operator.loginToAdmin(admin.email, admin.password);
      await operator.gotoAdmin(`/providers/${application.id}`);

      await expect(operator.page.getByRole('heading', { name: 'Sahiplik' })).toBeVisible();
      await expect(operator.page.getByText('Sahipsiz')).toBeVisible();

      await operator.page.getByRole('button', { name: 'Claim daveti gönder' }).click();
      await expect(operator.page).toHaveURL(/claimInvite=/);
      await assertNoErrorScreen(operator.page);
      await expect(operator.page.getByText('Davet gönderildi')).toBeVisible();

      // The screen never renders the token or the URL — only that a link went
      // out. The applicant's address is on the page (it is the application's own
      // contact field, which the admin has always seen), but the claim block
      // adds nothing to it.
      const newUrl = await waitForLatestClaimUrl(values.email);
      expect(claimInvitationCount(values.email)).toBe(beforeResend + 1);
      const token = new URL(newUrl).searchParams.get('token') as string;
      await expect(operator.page.locator('body')).not.toContainText(token);
      await expect(operator.page.locator('body')).not.toContainText('claim-provider');

      // Issuing a new link closed the old one, so only the newest works.
      const live = await prisma().providerClaimToken.count({
        where: { providerId: application.id, usedAt: null },
      });
      expect(live).toBe(1);

      // The ownership filter finds the application while it is still unowned.
      await operator.gotoAdmin('/providers?ownership=unclaimed');
      await expect(operator.page.getByText(values.businessName)).toBeVisible();
    } finally {
      await Promise.all([applicant.close(), operator.close()]);
    }
  });

  test('with the flag off the guest application behaves exactly as before', async ({ browser }) => {
    const category = await createCategory(3);
    const values = applicationValues();
    const applicant = await Actor.open(browser, 'applicant', primaryRuntime);

    try {
      await applicant.gotoWeb('/providers/register');
      const form = applicant.page.locator('form.provider-apply-form');

      // The address is optional on this stack, and the screen says nothing
      // about a link.
      await expect(form.locator('input[name="email"]')).not.toHaveAttribute('required', '');

      await form.locator('input[name="businessName"]').fill(values.businessName);
      await form.locator('input[name="contactName"]').fill('E2E Yetkili');
      await form.locator('input[name="phone"]').fill('05551112233');
      await form.locator('select[name="city"]').selectOption(values.city);
      await form.locator('select[name="district"]').selectOption(values.district);
      await form.locator(`input[name="categoryIds"][value="${category.id}"]`).check();
      await form.locator('select[name="serviceAreaCity"]').selectOption(values.city);
      await form.locator('select[name="serviceAreaDistrict"]').selectOption(values.district);
      await form.getByRole('button', { name: 'Başvuruyu Gönder' }).click();

      await expect(applicant.page).toHaveURL(/\/providers\/success$/);
      await assertNoErrorScreen(applicant.page);
      await expect(applicant.page.getByTestId('claim-mail-notice')).toHaveCount(0);

      const stored = await prisma().providerProfile.findFirstOrThrow({
        where: { businessName: values.businessName },
        select: { id: true, userId: true, email: true },
      });
      expect(stored.userId).toBeNull();
      expect(stored.email).toBeNull();
      expect(
        await prisma().providerClaimToken.count({ where: { providerId: stored.id } }),
      ).toBe(0);

      // And the claim screen refuses to work at all on this stack.
      await applicant.gotoWeb('/claim-provider?token=whatever');
      await expect(
        applicant.page.getByRole('heading', { name: 'Bu özellik şu anda kapalı' }),
      ).toBeVisible();
    } finally {
      await applicant.close();
    }
  });
});
