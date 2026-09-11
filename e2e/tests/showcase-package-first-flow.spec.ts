import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCategory, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * Vitrin, package first: the right is bought before the card is written, the
 * card is bound to it on creation, and the operator's first approval puts it
 * on the air with nobody paying anything afterwards.
 *
 * What these journeys prove that the API suite cannot:
 *
 * 1. The only door is the package. A business with no right sees no "create"
 *    control anywhere, and typing the create URL lands on the shop.
 * 2. The consent is asked where the money is. The pay button is inert until a
 *    package is chosen *and* the sentence is ticked, and the screen says which
 *    of the two is missing.
 * 3. Approval publishes. The provider never sees a "pay now" step after the
 *    operator's decision — the card is live on the home page at once.
 * 4. A refusal keeps the right; deleting an unpublished card returns it; a
 *    lapsed run asks for a new package and republishes in one click.
 * 5. Nothing technical leaks: no version numbers, no responsibility text on
 *    the card form, no payment-variant vocabulary when the catalogue is empty.
 */

/** Fills the card content fields. The areas are added separately, one at a time. */
async function fillCardContent(
  page: Page,
  values: { title: string; summary: string; included: string; excluded: string; price: string },
) {
  await page.getByLabel('Başlık *').fill(values.title);
  await page.getByLabel('Özet *').fill(values.summary);
  await page.getByLabel('Dahil olanlar * (her satır bir madde)').fill(values.included);
  await page.getByLabel('Hariç olanlar * (her satır bir madde)').fill(values.excluded);
  await page.getByLabel('Sabit hizmet bedeli (₺) *').fill(values.price);
}

/**
 * Chooses one area in the shared service-area picker and adds it.
 *
 * By test id rather than by label: the picker's three selects are labelled "İl",
 * "İlçe" and "Mahalle", and Playwright's `getByLabel` matches on substring — so
 * "İl" would also match "İlçe".
 */
async function addArea(page: Page, city: string, district: string) {
  await page.getByTestId('service-area-city').selectOption(city);
  await page.getByTestId('service-area-district').selectOption(district);
  await page.getByTestId('service-area-add').click();
}

/**
 * One vitrin package on sale, so the buying step has something to buy.
 *
 * The slug carries the reserved `vitrin-` prefix, which the API and two CHECK
 * constraints insist on.
 */
async function seedShowcasePackage(name = 'E2E Vitrin Paketi') {
  return prisma().showcasePackage.create({
    data: {
      name,
      slug: `vitrin-e2e-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
      priceAmount: 49_900,
      currency: 'TRY',
      durationDays: 30,
    },
  });
}

/** The version and the sentence the API records an acceptance of, restated. */
const PRICE_TERMS_VERSION = 'v1';
const PRICE_TERMS_TEXT =
  'Kartta belirtilen hizmet bedeli ve kapsam hizmet verenin sorumluluğundadır. ' +
  'TakTick bu hizmet bedelini tahsil etmez ve taraflar arasındaki ödemeye müdahil olmaz.';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A bought, unspent right: package, paid package-first purchase, terms
 * acceptance and an AVAILABLE entitlement, written the way a settlement would
 * have written them. `expiresAt` is 90 days out, well after `grantedAt`, as
 * the window CHECK requires.
 */
async function seedEntitlement(providerId: string, packageName = 'E2E Vitrin Paketi') {
  const db = prisma();
  const now = new Date();
  const pkg = await seedShowcasePackage(packageName);
  const owner = await db.providerProfile.findUniqueOrThrow({
    where: { id: providerId },
    select: { userId: true },
  });

  const acceptance = await db.showcasePackageTermsAcceptance.upsert({
    where: { providerId_termsVersion: { providerId, termsVersion: PRICE_TERMS_VERSION } },
    update: {},
    create: {
      providerId,
      termsVersion: PRICE_TERMS_VERSION,
      termsTextSnapshot: PRICE_TERMS_TEXT,
      acceptedByUserId: owner.userId!,
    },
  });

  const purchase = await db.packagePurchase.create({
    data: {
      providerId,
      kind: 'SHOWCASE_PACKAGE',
      showcasePackageId: pkg.id,
      durationDaysSnapshot: pkg.durationDays,
      creditAmountSnapshot: 0,
      priceAmountSnapshot: pkg.priceAmount,
      currencySnapshot: pkg.currency,
      packageNameSnapshot: pkg.name,
      showcasePackageTermsAcceptanceId: acceptance.id,
      status: 'PAID',
      paidAt: now,
      paymentProvider: 'mock',
    },
  });

  const entitlement = await db.showcaseEntitlement.create({
    data: {
      providerId,
      purchaseId: purchase.id,
      showcasePackageId: pkg.id,
      packageNameSnapshot: pkg.name,
      durationDaysSnapshot: pkg.durationDays,
      priceAmountSnapshot: pkg.priceAmount,
      currencySnapshot: pkg.currency,
      priceTermsVersionSnapshot: acceptance.termsVersion,
      priceTermsTextSnapshot: acceptance.termsTextSnapshot,
      status: 'AVAILABLE',
      grantedAt: now,
      expiresAt: new Date(now.getTime() + 90 * DAY_MS),
    },
  });

  return { pkg, purchase, entitlement };
}

/** The same fold the API applies, restated here rather than imported. */
function areaKey(city: string, district: string): string {
  const fold = (value: string) =>
    value.normalize('NFC').trim().toLocaleLowerCase('tr-TR').replace(/ı/g, 'i');
  return `${fold(city)}|${fold(district)}|`;
}

/** An approved card with one approved version, written through Prisma. */
async function seedApprovedCard(options: {
  providerId: string;
  categoryId: string;
  city: string;
  district: string;
  title: string;
}) {
  const db = prisma();
  const now = new Date();

  const card = await db.showcaseCard.create({
    data: {
      providerId: options.providerId,
      kind: 'SERVICE',
      categoryId: options.categoryId,
      status: 'APPROVED',
    },
  });

  const version = await db.showcaseCardVersion.create({
    data: {
      cardId: card.id,
      versionNumber: 1,
      kindSnapshot: 'SERVICE',
      title: options.title,
      summary: 'Standart kapsamda klima bakımı ve filtre temizliği.',
      scopeIncluded: ['Filtre temizliği', 'Gaz basıncı kontrolü'],
      scopeExcluded: ['Gaz dolumu'],
      listedServicePriceAmount: 150_000,
      listedServiceCurrency: 'TRY',
      responseSlaUrgentHours: 3,
      responseSlaNormalHours: 24,
      priceTermsVersion: PRICE_TERMS_VERSION,
      priceTermsAcceptedAt: now,
      reviewStatus: 'APPROVED',
      submittedAt: now,
      publishedAt: now,
      areas: {
        create: [
          {
            scope: 'DISTRICT',
            city: options.city,
            district: options.district,
            neighborhood: null,
            areaKey: areaKey(options.city, options.district),
          },
        ],
      },
    },
  });

  await db.showcaseCard.update({
    where: { id: card.id },
    data: { liveVersionId: version.id },
  });

  return { card, version };
}

/**
 * A settled vitrin purchase in the legacy, card-bound shape, and the run it
 * produced. Still a valid row — every placement sold before rights existed
 * looks like this — and exactly what an expired run a provider is asked to
 * republish looks like.
 */
async function seedLivePlacement(options: {
  providerId: string;
  cardId: string;
  versionId: string;
  categoryId: string;
  city: string;
  district: string;
}) {
  const db = prisma();
  const now = new Date();
  const endAt = new Date(now.getTime() + 30 * DAY_MS);

  const pkg = await seedShowcasePackage('E2E Vitrin 30 Gün');

  const owner = await db.providerProfile.findUniqueOrThrow({
    where: { id: options.providerId },
    select: { userId: true },
  });

  const acceptance = await db.showcaseCardPriceTermsAcceptance.create({
    data: {
      providerId: options.providerId,
      cardId: options.cardId,
      acceptedByUserId: owner.userId!,
      termsVersion: PRICE_TERMS_VERSION,
      termsTextSnapshot: PRICE_TERMS_TEXT,
    },
  });

  const purchase = await db.packagePurchase.create({
    data: {
      providerId: options.providerId,
      kind: 'SHOWCASE_PACKAGE',
      showcasePackageId: pkg.id,
      showcaseCardId: options.cardId,
      showcaseCardVersionId: options.versionId,
      durationDaysSnapshot: 30,
      creditAmountSnapshot: 0,
      priceAmountSnapshot: pkg.priceAmount,
      currencySnapshot: 'TRY',
      packageNameSnapshot: pkg.name,
      showcasePriceTermsAcceptanceId: acceptance.id,
      status: 'PAID',
      paidAt: now,
      paymentProvider: 'mock',
    },
  });

  const placement = await db.showcasePlacement.create({
    data: {
      purchaseId: purchase.id,
      providerId: options.providerId,
      showcasePackageId: pkg.id,
      cardId: options.cardId,
      pinnedVersionId: options.versionId,
      categoryId: options.categoryId,
      kindSnapshot: 'SERVICE',
      packageNameSnapshot: pkg.name,
      priceAmountSnapshot: pkg.priceAmount,
      currencySnapshot: 'TRY',
      durationDaysSnapshot: 30,
      priceTermsVersionSnapshot: acceptance.termsVersion,
      priceTermsTextSnapshot: acceptance.termsTextSnapshot,
      startAt: now,
      endAt,
      status: 'ACTIVE',
      shelves: {
        create: [
          {
            providerId: options.providerId,
            categoryId: options.categoryId,
            areaKey: areaKey(options.city, options.district),
            scope: 'DISTRICT',
            city: options.city,
            district: options.district,
            neighborhood: null,
            active: true,
            endAt,
          },
        ],
      },
    },
  });

  return { pkg, purchase, placement };
}

/** Ends a run the way the expiry sweep does: status EXPIRED, shelves off. */
async function expirePlacement(placementId: string) {
  const db = prisma();
  await db.showcasePlacement.update({
    where: { id: placementId },
    data: { status: 'EXPIRED', suspendedAt: null, suspendReason: null },
  });
  await db.showcasePlacementShelf.updateMany({
    where: { placementId, active: true },
    data: { active: false },
  });
}

/**
 * Pays the mock checkout with the card number that settles.
 *
 * The month and year are pre-filled by the form; the three fields a person
 * has to type are the three typed here.
 */
async function payWithMockCard(page: Page) {
  await expect(page).toHaveURL(/package-purchases\/.+\/checkout/);
  await page.getByLabel('Kart Üzerindeki İsim').fill('E2E Sağlayıcı');
  await page.getByLabel('Kart Numarası').fill('4111111111111111');
  await page.getByLabel('CVV').fill('123');
  await page.getByRole('button', { name: 'Mock Ödemeyi Tamamla' }).click();
  await assertNoErrorScreen(page);
}

/** Opens the ⋯ menu on the card screen and confirms its dangerous action. */
async function confirmDangerousAction(page: Page, label: string) {
  await page.getByLabel('Diğer işlemler').click();
  const danger = page.getByTestId('showcase-card-danger');
  await expect(danger).toHaveText(label);
  await danger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('vitrin: paket-önce akış', () => {
  test('paketsiz sağlayıcı kart açamaz; paket alır, kart oluşturur, onay sonrası otomatik yayına girer', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin Paket' });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const adminAccount = await createAdmin();
    const pkg = await seedShowcasePackage('E2E Paket Önce Paketi');
    const provider = await Actor.open(browser, 'web', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await provider.loginToWeb(owner.email, owner.password);
      await provider.gotoWeb(`/providers/${owner.id}/vitrin`);
      await assertNoErrorScreen(provider.page);

      // ── 1. No package: the only door is the package ────────────────────────
      await expect(provider.page.getByRole('heading', { name: 'Vitrinde yer alın' })).toBeVisible();
      await expect(provider.page.getByRole('link', { name: 'Yeni vitrin kartı' })).toHaveCount(0);
      await expect(provider.page.getByTestId('showcase-create-card')).toHaveCount(0);
      await expect(provider.page.getByTestId('showcase-empty')).toBeVisible();
      await expect(provider.page.getByTestId('showcase-entitlement-counter')).toContainText(
        'Kullanılabilir vitrin hakkınız yok',
      );
      await provider.gotoWeb(`/providers/${owner.id}/vitrin/yeni`);
      await expect(provider.page).toHaveURL(/\/vitrin\/paketler/);

      // ── 2. Pick a package, accept, pay ─────────────────────────────────────
      await provider.gotoWeb(`/providers/${owner.id}/vitrin`);
      await provider.page.getByTestId('showcase-buy-package').click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page).toHaveURL(/\/vitrin\/paketler/);

      const pay = provider.page.getByTestId('showcase-pay');
      const option = provider.page.getByTestId('showcase-package-option').filter({ hasText: pkg.name });
      await expect(option).toBeVisible();
      await expect(option).toContainText('30 gün');
      await expect(option).toContainText('₺499,00');

      /*
       * The single package on offer starts chosen, so the button's only reason
       * to stay inert is the consent — and the screen says so. When more than
       * one package is on sale (another spec's catalogue row in the shared
       * database) nothing is chosen yet, and the screen says *that* instead.
       */
      await expect(pay).toBeDisabled();
      const optionCount = await provider.page.getByTestId('showcase-package-option').count();
      if (optionCount > 1) {
        await expect(provider.page.getByTestId('showcase-pay-reason')).toHaveText(
          'Devam etmek için bir paket seçin.',
        );
      }
      await option.click();
      await expect(pay).toBeDisabled();
      await expect(provider.page.getByTestId('showcase-pay-reason')).toHaveText(
        'Devam etmek için sorumluluk metnini kabul edin.',
      );
      await provider.page.getByTestId('showcase-package-consent').click();
      await expect(pay).toBeEnabled();
      await expect(provider.page.getByTestId('showcase-pay-reason')).toHaveCount(0);
      await pay.click();
      await assertNoErrorScreen(provider.page);

      await payWithMockCard(provider.page);

      // ── 3. The return screen ───────────────────────────────────────────────
      await expect(provider.page).toHaveURL(/\/vitrin\/odeme\//);
      await expect(provider.page.getByTestId('showcase-payment-paid')).toBeVisible();
      await expect(provider.page.getByRole('heading', { name: 'Vitrin hakkınız hazır' })).toBeVisible();
      expect(
        await prisma().showcaseEntitlement.count({ where: { providerId: owner.id, status: 'AVAILABLE' } }),
      ).toBe(1);
      // The purchase is package-first: the acceptance is on it, no card is.
      const purchase = await prisma().packagePurchase.findFirstOrThrow({
        where: { providerId: owner.id, kind: 'SHOWCASE_PACKAGE' },
      });
      expect(purchase.status).toBe('PAID');
      expect(purchase.showcasePackageTermsAcceptanceId).not.toBeNull();
      expect(purchase.showcaseCardId).toBeNull();

      await provider.page.getByTestId('showcase-create-after-payment').click();
      await assertNoErrorScreen(provider.page);

      // ── 4. Create the card (no terms checkbox anywhere on this form) ───────
      await expect(provider.page.getByRole('heading', { name: 'Vitrin kartını oluştur' })).toBeVisible();
      await expect(provider.page.getByTestId('showcase-entitlement-in-use')).toContainText(pkg.name);
      await expect(provider.page.getByRole('checkbox')).toHaveCount(0);
      await expect(
        provider.page.getByText('TakTick bu hizmet bedelini tahsil etmez', { exact: false }),
      ).toHaveCount(0);
      await provider.page.getByLabel('Kategori *').selectOption({ label: category.name });
      await fillCardContent(provider.page, {
        title: 'E2E Paketli Klima',
        summary: 'Standart kapsamda klima bakımı ve filtre temizliği.',
        included: 'Filtre temizliği\nGaz basıncı kontrolü',
        excluded: 'Gaz dolumu',
        price: '1500',
      });
      await addArea(provider.page, location.city, location.district);
      await provider.page.getByRole('button', { name: 'Kartı oluştur' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınızı incelemeye gönderin' })).toBeVisible();
      await expect(provider.page).not.toHaveURL(/\/vitrin\/yeni/);

      // The right is on the card now.
      expect(
        await prisma().showcaseEntitlement.count({ where: { providerId: owner.id, status: 'RESERVED' } }),
      ).toBe(1);

      // ── 5. Card screen: summary + one status panel + one CTA ───────────────
      await expect(provider.page.getByTestId('showcase-card-face')).toContainText(
        `${location.district}, ${location.city}`,
      );
      await expect(provider.page.getByTestId('showcase-card-face')).toContainText('₺1.500,00');
      await expect(provider.page.getByText('sürüm', { exact: false })).toHaveCount(0);
      await expect(
        provider.page.getByText('TakTick bu hizmet bedelini tahsil etmez', { exact: false }),
      ).toHaveCount(0);
      await expect(provider.page.getByTestId('showcase-stage-action')).toHaveCount(1);
      await provider.page.getByRole('button', { name: 'İncelemeye gönder' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınız inceleniyor' })).toBeVisible();
      await expect(
        provider.page.getByText('Kartınız incelemeye gönderildi. Onaylanınca otomatik yayına girer.'),
      ).toBeVisible();
      // The edit link is gone while an operator has it; the way back is the withdrawal.
      await expect(provider.page.getByTestId('showcase-edit-link')).toHaveCount(0);
      await expect(provider.page.getByRole('button', { name: 'İncelemeyi geri çek' })).toBeVisible();
      expect(
        (await prisma().showcaseEntitlement.findFirstOrThrow({ where: { providerId: owner.id } }))
          .reviewPausedAt,
      ).not.toBeNull();

      // ── 6. Admin sees the right and approves; the card is live at once ─────
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/showcase/reviews');
      await assertNoErrorScreen(admin.page);
      await admin.page.getByRole('link', { name: 'E2E Paketli Klima' }).click();
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByTestId('review-entitlement')).toContainText(pkg.name);
      await expect(admin.page.getByTestId('review-entitlement-missing')).toHaveCount(0);
      await admin.page.getByRole('button', { name: 'Onayla' }).click();
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByText('vitrinde yayına girdi', { exact: false })).toBeVisible();

      const card = await prisma().showcaseCard.findFirstOrThrow({ where: { providerId: owner.id } });
      expect(await prisma().showcasePlacement.count({ where: { cardId: card.id, status: 'ACTIVE' } })).toBe(1);
      expect(
        await prisma().showcaseEntitlement.count({ where: { providerId: owner.id, status: 'CONSUMED' } }),
      ).toBe(1);
      expect(
        await prisma().showcaseEntitlementReviewPause.count({
          where: { entitlement: { providerId: owner.id }, endReason: 'CONSUMED' },
        }),
      ).toBe(1);

      // ── 7. Provider sees "Yayında"; a visitor with no location sees the card ─
      await provider.gotoWeb(`/providers/${owner.id}/vitrin`);
      await assertNoErrorScreen(provider.page);
      const hubCard = provider.page.getByTestId('showcase-card').first();
      await expect(hubCard).toHaveAttribute('data-state', 'LIVE');
      await expect(hubCard).toContainText('Yayında');
      await expect(hubCard.getByTestId('showcase-stage-action')).toHaveText('Yayını görüntüle');
      await expect(provider.page.getByTestId('showcase-entitlement-counter')).toContainText(
        'Kullanılabilir vitrin hakkınız yok',
      );
      await expect(provider.page.getByTestId('pdash-nav-showcase-leads')).toBeVisible();

      await provider.gotoWeb(`/providers/${owner.id}/vitrin/${card.id}`);
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınız yayında' })).toBeVisible();
      await expect(provider.page.getByText('Yayın bitişi', { exact: false })).toContainText(pkg.name);

      const visitor = await Actor.open(browser, 'web', primaryRuntime);
      try {
        await visitor.gotoWeb('/');
        await assertNoErrorScreen(visitor.page);
        await expect(visitor.page.getByTestId('showcase-shelf').getByText('E2E Paketli Klima')).toBeVisible();
      } finally {
        await visitor.close();
      }
    } finally {
      await provider.close();
      await admin.close();
    }
  });

  test('red → düzenle → yeniden gönder → onay: hak bir kez tüketilir', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin Red' });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const adminAccount = await createAdmin();
    const { pkg, entitlement } = await seedEntitlement(owner.id, 'E2E Red Paketi');
    const provider = await Actor.open(browser, 'web', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      // ── The card, written against the bought right and sent in ────────────
      await provider.loginToWeb(owner.email, owner.password);
      await provider.gotoWeb(`/providers/${owner.id}/vitrin`);
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('showcase-entitlement-counter')).toContainText(
        '1 kullanılabilir vitrin hakkınız var',
      );
      await provider.page.getByTestId('showcase-create-card').click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('showcase-entitlement-in-use')).toContainText(pkg.name);

      await provider.page.getByLabel('Kategori *').selectOption({ label: category.name });
      await fillCardContent(provider.page, {
        title: 'E2E Reddedilecek Kart',
        summary: 'İlk hâli reddedilip düzeltilecek bir kart.',
        included: 'Yerinde inceleme',
        excluded: 'Malzeme bedeli',
        price: '750',
      });
      await addArea(provider.page, location.city, location.district);
      await provider.page.getByRole('button', { name: 'Kartı oluştur' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınızı incelemeye gönderin' })).toBeVisible();
      await provider.page.getByRole('button', { name: 'İncelemeye gönder' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınız inceleniyor' })).toBeVisible();

      const card = await prisma().showcaseCard.findFirstOrThrow({ where: { providerId: owner.id } });

      // ── The operator refuses it, with a reason ─────────────────────────────
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/showcase/reviews');
      await admin.page.getByRole('link', { name: 'E2E Reddedilecek Kart' }).click();
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByTestId('review-entitlement')).toContainText(pkg.name);
      await admin.page.getByLabel('Ret gerekçesi *').fill('Başlık çok genel, hizmeti adlandırın.');
      await admin.page.getByRole('button', { name: 'Reddet' }).click();
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByText('Sürüm reddedildi', { exact: false })).toBeVisible();

      // The right survives the refusal: still on the card, clock running again.
      let right = await prisma().showcaseEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } });
      expect(right.status).toBe('RESERVED');
      expect(right.cardId).toBe(card.id);
      expect(right.reviewPausedAt).toBeNull();
      expect(
        await prisma().showcaseEntitlementReviewPause.count({
          where: { entitlementId: entitlement.id, endReason: 'REJECTED' },
        }),
      ).toBe(1);

      // ── The provider reads the verdict and is offered exactly one way on ───
      await provider.gotoWeb(`/providers/${owner.id}/vitrin`);
      await assertNoErrorScreen(provider.page);
      const hubCard = provider.page.getByTestId('showcase-card').first();
      await expect(hubCard).toHaveAttribute('data-state', 'REJECTED');
      await expect(hubCard).toContainText('Reddedildi');
      // What was refused is still the card the provider sees, not a blank.
      await expect(hubCard).toContainText('E2E Reddedilecek Kart');
      const fix = hubCard.getByTestId('showcase-stage-action');
      await expect(fix).toHaveText('Düzenle ve yeniden gönder');
      await fix.click();
      await assertNoErrorScreen(provider.page);

      await expect(provider.page).toHaveURL(new RegExp(`/vitrin/${card.id}/duzenle`));
      await expect(provider.page.getByRole('heading', { name: 'Kartı düzenle' })).toBeVisible();
      // The refused text is what the form opens on — a provider fixing a title
      // must not have to retype the scope.
      await expect(provider.page.getByLabel('Başlık *')).toHaveValue('E2E Reddedilecek Kart');
      await expect(provider.page.getByLabel('Özet *')).toHaveValue(
        'İlk hâli reddedilip düzeltilecek bir kart.',
      );
      await provider.page.getByLabel('Başlık *').fill('E2E Klima Bakımı Aynı Gün');
      await provider.page.getByRole('button', { name: 'Kaydet' }).click();
      await assertNoErrorScreen(provider.page);

      await expect(provider.page).toHaveURL(new RegExp(`/vitrin/${card.id}\\?saved=1`));
      await expect(provider.page.getByText('Değişiklikleriniz kaydedildi.')).toBeVisible();
      await expect(provider.page.getByRole('heading', { name: 'Kartınızı incelemeye gönderin' })).toBeVisible();
      await expect(provider.page.getByTestId('showcase-card-face')).toContainText('E2E Klima Bakımı Aynı Gün');
      await provider.page.getByRole('button', { name: 'İncelemeye gönder' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınız inceleniyor' })).toBeVisible();

      // ── Approved on the second try ─────────────────────────────────────────
      await admin.gotoAdmin('/showcase/reviews');
      await expect(admin.page.getByRole('link', { name: 'E2E Reddedilecek Kart' })).toHaveCount(0);
      await admin.page.getByRole('link', { name: 'E2E Klima Bakımı Aynı Gün' }).click();
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByTestId('review-entitlement')).toContainText(pkg.name);
      await admin.page.getByRole('button', { name: 'Onayla' }).click();
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByText('vitrinde yayına girdi', { exact: false })).toBeVisible();

      // One right, spent once, on the second version.
      right = await prisma().showcaseEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } });
      expect(right.status).toBe('CONSUMED');
      expect(right.placementId).not.toBeNull();
      expect(
        await prisma().showcaseEntitlement.count({ where: { providerId: owner.id, status: 'CONSUMED' } }),
      ).toBe(1);
      expect(await prisma().showcaseEntitlement.count({ where: { providerId: owner.id } })).toBe(1);
      expect(
        await prisma().showcaseEntitlementReviewPause.count({
          where: { entitlementId: entitlement.id, endReason: 'REJECTED' },
        }),
      ).toBe(1);
      expect(
        await prisma().showcaseEntitlementReviewPause.count({
          where: { entitlementId: entitlement.id, endReason: 'CONSUMED' },
        }),
      ).toBe(1);
      expect(await prisma().showcaseCardVersion.count({ where: { cardId: card.id } })).toBe(2);

      await provider.gotoWeb(`/providers/${owner.id}/vitrin/${card.id}`);
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınız yayında' })).toBeVisible();
    } finally {
      await provider.close();
      await admin.close();
    }
  });

  test('yayınlanmamış kartı silmek hakkı serbest bırakır', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin Sil' });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const { entitlement } = await seedEntitlement(owner.id, 'E2E Sil Paketi');
    const provider = await Actor.open(browser, 'web', primaryRuntime);

    try {
      await provider.loginToWeb(owner.email, owner.password);
      await provider.gotoWeb(`/providers/${owner.id}/vitrin/yeni`);
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Vitrin kartını oluştur' })).toBeVisible();

      await provider.page.getByLabel('Kategori *').selectOption({ label: category.name });
      await fillCardContent(provider.page, {
        title: 'E2E Silinecek Kart',
        summary: 'Hiç yayına girmeden silinecek bir kart.',
        included: 'Yerinde inceleme',
        excluded: 'Malzeme bedeli',
        price: '600',
      });
      await addArea(provider.page, location.city, location.district);
      await provider.page.getByRole('button', { name: 'Kartı oluştur' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınızı incelemeye gönderin' })).toBeVisible();

      // The right is bound to this card, so the hub has nothing left to spend.
      expect(
        (await prisma().showcaseEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } })).status,
      ).toBe('RESERVED');

      /*
       * The dangerous action is behind a menu and a dialog, and its wording is
       * the product rule: a card that never went live is *deleted* and gives
       * its right back. The dialog says so before anything is pressed.
       */
      const dialog = await confirmDangerousAction(
        provider.page,
        'Kartı sil ve yayın hakkını serbest bırak',
      );
      await expect(dialog).toContainText('vitrin hakkınız yeniden kullanılabilir olur');
      await dialog.getByTestId('showcase-card-danger-confirm').click();
      await assertNoErrorScreen(provider.page);

      // Back on the hub, told what happened, with the right back on the counter.
      await expect(provider.page).toHaveURL(new RegExp(`/providers/${owner.id}/vitrin\\?deleted=1`));
      await expect(
        provider.page.getByText('Kart silindi ve vitrin hakkınız yeniden kullanılabilir.'),
      ).toBeVisible();
      await expect(provider.page.getByTestId('showcase-entitlement-counter')).toContainText(
        '1 kullanılabilir vitrin hakkınız var',
      );
      await expect(provider.page.getByTestId('showcase-create-card')).toBeVisible();
      // The deleted card is not listed as a card: the button said "sil".
      await expect(provider.page.getByTestId('showcase-card')).toHaveCount(0);
      await expect(provider.page.getByTestId('showcase-empty')).toBeVisible();

      const right = await prisma().showcaseEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } });
      expect(right.status).toBe('AVAILABLE');
      expect(right.cardId).toBeNull();
      // The record stays: archived, never live, and the right's ledger says RELEASED.
      const card = await prisma().showcaseCard.findFirstOrThrow({ where: { providerId: owner.id } });
      expect(card.status).toBe('ARCHIVED');
      expect(card.liveVersionId).toBeNull();

      // And a second card can be opened on the same right without buying again.
      await provider.page.getByTestId('showcase-create-card').click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Vitrin kartını oluştur' })).toBeVisible();
    } finally {
      await provider.close();
    }
  });

  test('süresi dolmuş kart yeni paket ister ve tek tıkla yeniden yayınlanır', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin Sure' });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });

    const { card, version } = await seedApprovedCard({
      providerId: owner.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: 'E2E Süresi Dolan Kart',
    });
    const { placement } = await seedLivePlacement({
      providerId: owner.id,
      cardId: card.id,
      versionId: version.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
    });
    await expirePlacement(placement.id);
    const pkg = await seedShowcasePackage('E2E Yeniden Yayın Paketi');

    const provider = await Actor.open(browser, 'web', primaryRuntime);

    try {
      await provider.loginToWeb(owner.email, owner.password);
      await provider.gotoWeb(`/providers/${owner.id}/vitrin`);
      await assertNoErrorScreen(provider.page);

      // ── The hub: lapsed, and one way back on ───────────────────────────────
      const hubCard = provider.page.getByTestId('showcase-card').first();
      await expect(hubCard).toHaveAttribute('data-state', 'EXPIRED');
      await expect(hubCard).toContainText('Süresi doldu');
      await expect(hubCard).toContainText('E2E Süresi Dolan Kart');
      await expect(provider.page.getByText('EXPIRED', { exact: true })).toHaveCount(0);
      const republish = hubCard.getByTestId('showcase-stage-action');
      await expect(republish).toHaveText('Yeniden yayınla');
      await republish.click();
      await assertNoErrorScreen(provider.page);

      // With no right on hand, "republish" means the shop — carrying the card along.
      await expect(provider.page).toHaveURL(new RegExp(`/vitrin/paketler\\?card=${card.id}`));
      await expect(provider.page.getByRole('heading', { name: 'Vitrin paketi al' })).toBeVisible();

      // ── Buy ────────────────────────────────────────────────────────────────
      const pay = provider.page.getByTestId('showcase-pay');
      await provider.page.getByTestId('showcase-package-option').filter({ hasText: pkg.name }).click();
      // The legacy run's acceptance was per card; the package sale asks for its own.
      await provider.page.getByTestId('showcase-package-consent').click();
      await expect(pay).toBeEnabled();
      await pay.click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page).toHaveURL(new RegExp(`return=vitrin&card=${card.id}`));
      await payWithMockCard(provider.page);

      // ── Back with a right, pointed at the card it was bought for ───────────
      await expect(provider.page).toHaveURL(new RegExp(`/vitrin/odeme/.+card=${card.id}`));
      await expect(provider.page.getByTestId('showcase-payment-paid')).toBeVisible();
      await expect(provider.page.getByRole('heading', { name: 'Vitrin hakkınız hazır' })).toBeVisible();
      await expect(provider.page.getByTestId('showcase-create-after-payment')).toHaveCount(0);
      await provider.page.getByRole('link', { name: 'Kartı yayınla' }).click();
      await assertNoErrorScreen(provider.page);

      // ── The card screen: one click, no review — the text is already approved ─
      await expect(provider.page).toHaveURL(new RegExp(`/vitrin/${card.id}`));
      await expect(provider.page.getByRole('heading', { name: 'Yayın süreniz doldu' })).toBeVisible();
      const action = provider.page.getByTestId('showcase-stage-action');
      await expect(action).toHaveText('Yeniden yayınla');
      await action.click();
      await assertNoErrorScreen(provider.page);

      await expect(provider.page).toHaveURL(new RegExp(`/vitrin/${card.id}\\?published=1`));
      await expect(provider.page.getByTestId('showcase-published-notice')).toHaveText(
        'Kartınız vitrinde yayına girdi.',
      );
      await expect(provider.page.getByRole('heading', { name: 'Kartınız yayında' })).toBeVisible();
      await expect(provider.page.getByText('Yayın bitişi', { exact: false })).toContainText(pkg.name);
      await expect(provider.page.getByTestId('showcase-stage-action')).toHaveText('Yayını görüntüle');

      // A second run on the same approved text; the right is spent, nothing went to review.
      expect(await prisma().showcasePlacement.count({ where: { cardId: card.id } })).toBe(2);
      expect(await prisma().showcasePlacement.count({ where: { cardId: card.id, status: 'ACTIVE' } })).toBe(1);
      expect(
        await prisma().showcaseEntitlement.count({ where: { providerId: owner.id, status: 'CONSUMED' } }),
      ).toBe(1);
      expect(await prisma().showcaseCardVersion.count({ where: { cardId: card.id } })).toBe(1);

      // And it is on the home page again, with the same district on its face.
      const visitor = await Actor.open(browser, 'web', primaryRuntime);
      try {
        await visitor.gotoWeb('/');
        await assertNoErrorScreen(visitor.page);
        const shelfCard = visitor.page
          .getByTestId('showcase-shelf-card')
          .filter({ hasText: 'E2E Süresi Dolan Kart' });
        await expect(shelfCard).toBeVisible();
        await expect(shelfCard.getByTestId('showcase-card-area')).toContainText(
          `${location.district}, ${location.city}`,
        );
      } finally {
        await visitor.close();
      }
    } finally {
      await provider.close();
    }
  });

  test('paket tanımlı değilken ekran teknik terim içermez', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin Paketsiz' });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });

    /*
     * The suite shares one database, so a package another spec put on sale is
     * on sale here too. The catalogue is emptied for the length of this test —
     * by switching rows off, never by deleting them — and switched back on
     * afterwards. Serial workers make this safe: nobody else is looking.
     */
    const onSale = await prisma().showcasePackage.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    await prisma().showcasePackage.updateMany({
      where: { id: { in: onSale.map((row) => row.id) } },
      data: { isActive: false },
    });

    const provider = await Actor.open(browser, 'web', primaryRuntime);

    try {
      await provider.loginToWeb(owner.email, owner.password);
      await provider.gotoWeb(`/providers/${owner.id}/vitrin/paketler`);
      await assertNoErrorScreen(provider.page);

      await expect(provider.page.getByRole('heading', { name: 'Vitrin paketi al' })).toBeVisible();
      const unavailable = provider.page.getByTestId('showcase-package-unavailable');
      await expect(unavailable).toBeVisible();
      await expect(unavailable).toContainText('Bu paket şu an satın alınamıyor.');
      // No form that cannot be submitted.
      await expect(provider.page.getByTestId('showcase-package-picker')).toHaveCount(0);
      await expect(provider.page.getByTestId('showcase-pay')).toHaveCount(0);

      // And nothing from the payment plumbing.
      const body = await provider.page.locator('body').innerText();
      for (const leak of ['variant', 'PACKAGE_NOT_MAPPED', 'Lemon']) {
        expect(body, `the package screen must not surface "${leak}"`).not.toContain(leak);
      }

      // The way back is the hub, and the hub still offers only the shop.
      await unavailable.getByRole('link', { name: 'Vitrin kartlarıma dön' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('showcase-buy-package')).toBeVisible();
      await expect(provider.page.getByTestId('showcase-create-card')).toHaveCount(0);
    } finally {
      await provider.close();
      await prisma().showcasePackage.updateMany({
        where: { id: { in: onSale.map((row) => row.id) } },
        data: { isActive: true },
      });
    }
  });
});
