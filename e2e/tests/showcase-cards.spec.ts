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
 * 2. The price-responsibility acceptance is a real gate. The submit button
 *    cannot be used without ticking the sentence the API records an acceptance
 *    of, and the browser enforces it before the API ever has to.
 * 3. Narrowing publishes itself. A provider removing a district gets a new live
 *    version with no operator involved, and nothing lands in the review queue.
 * 4. Withdrawing is reachable at the moment it is needed. The edit form is gone
 *    while a version is under review, so a provider who spots their own typo has
 *    exactly one control on that screen — and it has to work, leave the queue,
 *    and ask for the consent again on the way back in.
 *
 * The 320px checks are here rather than in a separate file because the widths a
 * form breaks at are the widths its own journey walks through: the create form,
 * the card page with two version panels side by side, and the operator's
 * comparison — three of the widest layouts in the product.
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
 * Ticks the price-responsibility consent.
 *
 * By its text rather than by a label, because the sentence *is* the control: it
 * is what the API records an acceptance of, so a locator that could still find
 * the box after the wording changed would be testing the wrong thing.
 */
async function acceptPriceTerms(page: Page) {
  await page.getByText('TakTick bu hizmet bedelini tahsil etmez', { exact: false }).click();
}

/** Removes an added area chip by the sentence the product prints for it. */
async function removeArea(page: Page, city: string, district: string) {
  await page
    .getByRole('button', { name: `${district}, ${city} bölgesini kaldır` })
    .click();
}

test.describe('vitrin kartı: yazım, onay ve daraltma', () => {
  test('hizmet veren kart açar, onaya gönderir, yönetim onaylar', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin' });
    const providerAccount = await createProvider({
      categoryId: category.id,
      location,
      credits: 0,
    });
    const adminAccount = await createAdmin();

    const provider = await Actor.open(browser, 'web', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb(`/providers/${providerAccount.id}/vitrin`);
      await assertNoErrorScreen(provider.page);

      // Nothing yet, and the screen says so rather than showing an empty table.
      await expect(provider.page.getByText('Henüz vitrin kartınız yok.')).toBeVisible();

      await provider.page.getByRole('link', { name: 'Yeni vitrin kartı' }).click();
      await assertNoErrorScreen(provider.page);

      await provider.page.getByLabel('Kategori *').selectOption({ label: category.name });
      await fillCardContent(provider.page, {
        title: 'E2E Klima bakımı',
        summary: 'Standart kapsamda klima bakımı ve filtre temizliği.',
        included: 'Filtre temizliği\nGaz basıncı kontrolü',
        excluded: 'Gaz dolumu\nParça değişimi',
        price: '1.500,00',
      });
      await addArea(provider.page, location.city, location.district);

      await provider.page.getByRole('button', { name: 'Taslağı kaydet' }).click();
      await assertNoErrorScreen(provider.page);

      // The card exists as a draft, and the screen is explicit that nothing is
      // published by saving one.
      await expect(provider.page.getByText('Taslak. İncelemeye göndermediniz.')).toBeVisible();
      await expect(
        provider.page.getByRole('heading', { name: 'E2E Klima bakımı' }),
      ).toBeVisible();

      /*
       * The acceptance gate. The checkbox is `required`, so the browser refuses
       * the submission before the API is asked — and the version stays a draft.
       */
      const submitButton = provider.page.getByRole('button', { name: 'Onaya gönder' });
      await submitButton.click();
      await expect(
        provider.page.getByText('İncelemeye gönderildi', { exact: false }),
      ).toHaveCount(0);

      await acceptPriceTerms(provider.page);
      await submitButton.click();
      await assertNoErrorScreen(provider.page);
      await expect(
        provider.page.getByText('Kart incelemeye gönderildi.', { exact: false }),
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

      await admin.page.getByRole('button', { name: 'Onayla' }).click();
      await assertNoErrorScreen(admin.page);
      await expect(
        admin.page.getByText('Sürüm onaylandı', { exact: false }),
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

      // And the provider sees the approved version, with the wording that does
      // not claim a customer can see it yet.
      await provider.gotoWeb(`/providers/${providerAccount.id}/vitrin`);
      await expect(
        provider.page.getByText('Onaylı sürüm 1 yayına hazır.', { exact: false }),
      ).toBeVisible();
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
      await provider.page.getByRole('button', { name: 'Taslağı kaydet' }).click();
      await assertNoErrorScreen(provider.page);

      await acceptPriceTerms(provider.page);
      await provider.page.getByRole('button', { name: 'Onaya gönder' }).click();
      await assertNoErrorScreen(provider.page);

      // It really is with an operator.
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/showcase/reviews');
      await expect(
        admin.page.getByRole('link', { name: 'E2E Yanlis basli kart' }),
      ).toBeVisible();

      // The provider spots their own mistake. The edit form is gone while the
      // version is under review, so the way out has to be on this screen.
      await expect(
        provider.page.getByRole('button', { name: 'Kaydet' }),
      ).toHaveCount(0);
      await provider.page.getByRole('button', { name: 'İncelemeyi geri çek' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(
        provider.page.getByText('İnceleme talebi geri çekildi', { exact: false }),
      ).toBeVisible();

      // Out of the queue, without anybody having decided anything.
      await admin.gotoAdmin('/showcase/reviews');
      await expect(
        admin.page.getByRole('link', { name: 'E2E Yanlis basli kart' }),
      ).toHaveCount(0);

      // Editable again, and the correction lands on the same version.
      await provider.page.getByLabel('Başlık *').fill('E2E Duzeltilmis kart');
      await provider.page.getByRole('button', { name: 'Kaydet' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(
        provider.page.getByText('Değişiklikler kaydedildi.', { exact: false }),
      ).toBeVisible();

      // Re-submitting needs the acceptance again: withdrawing cleared it.
      await acceptPriceTerms(provider.page);
      await provider.page.getByRole('button', { name: 'Onaya gönder' }).click();
      await assertNoErrorScreen(provider.page);
      await expect(
        provider.page.getByText('Kart incelemeye gönderildi.', { exact: false }),
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
      await provider.page.getByRole('button', { name: 'Taslağı kaydet' }).click();
      await assertNoErrorScreen(provider.page);

      await expect(
        provider.page.getByRole('heading', { name: 'E2E Genel tanitim karti' }),
      ).toBeVisible();

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
      await provider.page.getByRole('button', { name: 'Taslağı kaydet' }).click();
      await assertNoErrorScreen(provider.page);

      await acceptPriceTerms(provider.page);
      await provider.page.getByRole('button', { name: 'Onaya gönder' }).click();
      await assertNoErrorScreen(provider.page);

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/showcase/reviews');
      await admin.page.getByRole('link', { name: 'E2E Iki bolgeli kart' }).click();
      await admin.page.getByRole('button', { name: 'Onayla' }).click();
      await assertNoErrorScreen(admin.page);

      // ── The narrowing ──────────────────────────────────────────────────────
      await provider.page.reload();
      await assertNoErrorScreen(provider.page);

      // Remove the second area and save nothing else.
      await removeArea(provider.page, second.city, second.district);
      await provider.page.getByRole('button', { name: 'Kaydet' }).click();
      await assertNoErrorScreen(provider.page);

      // Straight to a new live version — no draft, no queue entry.
      await expect(
        provider.page.getByText('Onaylı sürüm 2 yayına hazır.', { exact: false }),
      ).toBeVisible();

      // Nothing went to an operator: this card is not in the queue at all.
      await admin.gotoAdmin('/showcase/reviews');
      await expect(
        admin.page.getByRole('link', { name: 'E2E Iki bolgeli kart' }),
      ).toHaveCount(0);

      // The record of it is a system event, not somebody's decision.
      const card = await prisma().showcaseCard.findFirstOrThrow({
        where: { providerId: providerAccount.id },
        select: { liveVersionId: true },
      });
      const audit = await prisma().showcaseCardAutoPublishAudit.findUnique({
        where: { cardVersionId: card.liveVersionId ?? '' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.removedAreaKeys).toHaveLength(1);

      const review = await prisma().showcaseCardReview.findUnique({
        where: { cardVersionId: card.liveVersionId ?? '' },
      });
      expect(review).toBeNull();
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

        await provider.page.getByRole('button', { name: 'Taslağı kaydet' }).click();
        await assertNoErrorScreen(provider.page);
        await expectNoHorizontalOverflow(provider.page, `kart detayı @${width}`);

        // The consent sentence is two lines of terms rather than a chip's worth
        // of label, so it is the control most likely to widen this screen.
        await acceptPriceTerms(provider.page);
        await provider.page.getByRole('button', { name: 'Onaya gönder' }).click();
        await assertNoErrorScreen(provider.page);
        await expectNoHorizontalOverflow(provider.page, `incelemedeki kart @${width}`);

        // The way out of the queue has to be reachable on a phone: this is the
        // one screen where the edit form is gone, so a button that fell off the
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
        await expectNoHorizontalOverflow(provider.page, `geri çekilmiş kart @${width}`);
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
        await provider.page.getByRole('button', { name: 'Taslağı kaydet' }).click();
        await acceptPriceTerms(provider.page);
        await provider.page.getByRole('button', { name: 'Onaya gönder' }).click();
        await assertNoErrorScreen(provider.page);

        await admin.loginToAdmin(adminAccount.email, adminAccount.password);
        await admin.gotoAdmin('/showcase/reviews');
        await assertNoErrorScreen(admin.page);
        await expectNoHorizontalOverflow(admin.page, `inceleme kuyruğu @${width}`);

        await admin.page.getByRole('link', { name: `E2E Admin dar ekran ${width}` }).click();
        await assertNoErrorScreen(admin.page);
        await expectNoHorizontalOverflow(admin.page, `inceleme detayı @${width}`);

        await admin.gotoAdmin('/showcase/cards');
        await assertNoErrorScreen(admin.page);
        await expectNoHorizontalOverflow(admin.page, `kart listesi @${width}`);
      } finally {
        await provider.close();
        await admin.close();
      }
    });
  }
});
