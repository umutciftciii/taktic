import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createEntitlement,
  createOfferPackage,
  createProvider,
  creditBalance,
  prisma,
  remainingQuota,
  requestFormValues,
  uniqueLocation,
} from '../src/fixtures';
import { approveRequest, createRequest, fillOfferForm, openRequestAsProvider } from '../src/journeys';
import { primaryRuntime } from '../src/runtime';

/**
 * What a period package changes, and what it deliberately does not.
 *
 * Nothing here settles a payment. Periods are seeded the way credit balances
 * have always been seeded, because the subject is what a held package *does* —
 * the settlement path itself is driven end to end, through the signed webhook,
 * by `apps/api/test/offer-package-settlement.spec.ts`.
 */

const CATEGORY_COST = 3;
const STARTING_CREDITS = 25;

/** Sends one offer through the real form, without asserting a credit cost. */
async function sendOffer(
  provider: Actor,
  options: { providerId: string; requestId: string; message: string },
) {
  await openRequestAsProvider(provider, options.providerId, options.requestId);
  await fillOfferForm(provider, '2500', options.message);
  await provider.page.getByRole('button', { name: 'Teklifi Gönder' }).click();
  await expect(provider.page.getByText('Bu talebe daha önce teklif gönderdiniz')).toBeVisible();
  await assertNoErrorScreen(provider.page);
}

test.describe('monthly quota package', () => {
  test('pays for the offer and shows the quota going down, without touching credits', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });

    const pkg = await createOfferPackage({ type: 'MONTHLY_QUOTA', quotaCredits: 20 });
    const entitlement = await createEntitlement({
      providerId: providerAccount.id,
      packageId: pkg.id,
      packageName: pkg.name,
      type: 'MONTHLY_QUOTA',
      quotaCredits: 20,
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const requestId = await createRequest(
        customer,
        category,
        requestFormValues(location, customerAccount.name),
      );
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);

      await provider.loginToWeb(providerAccount.email, providerAccount.password);

      // The package screen states the period rule and the remaining quota
      // before anything is spent.
      await provider.gotoWeb(`/providers/${providerAccount.id}/subscriptions`);
      await expect(provider.page.getByTestId('entitlement-card')).toBeVisible();
      await expect(provider.page.getByText('20/ 20 kredi kaldı')).toBeVisible();
      await expect(provider.page.getByText('30 gün', { exact: false }).first()).toBeVisible();

      await sendOffer(provider, {
        providerId: providerAccount.id,
        requestId,
        message: 'Aylık kota paketi ile gönderilen teklif.',
      });

      // The quota paid, and the credit balance did not move.
      expect(await remainingQuota(entitlement.id)).toBe(20 - CATEGORY_COST);
      expect(await creditBalance(providerAccount.id)).toBe(STARTING_CREDITS);

      await provider.gotoWeb(`/providers/${providerAccount.id}/subscriptions`);
      await expect(provider.page.getByText('17/ 20 kredi kaldı')).toBeVisible();
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });
});

test.describe('category unlimited package', () => {
  test('costs nothing inside its scope and falls back to credits outside it', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const covered = await createCategory(CATEGORY_COST, {
      namePrefix: 'E2E Kapsamda',
      unlimitedPackageEligible: true,
    });
    const uncovered = await createCategory(CATEGORY_COST, { namePrefix: 'E2E Kapsam Disi' });

    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const providerAccount = await createProvider({
      categoryId: covered.id,
      location,
      credits: STARTING_CREDITS,
    });
    // The same provider also serves the category the package does not cover.
    await prisma().providerServiceCategory.create({
      data: { providerId: providerAccount.id, categoryId: uncovered.id },
    });

    const pkg = await createOfferPackage({
      type: 'CATEGORY_UNLIMITED',
      dailyOfferLimit: 5,
      scopeCategoryIds: [covered.id],
    });
    await createEntitlement({
      providerId: providerAccount.id,
      packageId: pkg.id,
      packageName: pkg.name,
      type: 'CATEGORY_UNLIMITED',
      dailyOfferLimit: 5,
      scopeCategoryIds: [covered.id],
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      const coveredRequest = await createRequest(
        customer,
        covered,
        requestFormValues(location, customerAccount.name),
      );
      const uncoveredRequest = await createRequest(
        customer,
        uncovered,
        requestFormValues(location, customerAccount.name),
      );

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, coveredRequest);
      await approveRequest(admin, uncoveredRequest);

      await provider.loginToWeb(providerAccount.email, providerAccount.password);

      // The screen says what the package covers and what its daily cap is.
      await provider.gotoWeb(`/providers/${providerAccount.id}/subscriptions`);
      const card = provider.page.getByTestId('entitlement-card');
      await expect(card.getByText('Yalnız seçili kategorilerde geçerli')).toBeVisible();
      await expect(card.getByText(covered.name, { exact: false })).toBeVisible();
      await expect(card.getByText('Günlük teklif sınırı: 5', { exact: false })).toBeVisible();

      await sendOffer(provider, {
        providerId: providerAccount.id,
        requestId: coveredRequest,
        message: 'Kapsam içindeki kategoride limitsiz teklif.',
      });
      expect(await creditBalance(providerAccount.id)).toBe(STARTING_CREDITS);

      await sendOffer(provider, {
        providerId: providerAccount.id,
        requestId: uncoveredRequest,
        message: 'Kapsam dışındaki kategoride krediyle teklif.',
      });
      expect(await creditBalance(providerAccount.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });
});

test.describe('automatic renewal', () => {
  test('says plainly that it is unavailable and still offers manual renewal', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: 0,
    });
    const pkg = await createOfferPackage({ type: 'MONTHLY_QUOTA', quotaCredits: 20 });
    await createEntitlement({
      providerId: providerAccount.id,
      packageId: pkg.id,
      packageName: pkg.name,
      type: 'MONTHLY_QUOTA',
      quotaCredits: 20,
    });

    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb(`/providers/${providerAccount.id}/subscriptions`);

      // Not a disabled switch and not a "coming soon" — a stated fact plus a
      // path that actually works.
      const notice = provider.page.getByTestId('auto-renew-unavailable');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('otomatik yenileme kullanılamıyor');
      await expect(provider.page.getByTestId('manual-renewal-note')).toBeVisible();
      await expect(provider.page.getByRole('link', { name: 'Elle yenile' })).toBeVisible();
      // Scoped to the packages area: the panel shell carries its own unrelated
      // "yakında" labels on the disabled search and notification controls.
      await expect(
        provider.page.getByRole('region', { name: 'Aktif paketler' }).getByText('yakında'),
      ).toHaveCount(0);
    } finally {
      await provider.close();
    }
  });

  test('cancelling an enabled renewal keeps the period running to its end', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: 0,
    });
    const pkg = await createOfferPackage({ type: 'MONTHLY_QUOTA', quotaCredits: 20 });
    const entitlement = await createEntitlement({
      providerId: providerAccount.id,
      packageId: pkg.id,
      packageName: pkg.name,
      type: 'MONTHLY_QUOTA',
      quotaCredits: 20,
      autoRenewEnabled: true,
    });

    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb(`/providers/${providerAccount.id}/subscriptions`);

      await expect(provider.page.getByTestId('auto-renew-state')).toContainText('Açık');
      await provider.page.getByRole('button', { name: 'Yenilemeyi iptal et' }).click();
      await expect(provider.page.getByTestId('auto-renew-notice')).toContainText(
        'Mevcut dönem bitiş tarihine kadar',
      );
      await assertNoErrorScreen(provider.page);

      const after = await prisma().providerPackageEntitlement.findUniqueOrThrow({
        where: { id: entitlement.id },
        select: { autoRenewEnabled: true, status: true, endAt: true },
      });
      expect(after.autoRenewEnabled).toBe(false);
      expect(after.status).toBe('ACTIVE');
      expect(after.endAt.toISOString()).toBe(entitlement.endAt.toISOString());
    } finally {
      await provider.close();
    }
  });
});

test.describe('what other people may see', () => {
  test('a customer and an anonymous visitor see no package data at all', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST, { unlimitedPackageEligible: true });
    const customerAccount = await createCustomer();
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: STARTING_CREDITS,
    });
    const pkg = await createOfferPackage({
      type: 'CATEGORY_UNLIMITED',
      name: 'Gizli Limitsiz Paket',
      scopeCategoryIds: [category.id],
    });
    await createEntitlement({
      providerId: providerAccount.id,
      packageId: pkg.id,
      packageName: pkg.name,
      type: 'CATEGORY_UNLIMITED',
      scopeCategoryIds: [category.id],
    });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoWeb(`/providers/${providerAccount.id}/subscriptions`);
      await expect(customer.page.getByTestId('entitlement-card')).toHaveCount(0);
      await expect(customer.page.locator('body')).not.toContainText(pkg.name);

      await visitor.gotoWeb(`/hizmetler/${category.slug}`);
      await expect(visitor.page.locator('body')).not.toContainText(pkg.name);
      await expect(visitor.page.locator('body')).not.toContainText('kredi kota');
    } finally {
      await Promise.all([customer.close(), visitor.close()]);
    }
  });

  test('an admin sees the package catalogue and the provider’s live period', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST, { unlimitedPackageEligible: true });
    const adminAccount = await createAdmin();
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: 0,
    });
    const pkg = await createOfferPackage({
      type: 'MONTHLY_QUOTA',
      name: 'Yönetici Kota Paketi',
      quotaCredits: 30,
    });
    await createEntitlement({
      providerId: providerAccount.id,
      packageId: pkg.id,
      packageName: pkg.name,
      type: 'MONTHLY_QUOTA',
      quotaCredits: 30,
      remainingQuota: 24,
    });

    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);

      await admin.gotoAdmin('/credit-packages');
      await expect(admin.page.getByText(pkg.name)).toBeVisible();
      await expect(admin.page.getByText('Aylık kota').first()).toBeVisible();

      await admin.gotoAdmin(`/providers/${providerAccount.id}/credits`);
      await expect(admin.page.getByRole('heading', { name: 'Dönemsel paketler' })).toBeVisible();
      await expect(admin.page.getByText('24 / 30 kredi')).toBeVisible();
      await expect(admin.page.getByText('kayıtlı ödeme yöntemi: yok')).toBeVisible();
      await assertNoErrorScreen(admin.page);
    } finally {
      await admin.close();
    }
  });
});
