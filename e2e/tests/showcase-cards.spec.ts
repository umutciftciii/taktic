import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCategory, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * A vitrin card from the business's keyboard to the operator's decision, and
 * back.
 *
 * Four things these journeys prove that a unit test cannot:
 *
 * 1. The two screens agree. What a provider writes is what an operator reads,
 *    down to the scope bullets and the price — the API's projection is shared,
 *    but the two pages render it independently.
 * 2. Approval is publication. The right was bought before the card was
 *    written, so the operator's first "Onayla" puts the card on the air and
 *    the provider's hub says "Yayında" with no payment step in between.
 * 3. Narrowing publishes itself. A provider removing a district gets a new live
 *    version with no operator involved, and nothing lands in the review queue.
 * 4. Withdrawing is reachable at the moment it is needed. The edit link is gone
 *    while a version is under review, so a provider who spots their own typo has
 *    exactly one control on that screen — and it has to work, leave the queue,
 *    and open the edit form again on the way back.
 *
 * The 320px checks are here rather than in a separate file because the widths a
 * form breaks at are the widths its own journey walks through: the shop, the
 * create form, the card screen, the edit form and the operator's comparison —
 * the widest layouts in the product. `showcase-screens-viewport.spec.ts`
 * photographs the same screens at four widths from seeded data.
 */

const NARROW_WIDTHS = [320, 375] as const;

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(
    overflow,
    `${label}: the page is ${overflow}px wider than the viewport`,
  ).toBeLessThanOrEqual(0);
}

/**
 * Adds a second district to the provider's own coverage, so a card can claim
 * two areas and then drop one.
 *
 * Written straight through Prisma rather than through the profile form: this
 * suite is about vitrin, and driving the profile editor here would make a
 * failure in that form read as a failure in this one.
 */
async function addSecondArea(providerId: string, city: string, district: string) {
  await prisma().providerServiceArea.create({
    data: { providerId, scope: 'DISTRICT', city, district },
  });
}

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
 * One vitrin package on sale, so a right has something behind it.
 *
 * Written through Prisma rather than through the admin catalogue form: this
 * suite's subject starts at the provider's keyboard, and driving the operator's
 * package editor here would make a failure in that form read as a failure in
 * this journey.
 *
 * The slug carries the reserved `vitrin-` prefix, which the API and two CHECK
 * constraints insist on — it is what keeps a vitrin package from sharing a
 * payment-variant namespace with an offer package.
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
 * A bought, unspent right, so the provider can open a card at all.
 *
 * Package, paid package-first purchase, terms acceptance and an AVAILABLE
 * entitlement, written the way a settlement would have written them. Buying
 * through the screen is `showcase-package-first-flow.spec.ts`'s subject; this
 * suite starts after the money.
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

/** Removes an added area chip by the sentence the product prints for it. */
async function removeArea(page: Page, city: string, district: string) {
  await page
    .getByRole('button', { name: `${district}, ${city} bölgesini kaldır` })
    .click();
}

test.describe('vitrin kartı: yazım, onay ve daraltma', () => {
  test('hizmet veren kart açar, incelemeye gönderir, yönetim onaylar ve kart yayına girer', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin' });
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: 0,
    });
    const adminAccount = await createAdmin();
    const { pkg } = await seedEntitlement(providerAccount.id);

    const provider = await Actor.open(browser, 'web', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb(`/providers/${providerAccount.id}/vitrin`);
      await assertNoErrorScreen(provider.page);

      // Nothing yet, and the screen says so rather than showing an empty table
      // — and, with a right on hand, offers the card rather than the shop.
      await expect(provider.page.getByTestId('showcase-empty')).toBeVisible();
      await expect(provider.page.getByTestId('showcase-entitlement-counter')).toContainText(
        '1 kullanılabilir vitrin hakkınız var',
      );
      await expect(provider.page.getByTestId('showcase-buy-package')).toHaveCount(0);

      await provider.page.getByTestId('showcase-create-card').click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('showcase-entitlement-in-use')).toContainText(pkg.name);

      await provider.page.getByLabel('Kategori *').selectOption({ label: category.name });
      await fillCardContent(provider.page, {
        title: 'E2E Klima bakımı',
        summary: 'Standart kapsamda klima bakımı ve filtre temizliği.',
        included: 'Filtre temizliği\nGaz basıncı kontrolü',
        excluded: 'Gaz dolumu\nParça değişimi',
        price: '1.500,00',
      });
      await addArea(provider.page, location.city, location.district);

      await provider.page.getByRole('button', { name: 'Kartı oluştur' }).click();
      await assertNoErrorScreen(provider.page);

      // The card exists as a draft, and the screen is explicit that nothing is
      // published by saving one.
      await expect(
        provider.page.getByRole('heading', { name: 'Kartınızı incelemeye gönderin' }),
      ).toBeVisible();
      await expect(
        provider.page.getByText('Kartınız henüz kimseye gösterilmiyor.'),
      ).toBeVisible();
      await expect(
        provider.page.getByRole('heading', { name: 'E2E Klima bakımı', level: 1 }),
      ).toBeVisible();

      /*
       * No consent on this screen. The sale terms were accepted when the
       * package was bought, and asking again here would be asking twice for
       * the same signature.
       */
      await expect(provider.page.getByRole('checkbox')).toHaveCount(0);
      await provider.page.getByRole('button', { name: 'İncelemeye gönder' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(
        provider.page.getByText('Kartınız incelemeye gönderildi.', { exact: false }),
      ).toBeVisible();
      await expect(
        provider.page.getByRole('heading', { name: 'Kartınız inceleniyor' }),
      ).toBeVisible();

      // ── The operator's side ────────────────────────────────────────────────
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/showcase/reviews');
      await assertNoErrorScreen(admin.page);

      await admin.page.getByRole('link', { name: 'E2E Klima bakımı' }).click();
      await assertNoErrorScreen(admin.page);

      /*
        What the provider wrote is what the operator reads.

        `exact` on the scope bullets, because the summary above them contains
        the same words: without it Playwright matches the paragraph as well and
        fails on strict mode rather than on the thing being asserted.
      */
      await expect(admin.page.getByText('Filtre temizliği', { exact: true })).toBeVisible();
      await expect(admin.page.getByText('Gaz dolumu', { exact: true })).toBeVisible();
      await expect(admin.page.getByText('₺1.500,00')).toBeVisible();
      await expect(
        admin.page.getByText('TakTick tahsil etmez', { exact: false }).first(),
      ).toBeVisible();
      await expect(
        admin.page.getByText('Bu kartın daha önce onaylanmış bir sürümü bulunmuyor.'),
      ).toBeVisible();
      // And the right the approval will spend, by the name the provider bought it under.
      await expect(admin.page.getByTestId('review-entitlement')).toContainText(pkg.name);

      await admin.page.getByRole('button', { name: 'Onayla' }).click();
      await assertNoErrorScreen(admin.page);
      await expect(
        admin.page.getByText('Sürüm onaylandı', { exact: false }),
      ).toBeVisible();
      await expect(
        admin.page.getByText('vitrinde yayına girdi', { exact: false }),
      ).toBeVisible();

      /*
        This card has left the queue.

        Asserted per card rather than as "the queue is empty": the suite shares
        one database across its files, so another test's pending card being
        there is normal and a global emptiness check would be testing the
        scheduler of the test run rather than this feature.
      */
      await admin.gotoAdmin('/showcase/reviews');
      await expect(
        admin.page.getByRole('link', { name: 'E2E Klima bakımı' }),
      ).toHaveCount(0);

      /*
       * ── What the provider is told the moment it is approved ───────────────
       *
       * Live. Not "approved, now pay", not a package picker, not a version
       * number: the right was spent by the approval and the card is on the
       * air. The hub says "Yayında" and the counter has nothing left to spend.
       */
      await provider.gotoWeb(`/providers/${providerAccount.id}/vitrin`);
      await assertNoErrorScreen(provider.page);

      const hubCard = provider.page.getByTestId('showcase-card-list').getByTestId('showcase-card').first();
      await expect(hubCard).toHaveAttribute('data-state', 'LIVE');
      await expect(hubCard).toContainText('Yayında');
      await expect(hubCard.getByTestId('showcase-stage-action')).toHaveText('Yayını görüntüle');
      await expect(provider.page.getByTestId('showcase-entitlement-counter')).toContainText(
        'Kullanılabilir vitrin hakkınız yok',
      );
      await expect(provider.page.getByText('Ödeme bekliyor')).toHaveCount(0);
      await expect(provider.page.getByText('Şart onayı bekliyor')).toHaveCount(0);
      await expect(provider.page.getByRole('button', { name: 'Ödemeye geç' })).toHaveCount(0);

      /*
       * The technical placement screen is not in the provider's navigation —
       * it used to be a permanent row named after a table — and the lead inbox
       * appears now that this business has published.
       */
      await expect(
        provider.page.getByTestId('pdash-nav-showcase-leads'),
      ).toBeVisible();
      await expect(
        provider.page.getByRole('link', { name: 'Vitrin Yerleşimleri' }),
      ).toHaveCount(0);

      const card = await prisma().showcaseCard.findFirstOrThrow({
        where: { providerId: providerAccount.id },
        select: { id: true, status: true, liveVersionId: true },
      });
      expect(card.status).toBe('APPROVED');
      expect(card.liveVersionId).not.toBeNull();
      expect(
        await prisma().showcasePlacement.count({ where: { cardId: card.id, status: 'ACTIVE' } }),
      ).toBe(1);
      expect(
        await prisma().showcaseEntitlement.count({
          where: { providerId: providerAccount.id, status: 'CONSUMED' },
        }),
      ).toBe(1);
    } finally {
      await provider.close();
      await admin.close();
    }
  });

  test('hizmet veren incelemeyi geri çeker, düzeltir ve yeniden gönderir', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Geri Cekme' });
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: 0,
    });
    const adminAccount = await createAdmin();
    const { entitlement } = await seedEntitlement(providerAccount.id);

    const provider = await Actor.open(browser, 'web', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb(`/providers/${providerAccount.id}/vitrin/yeni`);

      await provider.page.getByLabel('Kategori *').selectOption({ label: category.name });
      await fillCardContent(provider.page, {
        title: 'E2E Yanlis basli kart',
        summary: 'Geri çekilip düzeltilecek bir kart.',
        included: 'Yerinde inceleme',
        excluded: 'Malzeme bedeli',
        price: '750,00',
      });
      await addArea(provider.page, location.city, location.district);
      await provider.page.getByRole('button', { name: 'Kartı oluştur' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınızı incelemeye gönderin' })).toBeVisible();

      await provider.page.getByRole('button', { name: 'İncelemeye gönder' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınız inceleniyor' })).toBeVisible();

      // It really is with an operator, and the right's clock has stopped.
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/showcase/reviews');
      await expect(
        admin.page.getByRole('link', { name: 'E2E Yanlis basli kart' }),
      ).toBeVisible();
      expect(
        (await prisma().showcaseEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } }))
          .reviewPausedAt,
      ).not.toBeNull();

      // The provider spots their own mistake. The edit link is gone while the
      // version is under review, so the way out has to be on this screen.
      await expect(provider.page.getByTestId('showcase-edit-link')).toHaveCount(0);
      await expect(
        provider.page.getByRole('button', { name: 'Kaydet' }),
      ).toHaveCount(0);
      await provider.page.getByRole('button', { name: 'İncelemeyi geri çek' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(
        provider.page.getByText('İnceleme geri çekildi', { exact: false }),
      ).toBeVisible();
      await expect(
        provider.page.getByRole('heading', { name: 'Kartınızı incelemeye gönderin' }),
      ).toBeVisible();

      // Out of the queue, without anybody having decided anything — and the
      // right is back on its clock, still reserved for this card.
      await admin.gotoAdmin('/showcase/reviews');
      await expect(
        admin.page.getByRole('link', { name: 'E2E Yanlis basli kart' }),
      ).toHaveCount(0);
      const right = await prisma().showcaseEntitlement.findUniqueOrThrow({
        where: { id: entitlement.id },
      });
      expect(right.status).toBe('RESERVED');
      expect(right.reviewPausedAt).toBeNull();
      expect(
        await prisma().showcaseEntitlementReviewPause.count({
          where: { entitlementId: entitlement.id, endReason: 'WITHDRAWN' },
        }),
      ).toBe(1);

      // Editable again, and the correction lands on the same version.
      await provider.page.getByTestId('showcase-edit-link').click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartı düzenle' })).toBeVisible();
      await expect(provider.page.getByLabel('Başlık *')).toHaveValue('E2E Yanlis basli kart');
      await provider.page.getByLabel('Başlık *').fill('E2E Duzeltilmis kart');
      await provider.page.getByRole('button', { name: 'Kaydet' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(
        provider.page.getByText('Değişiklikleriniz kaydedildi.', { exact: false }),
      ).toBeVisible();
      await expect(
        provider.page.getByRole('heading', { name: 'E2E Duzeltilmis kart', level: 1 }),
      ).toBeVisible();

      // Re-submitting asks for nothing: the acceptance lives on the right.
      await provider.page.getByRole('button', { name: 'İncelemeye gönder' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınız inceleniyor' })).toBeVisible();
      await expect(
        provider.page.getByText('Kartınız incelemeye gönderildi.', { exact: false }),
      ).toBeVisible();

      await admin.gotoAdmin('/showcase/reviews');
      await expect(
        admin.page.getByRole('link', { name: 'E2E Duzeltilmis kart' }),
      ).toBeVisible();

      // One version throughout — a withdrawal is a retrieval, not a new draft.
      const versions = await prisma().showcaseCardVersion.count({
        where: { card: { providerId: providerAccount.id } },
      });
      expect(versions).toBe(1);

      // And the record of it is a withdrawal, not somebody's decision.
      const withdrawals = await prisma().showcaseSubmissionWithdrawal.count({
        where: { providerId: providerAccount.id },
      });
      expect(withdrawals).toBe(1);
      const reviews = await prisma().showcaseCardReview.count({
        where: { version: { card: { providerId: providerAccount.id } } },
      });
      expect(reviews).toBe(0);
    } finally {
      await provider.close();
      await admin.close();
    }
  });

  test('genel tanıtım kartı, altında hizmet verilen grupla açılabilir', async ({ browser }) => {
    const location = uniqueLocation();
    const group = await createCategory(null, {
      kind: 'GROUP',
      namePrefix: 'E2E Ev Bakimi Grubu',
    });
    const leaf = await createCategory(3, {
      namePrefix: 'E2E Grup Altindaki Hizmet',
      parentId: group.id,
    });
    const providerAccount = await createProvider({
      categoryId: leaf.id,
      location,
      credits: 0,
    });
    await seedEntitlement(providerAccount.id);

    const provider = await Actor.open(browser, 'web', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb(`/providers/${providerAccount.id}/vitrin/yeni`);
      await assertNoErrorScreen(provider.page);

      const select = provider.page.getByTestId('showcase-category-select');

      // SERVICE is the default, and a group is not a service: only the leaf the
      // business is bound to is on offer.
      await expect(select.getByRole('option', { name: leaf.name })).toHaveCount(1);
      await expect(
        select.getByRole('option', { name: new RegExp(group.name) }),
      ).toHaveCount(0);

      // Switching to the general card opens the shelf above it.
      await provider.page.getByRole('radio', { name: 'Genel tanıtım' }).check();
      const groupOption = select.getByRole('option', { name: new RegExp(group.name) });
      await expect(groupOption).toHaveCount(1);
      await expect(select.getByRole('option', { name: leaf.name })).toHaveCount(1);

      // And it is really selectable, all the way to a stored card.
      await select.selectOption({ label: `${group.name} (grup)` });
      await provider.page.getByLabel('Başlık *').fill('E2E Genel tanitim karti');
      await provider.page
        .getByLabel('Özet *')
        .fill('İşletmemizi tanıtan genel vitrin kartı.');
      await provider.page
        .getByLabel('Dahil olanlar * (her satır bir madde)')
        .fill('Yerinde keşif');
      await provider.page
        .getByLabel('Hariç olanlar * (her satır bir madde)')
        .fill('Malzeme bedeli');
      // A general card carries no price at all, so the field is not on screen.
      await expect(provider.page.getByLabel('Sabit hizmet bedeli (₺) *')).toHaveCount(0);

      await addArea(provider.page, location.city, location.district);
      await provider.page.getByRole('button', { name: 'Kartı oluştur' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınızı incelemeye gönderin' })).toBeVisible();

      await expect(
        provider.page.getByRole('heading', { name: 'E2E Genel tanitim karti', level: 1 }),
      ).toBeVisible();
      // A general card carries no price on its face either.
      await expect(provider.page.getByTestId('showcase-card-price')).toHaveCount(0);

      const stored = await prisma().showcaseCard.findFirstOrThrow({
        where: { providerId: providerAccount.id },
        select: { kind: true, categoryId: true },
      });
      expect(stored.kind).toBe('PROMOTION');
      expect(stored.categoryId).toBe(group.id);
    } finally {
      await provider.close();
    }
  });

  test('yalnız bölge daraltma incelemeye düşmeden yeni canlı sürüm üretir', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const second = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Daraltma' });
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: 0,
    });
    const adminAccount = await createAdmin();
    await addSecondArea(providerAccount.id, second.city, second.district);
    await seedEntitlement(providerAccount.id);

    const provider = await Actor.open(browser, 'web', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb(`/providers/${providerAccount.id}/vitrin/yeni`);

      await provider.page.getByLabel('Kategori *').selectOption({ label: category.name });
      await fillCardContent(provider.page, {
        title: 'E2E Iki bolgeli kart',
        summary: 'İki bölgede verilen standart hizmet.',
        included: 'Yerinde inceleme',
        excluded: 'Malzeme bedeli',
        price: '900,00',
      });
      await addArea(provider.page, location.city, location.district);
      await addArea(provider.page, second.city, second.district);
      await provider.page.getByRole('button', { name: 'Kartı oluştur' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınızı incelemeye gönderin' })).toBeVisible();

      await provider.page.getByRole('button', { name: 'İncelemeye gönder' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınız inceleniyor' })).toBeVisible();

      // Approval is publication: the card is live, on both districts.
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/showcase/reviews');
      await admin.page.getByRole('link', { name: 'E2E Iki bolgeli kart' }).click();
      await admin.page.getByRole('button', { name: 'Onayla' }).click();
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByText('vitrinde yayına girdi', { exact: false })).toBeVisible();

      const card = await prisma().showcaseCard.findFirstOrThrow({
        where: { providerId: providerAccount.id },
        select: { id: true },
      });

      // ── The narrowing ──────────────────────────────────────────────────────
      await provider.gotoWeb(`/providers/${providerAccount.id}/vitrin/${card.id}`);
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartınız yayında' })).toBeVisible();
      await expect(provider.page.getByTestId('showcase-card-face')).toContainText(
        `${second.district}, ${second.city}`,
      );

      // The edit form warns that a change goes back through review — and then
      // this one does not, because it only removes.
      await provider.page.getByTestId('showcase-edit-link').click();
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByRole('heading', { name: 'Kartı düzenle' })).toBeVisible();
      await expect(
        provider.page.getByText('Değişiklikler yeniden incelemeye girer; yayındaki metin onaya kadar aynı kalır.'),
      ).toBeVisible();

      // Remove the second area and save nothing else.
      await removeArea(provider.page, second.city, second.district);
      await provider.page.getByRole('button', { name: 'Kaydet' }).click();
      await assertNoErrorScreen(provider.page);

      /*
       * Straight to a new live text — no draft, no queue entry.
       *
       * Asserted on the *area* rather than on a version number: the screen
       * never prints "sürüm 2" at a provider, and the fact that matters is
       * that the removed district is gone from what customers are shown while
       * the card stayed on the air.
       */
      await expect(provider.page).toHaveURL(new RegExp(`/vitrin/${card.id}\\?saved=1`));
      await expect(provider.page.getByRole('heading', { name: 'Kartınız yayında' })).toBeVisible();
      const face = provider.page.getByTestId('showcase-card-face');
      await expect(face).toContainText(`${location.district}, ${location.city}`);
      await expect(face.getByText(`${second.district}, ${second.city}`)).toHaveCount(0);
      await expect(provider.page.getByText('sürüm', { exact: false })).toHaveCount(0);
      // No draft was opened, so there is nothing to send and nothing to take back.
      await expect(provider.page.getByTestId('showcase-submit-revision')).toHaveCount(0);
      await expect(provider.page.getByRole('button', { name: 'İncelemeyi geri çek' })).toHaveCount(0);

      // Nothing went to an operator: this card is not in the queue at all.
      await admin.gotoAdmin('/showcase/reviews');
      await expect(
        admin.page.getByRole('link', { name: 'E2E Iki bolgeli kart' }),
      ).toHaveCount(0);

      // The record of it is a system event, not somebody's decision.
      const after = await prisma().showcaseCard.findUniqueOrThrow({
        where: { id: card.id },
        select: { liveVersionId: true, draftVersionId: true },
      });
      expect(after.draftVersionId).toBeNull();
      const audit = await prisma().showcaseCardAutoPublishAudit.findUnique({
        where: { cardVersionId: after.liveVersionId ?? '' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.removedAreaKeys).toHaveLength(1);

      const review = await prisma().showcaseCardReview.findUnique({
        where: { cardVersionId: after.liveVersionId ?? '' },
      });
      expect(review).toBeNull();

      // And the paid run followed the card: still one live run, now pinned to
      // the narrowed text and off the dropped district's shelf.
      const placement = await prisma().showcasePlacement.findFirstOrThrow({
        where: { cardId: card.id, status: 'ACTIVE' },
        select: { pinnedVersionId: true, shelves: { where: { active: true }, select: { district: true } } },
      });
      expect(placement.pinnedVersionId).toBe(after.liveVersionId);
      expect(placement.shelves.map((shelf) => shelf.district)).toEqual([location.district]);
    } finally {
      await provider.close();
      await admin.close();
    }
  });
});

test.describe('vitrin ekranları dar ekranda', () => {
  for (const width of NARROW_WIDTHS) {
    test(`hizmet veren ekranları ${width}px genişlikte taşmaz`, async ({ browser }) => {
      const location = uniqueLocation();
      const category = await createCategory(3, { namePrefix: `E2E Dar ${width}` });
      const providerAccount = await createProvider({
        categoryId: category.id,
        location,
        credits: 0,
      });

      const provider = await Actor.open(browser, 'web', primaryRuntime, {
        viewport: { width, height: 720 },
      });

      try {
        await provider.loginToWeb(providerAccount.email, providerAccount.password);

        // Before any right: the hub with its one button, and the shop it leads to.
        await provider.gotoWeb(`/providers/${providerAccount.id}/vitrin`);
        await assertNoErrorScreen(provider.page);
        await expectNoHorizontalOverflow(provider.page, `vitrin listesi (haksız) @${width}`);

        await provider.page.getByTestId('showcase-buy-package').click();
        await assertNoErrorScreen(provider.page);
        await expect(provider.page).toHaveURL(/\/vitrin\/paketler/);
        await expectNoHorizontalOverflow(provider.page, `paket seçimi @${width}`);

        // The consent sentence is two lines of terms rather than a chip's worth
        // of label, so it is the control most likely to widen this screen.
        // Unique per attempt: a retry of this case must not find two packages
        // of one name on the shop and stop on a strict-mode violation.
        const { pkg } = await seedEntitlement(
          providerAccount.id,
          `E2E Dar Paket ${width} ${Date.now().toString(36).slice(-4)}`,
        );
        await provider.page.reload();
        await assertNoErrorScreen(provider.page);
        await provider.page.getByTestId('showcase-package-option').filter({ hasText: pkg.name }).click();
        await expectNoHorizontalOverflow(provider.page, `paket seçildi @${width}`);

        await provider.gotoWeb(`/providers/${providerAccount.id}/vitrin`);
        await assertNoErrorScreen(provider.page);
        await expectNoHorizontalOverflow(provider.page, `vitrin listesi @${width}`);

        await provider.gotoWeb(`/providers/${providerAccount.id}/vitrin/yeni`);
        await assertNoErrorScreen(provider.page);
        await expectNoHorizontalOverflow(provider.page, `yeni kart formu @${width}`);

        // The category select carries indented, potentially long category names,
        // so it is the control most likely to widen this form.
        const categorySelect = provider.page.getByTestId('showcase-category-select');
        await expect(categorySelect).toBeVisible();
        await provider.page.getByRole('radio', { name: 'Genel tanıtım' }).check();
        await expectNoHorizontalOverflow(provider.page, `genel tanıtım kategorileri @${width}`);
        await provider.page.getByRole('radio', { name: 'Hizmet vitrini' }).check();
        await expectNoHorizontalOverflow(provider.page, `hizmet kategorileri @${width}`);

        // The form filled in, because a form only overflows once it has content:
        // a long scope line and an added area chip are what push it wide.
        await provider.page.getByLabel('Kategori *').selectOption({ label: category.name });
        await fillCardContent(provider.page, {
          title: 'E2E Dar ekran kartı, uzunca bir başlık ile birlikte',
          summary:
            'Bu özet, dar ekranda satır kırılmasını zorlamak için bilinçli olarak uzun tutulmuş bir metindir.',
          included: 'Yerinde inceleme ve raporlama, oldukça uzun bir kapsam maddesi olarak',
          excluded: 'Malzeme bedeli ve nakliye, yine oldukça uzun bir hariç maddesi olarak',
          price: '12.345,00',
        });
        await addArea(provider.page, location.city, location.district);
        await expectNoHorizontalOverflow(provider.page, `dolu kart formu @${width}`);

        await provider.page.getByRole('button', { name: 'Kartı oluştur' }).click();
        await assertNoErrorScreen(provider.page);
        await expect(provider.page.getByRole('heading', { name: 'Kartınızı incelemeye gönderin' })).toBeVisible();
        await expectNoHorizontalOverflow(provider.page, `kart detayı @${width}`);

        // The hub with a card in it: the face, the badge and the foot.
        const cardUrl = provider.page.url();
        await provider.gotoWeb(`/providers/${providerAccount.id}/vitrin`);
        await assertNoErrorScreen(provider.page);
        await expect(provider.page.getByTestId('showcase-card')).toHaveCount(1);
        await expectNoHorizontalOverflow(provider.page, `vitrin listesi (kartlı) @${width}`);

        // The edit form, opened on the long text.
        await provider.page.goto(`${cardUrl}/duzenle`, { waitUntil: 'domcontentloaded' });
        await assertNoErrorScreen(provider.page);
        await expect(provider.page.getByRole('heading', { name: 'Kartı düzenle' })).toBeVisible();
        await expectNoHorizontalOverflow(provider.page, `düzenleme formu @${width}`);

        await provider.page.goto(cardUrl, { waitUntil: 'domcontentloaded' });
        await assertNoErrorScreen(provider.page);
        await provider.page.getByRole('button', { name: 'İncelemeye gönder' }).click();
        await assertNoErrorScreen(provider.page);
        await expect(provider.page.getByRole('heading', { name: 'Kartınız inceleniyor' })).toBeVisible();
        await expectNoHorizontalOverflow(provider.page, `incelemedeki kart @${width}`);

        // The way out of the queue has to be reachable on a phone: this is the
        // one screen where the edit link is gone, so a button that fell off the
        // side here would leave the provider with nothing to do.
        const withdraw = provider.page.getByRole('button', { name: 'İncelemeyi geri çek' });
        await expect(withdraw).toBeVisible();
        await expect(withdraw).toBeEnabled();
        // Reachable, not necessarily above the fold: a phone scrolls, and
        // demanding that a page this long fit one screen would be asserting a
        // layout nobody designed rather than that the control works.
        await withdraw.scrollIntoViewIfNeeded();

        await withdraw.click();
        await assertNoErrorScreen(provider.page);
        // The withdrawal is a server action followed by a re-render: the menu
        // below only exists on the withdrawn screen, and a click that lands on
        // the one being replaced opens nothing. Wait for the screen first —
        // the same wait the withdraw case above makes.
        await expect(
          provider.page.getByRole('heading', { name: 'Kartınızı incelemeye gönderin' }),
        ).toBeVisible();
        await expectNoHorizontalOverflow(provider.page, `geri çekilmiş kart @${width}`);

        // The ⋯ menu and the dialog behind it, the two overlays on this screen.
        await provider.page.getByLabel('Diğer işlemler').click();
        await expect(provider.page.getByTestId('showcase-card-danger')).toBeVisible();
        await expectNoHorizontalOverflow(provider.page, `kart menüsü @${width}`);
        await provider.page.getByTestId('showcase-card-danger').click();
        await expect(provider.page.getByRole('dialog')).toBeVisible();
        await expectNoHorizontalOverflow(provider.page, `silme diyaloğu @${width}`);
      } finally {
        await provider.close();
      }
    });

    test(`yönetim inceleme ekranları ${width}px genişlikte taşmaz`, async ({ browser }) => {
      const location = uniqueLocation();
      const category = await createCategory(3, { namePrefix: `E2E Admin Dar ${width}` });
      const providerAccount = await createProvider({
        categoryId: category.id,
        location,
        credits: 0,
      });
      const adminAccount = await createAdmin();
      await seedEntitlement(providerAccount.id);

      const provider = await Actor.open(browser, 'web', primaryRuntime);
      const admin = await Actor.open(browser, 'admin', primaryRuntime, {
        viewport: { width, height: 720 },
      });

      try {
        await provider.loginToWeb(providerAccount.email, providerAccount.password);
        await provider.gotoWeb(`/providers/${providerAccount.id}/vitrin/yeni`);
        await provider.page.getByLabel('Kategori *').selectOption({ label: category.name });
        await fillCardContent(provider.page, {
          title: `E2E Admin dar ekran ${width}`,
          summary: 'Yönetim ekranının dar ekranda taşmadığını doğrulamak için açılan kart.',
          included: 'Yerinde inceleme ve raporlama, uzunca bir kapsam maddesi',
          excluded: 'Malzeme bedeli ve nakliye, uzunca bir hariç maddesi',
          price: '2.750,00',
        });
        await addArea(provider.page, location.city, location.district);
        await provider.page.getByRole('button', { name: 'Kartı oluştur' }).click();
        await assertNoErrorScreen(provider.page);
        await expect(provider.page.getByRole('heading', { name: 'Kartınızı incelemeye gönderin' })).toBeVisible();
        await provider.page.getByRole('button', { name: 'İncelemeye gönder' }).click();
        await assertNoErrorScreen(provider.page);
        await expect(provider.page.getByRole('heading', { name: 'Kartınız inceleniyor' })).toBeVisible();

        await admin.loginToAdmin(adminAccount.email, adminAccount.password);
        await admin.gotoAdmin('/showcase/reviews');
        await assertNoErrorScreen(admin.page);
        await expectNoHorizontalOverflow(admin.page, `inceleme kuyruğu @${width}`);

        await admin.page.getByRole('link', { name: `E2E Admin dar ekran ${width}` }).click();
        await assertNoErrorScreen(admin.page);
        await expect(admin.page.getByTestId('review-entitlement')).toBeVisible();
        await expectNoHorizontalOverflow(admin.page, `inceleme detayı @${width}`);

        await admin.gotoAdmin('/showcase/cards');
        await assertNoErrorScreen(admin.page);
        await expectNoHorizontalOverflow(admin.page, `kart listesi @${width}`);

        await admin.gotoAdmin('/showcase/packages');
        await assertNoErrorScreen(admin.page);
        await expectNoHorizontalOverflow(admin.page, `paket kataloğu @${width}`);
      } finally {
        await provider.close();
        await admin.close();
      }
    });
  }
});
