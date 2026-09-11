import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  prisma,
  uniqueLocation,
} from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The paid half of vitrin, end to end: a business buys a run, the run appears on
 * the home page, a visitor writes to that business, and nobody else ever sees
 * the request.
 *
 * ## What these journeys prove that a unit test cannot
 *
 * 1. **The shelf is on the home page, unconditionally.** No province is chosen
 *    and no query string is set, and the card a business paid to publish is
 *    there — with its service area stated on the card itself, which is what
 *    replaced the location gate that used to stand in front of it.
 * 2. **Coverage is decided on the server, not on the screen.** A visitor can
 *    reach any card, and a lead for an address the card does not serve is
 *    refused with a route onward rather than opened.
 * 3. **The lead form is a real gate.** A visitor cannot write to a business
 *    without proving a telephone number, and the steps on the card's page are
 *    what that looks like in a browser.
 * 4. **Only one business sees it.** Two providers match the request equally
 *    well; the second one's panel is checked, and it has to be empty.
 * 5. **The screens say what the clock does before it does it.** The archive
 *    form states that the paid days keep running, and the publish panel states
 *    what was bought — a provider should not learn either afterwards.
 *
 * The 320px checks are on the two pages a visitor actually meets — the shelf and
 * the card — because those are the ones with a card grid and a form on them,
 * and a grid with a fixed track minimum is the classic way a page ends up wider
 * than a phone.
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
 * An approved card with one approved version, written through Prisma.
 *
 * The authoring and review journey is `showcase-cards.spec.ts`'s subject.
 * Driving it again here would make a failure in that flow read as a failure in
 * this one, and would triple the runtime of a suite whose subject starts after
 * the approval.
 */
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
      priceTermsVersion: 'v1',
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
 * The same fold the API applies, restated here rather than imported.
 *
 * The e2e suite talks to the application over HTTP and to the database through
 * Prisma; importing an API module into it would make this suite depend on the
 * API's internals rather than on its behaviour. The rule is three lines and the
 * shape is checked by a database CHECK anyway.
 */
function areaKey(city: string, district: string): string {
  const fold = (value: string) =>
    value.normalize('NFC').trim().toLocaleLowerCase('tr-TR').replace(/ı/g, 'i');
  return `${fold(city)}|${fold(district)}|`;
}

/**
 * The canonical form the API stores a proved number in.
 *
 * Restated here rather than imported, for the reason `areaKey` is: this suite
 * talks to the application over HTTP and to the database through Prisma, and
 * importing an API module would make it depend on internals rather than on
 * behaviour. Only the one shape these tests generate — a Turkish national
 * number — is handled, and anything else fails loudly rather than being
 * guessed at.
 */
function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) {
    return `+90${digits.slice(1)}`;
  }
  throw new Error(`e2e fixture produced a phone number it cannot canonicalise: ${phone}`);
}

/** A settled vitrin purchase and the live run it produced. */
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
  const endAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const pkg = await db.showcasePackage.create({
    data: {
      name: 'E2E Vitrin 30 Gün',
      slug: `vitrin-e2e-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
      priceAmount: 49_900,
      currency: 'TRY',
      durationDays: 30,
    },
  });

  /*
   * Every vitrin sale is made against an acceptance of the price-responsibility
   * text: the purchase CHECK insists on one and the placement snapshots what it
   * said. The seed writes the row the buying screen would have written.
   *
   * The version and the sentence are restated here rather than imported, the
   * same way the card seed above restates them and `areaKey` restates the fold
   * — this suite talks to the application over HTTP and must not share a
   * constant with the code it is testing.
   */
  const owner = await db.providerProfile.findUniqueOrThrow({
    where: { id: options.providerId },
    select: { userId: true },
  });

  const acceptance = await db.showcaseCardPriceTermsAcceptance.create({
    data: {
      providerId: options.providerId,
      cardId: options.cardId,
      acceptedByUserId: owner.userId!,
      termsVersion: 'v1',
      termsTextSnapshot:
        'Kartta belirtilen hizmet bedeli ve kapsam hizmet verenin sorumluluğundadır. ' +
        'TakTick bu hizmet bedelini tahsil etmez ve taraflar arasındaki ödemeye müdahil olmaz.',
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

/**
 * Proves a telephone number the way the lead flow requires.
 *
 * The suite cannot read an SMS, so it writes the row a completed verification
 * would have left: consumed, unbound to any request, and recent. That is exactly
 * what the lead endpoint redeems — and it binds it, which is what makes the
 * proof single-use here too.
 */
async function proveLeadPhone(phone: string) {
  const normalized = toE164(phone);
  const now = new Date();

  await prisma().phoneVerification.create({
    data: {
      normalizedPhone: normalized,
      codeHash: 'e2e-consumed',
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      consumedAt: now,
      requestId: null,
    },
  });
}

test.describe('vitrin: yayın, ana sayfa rafı ve doğrudan talep', () => {
  test('ziyaretçi konum seçmeden kartı görür, karttan talep gönderir; talep yalnız kart sahibine gider', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin Lead' });

    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    // A second business matching the same category and district. Its whole job
    // in this test is to see nothing.
    const rival = await createProvider({ categoryId: category.id, location, credits: 20 });

    const { card, version } = await seedApprovedCard({
      providerId: owner.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: 'E2E Vitrin Klima Bakımı',
    });
    await seedLivePlacement({
      providerId: owner.id,
      cardId: card.id,
      versionId: version.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
    });

    const visitor = await Actor.open(browser, 'web', primaryRuntime);
    const providerActor = await Actor.open(browser, 'web', primaryRuntime);
    const rivalActor = await Actor.open(browser, 'web', primaryRuntime);

    try {
      /*
       * ── The shelf, with no location chosen anywhere ───────────────────────
       *
       * The bare home page. No query string, no province picker, no cookie —
       * and the card is on it, because that is what the business bought. What
       * keeps the promise honest is the line the next assertion checks.
       */
      await visitor.gotoWeb('/');
      await assertNoErrorScreen(visitor.page);

      const shelf = visitor.page.getByTestId('showcase-shelf');
      await expect(shelf).toBeVisible();
      const shelfCard = shelf.locator('article', {
        hasText: 'E2E Vitrin Klima Bakımı',
      });
      await expect(shelfCard).toBeVisible();

      // The single most load-bearing line on a card met without a filter.
      await expect(shelfCard.getByTestId('showcase-card-area')).toContainText(
        `${location.district}, ${location.city}`,
      );
      // The provider's own price to their own customer. What TakTick charged
      // for the listing never appears on this page at all.
      await expect(shelfCard.getByText('₺1.500,00')).toBeVisible();

      for (const width of NARROW_WIDTHS) {
        await visitor.page.setViewportSize({ width, height: 900 });
        await expectNoHorizontalOverflow(visitor.page, `vitrin rafı @ ${width}px`);
      }
      await visitor.page.setViewportSize({ width: 1280, height: 900 });

      // ── The card's own page: a decision first, then the gate ──────────────
      await shelfCard.getByRole('link', { name: 'Bu hizmeti incele' }).click();
      await assertNoErrorScreen(visitor.page);

      await expect(
        visitor.page.getByRole('heading', { name: 'E2E Vitrin Klima Bakımı' }),
      ).toBeVisible();

      /*
       * The scope, stated as a limit, with both ways out of it. A visitor who
       * arrived from an unfiltered shelf is owed the question "is this for me"
       * before they are shown a form.
       */
      await expect(visitor.page.getByTestId('showcase-card-coverage-note')).toContainText(
        `Bu hizmet yalnız ${location.district}, ${location.city} kapsamındaki işler için sunulur.`,
      );
      const decision = visitor.page.getByTestId('showcase-card-decision');
      await expect(decision.getByRole('link', { name: 'Vazgeç' })).toBeVisible();
      await expect(visitor.page.getByTestId('showcase-lead-form')).toHaveCount(0);

      await decision.getByRole('link', { name: 'Devam et' }).click();
      await assertNoErrorScreen(visitor.page);

      // The lead form is not reachable until a telephone number is proved.
      await expect(visitor.page.getByTestId('showcase-lead-form')).toHaveCount(0);
      await expect(visitor.page.getByLabel('Telefon *')).toBeVisible();

      for (const width of NARROW_WIDTHS) {
        await visitor.page.setViewportSize({ width, height: 900 });
        await expectNoHorizontalOverflow(visitor.page, `vitrin kartı @ ${width}px`);
      }
      await visitor.page.setViewportSize({ width: 1280, height: 900 });

      /*
       * The verification is completed out of band — the suite cannot read an
       * SMS — and the form is then reached directly at the step it would have
       * landed on. What is being tested here is that the *form* refuses to
       * exist before that point, which the assertion above already made, and
       * that the lead it produces reaches one business and no other.
       */
      const customerPhone = `0555${String(Date.now()).slice(-7)}`;
      await proveLeadPhone(customerPhone);

      await visitor.gotoWeb(
        `/vitrin/${card.id}?step=form&phone=${encodeURIComponent(customerPhone)}`,
      );
      await assertNoErrorScreen(visitor.page);

      const form = visitor.page.getByTestId('showcase-lead-form');
      await expect(form).toBeVisible();

      // The two options are rendered from this card's own approved promises.
      await expect(
        visitor.page.getByText('Acil — 3 saat içinde dönüş', { exact: false }),
      ).toBeVisible();
      await expect(
        visitor.page.getByText('Normal — 24 saat içinde dönüş', { exact: false }),
      ).toBeVisible();

      await visitor.page.getByTestId('showcase-urgency-urgent').check();
      await visitor.page.getByLabel('Ad soyad *').fill('E2E Vitrin Müşterisi');
      await visitor.page
        .getByLabel('E-posta *')
        .fill(`e2e-vitrin-${Date.now()}@example.test`);
      await visitor.page.getByLabel('İl *').selectOption(location.city);
      await visitor.page.getByLabel('İlçe *').fill(location.district);
      await visitor.page
        .getByLabel('Talebiniz *')
        .fill('Salon kliması bakım istiyorum, iki gündür soğutmuyor.');

      await visitor.page.getByTestId('showcase-lead-submit').click();
      await assertNoErrorScreen(visitor.page);
      await expect(visitor.page.getByTestId('showcase-lead-sent')).toBeVisible();

      // ── The card owner sees it; the rival does not ────────────────────────
      await providerActor.loginToWeb(owner.email, owner.password);
      await providerActor.gotoWeb(`/providers/${owner.id}/vitrin/talepler`);
      await assertNoErrorScreen(providerActor.page);

      await expect(
        providerActor.page.getByRole('heading', { name: 'Vitrin talepleri' }),
      ).toBeVisible();

      /*
       * The urgency and the promise behind it, asserted as a substring of the
       * cell rather than as an exact element text.
       *
       * `getByText(…, { exact: true })` matches an element's *whole* text, and
       * the cell deliberately carries both the choice and the hours it commits
       * to — "Acil" above "3 saat taahhüt" — because a provider reading an
       * inbox needs the deadline, not just the word.
       */
      const inboxRow = providerActor.page.locator('table tbody tr').first();
      await expect(inboxRow).toContainText('Acil');
      await expect(inboxRow).toContainText('3 saat taahhüt');

      await inboxRow.getByRole('link').first().click();
      await assertNoErrorScreen(providerActor.page);

      // The sentence that matters most on this screen: answering costs nothing.
      await expect(
        providerActor.page.getByText('teklif kredisi harcanmaz', { exact: false }).first(),
      ).toBeVisible();
      // And the customer's telephone number is not on it. Contact opens through
      // the accepted-offer path and through nothing else.
      await expect(providerActor.page.getByText(customerPhone)).toHaveCount(0);

      await rivalActor.loginToWeb(rival.email, rival.password);
      await rivalActor.gotoWeb(`/providers/${rival.id}/vitrin/talepler`);
      await assertNoErrorScreen(rivalActor.page);
      await expect(
        rivalActor.page.getByText('Henüz vitrin talebiniz yok.', { exact: false }),
      ).toBeVisible();

      // Nor is it in the rival's ordinary matching list: a direct lead is not a
      // marketplace request with a preference attached.
      await rivalActor.gotoWeb(`/providers/${rival.id}/requests`);
      await assertNoErrorScreen(rivalActor.page);
      await expect(
        rivalActor.page.getByText('E2E Vitrin Klima Bakımı', { exact: false }),
      ).toHaveCount(0);
    } finally {
      await visitor.close();
      await providerActor.close();
      await rivalActor.close();
    }
  });

  test('kapsam dışı konum için doğrudan talep açılmaz, genel talep yolu gösterilir', async ({
    browser,
  }) => {
    const covered = uniqueLocation();
    const elsewhere = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin Kapsam' });
    const owner = await createProvider({ categoryId: category.id, location: covered, credits: 0 });

    const { card, version } = await seedApprovedCard({
      providerId: owner.id,
      categoryId: category.id,
      city: covered.city,
      district: covered.district,
      title: 'E2E Kapsam Disi Kart',
    });
    await seedLivePlacement({
      providerId: owner.id,
      cardId: card.id,
      versionId: version.id,
      categoryId: category.id,
      city: covered.city,
      district: covered.district,
    });

    const visitor = await Actor.open(browser, 'web', primaryRuntime);

    try {
      /*
       * The visitor reaches the card perfectly legitimately — every live card
       * is on the home page now — and then types an address the business does
       * not serve. The screen cannot be what stops this: only the server knows
       * what the run's shelf holds, and only the customer knows where the work
       * is.
       */
      const customerPhone = `0555${String(Date.now()).slice(-7)}`;
      await proveLeadPhone(customerPhone);

      await visitor.gotoWeb(
        `/vitrin/${card.id}?step=form&phone=${encodeURIComponent(customerPhone)}`,
      );
      await assertNoErrorScreen(visitor.page);

      await visitor.page.getByTestId('showcase-urgency-normal').check();
      await visitor.page.getByLabel('Ad soyad *').fill('E2E Kapsam Disi');
      await visitor.page
        .getByLabel('E-posta *')
        .fill(`e2e-kapsam-${Date.now()}@example.test`);
      await visitor.page.getByLabel('İl *').selectOption(elsewhere.city);
      await visitor.page.getByLabel('İlçe *').fill(elsewhere.district);
      await visitor.page
        .getByLabel('Talebiniz *')
        .fill('Kapsam dışı bir adres için talep gönderiyorum.');

      await visitor.page.getByTestId('showcase-lead-submit').click();
      await assertNoErrorScreen(visitor.page);

      // The refusal, in the words the product promises — and a way onward
      // rather than a dead end.
      const refusal = visitor.page.getByTestId('showcase-lead-area-not-served');
      await expect(refusal).toBeVisible();
      await expect(refusal).toContainText(
        'Bu vitrin hizmeti seçtiğiniz konumu kapsamıyor. Genel talep oluşturmaya devam edebilirsiniz.',
      );
      await expect(visitor.page.getByTestId('showcase-lead-sent')).toHaveCount(0);

      // Nothing was opened.
      expect(await prisma().showcaseLead.count({ where: { cardId: card.id } })).toBe(0);

      await visitor.page.getByTestId('showcase-general-request-cta').click();
      await assertNoErrorScreen(visitor.page);
      await expect(visitor.page).toHaveURL(new RegExp(`/categories/${category.slug}`));

      for (const width of NARROW_WIDTHS) {
        await visitor.page.setViewportSize({ width, height: 900 });
        await expectNoHorizontalOverflow(visitor.page, `kapsam dışı uyarısı @ ${width}px`);
      }
    } finally {
      await visitor.close();
    }
  });

  test('talep formunda kategori ve konuma uyan vitrin kartları gösterilir', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin Form' });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });

    const { card, version } = await seedApprovedCard({
      providerId: owner.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: 'E2E Form Ici Vitrin Karti',
    });
    await seedLivePlacement({
      providerId: owner.id,
      cardId: card.id,
      versionId: version.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
    });

    const visitor = await Actor.open(browser, 'web', primaryRuntime);

    try {
      await visitor.gotoWeb(`/categories/${category.slug}`);
      await assertNoErrorScreen(visitor.page);

      // Nothing is offered before the customer has said where the work is:
      // without a place the block would be the home page shelf wedged into a
      // form somebody is halfway through.
      await expect(visitor.page.getByTestId('showcase-request-matches')).toHaveCount(0);

      await visitor.page.getByLabel('Açıklama', { exact: false }).first().fill(
        'Salon kliması bakım istiyorum, iki gündür soğutmuyor.',
      );
      await visitor.page.getByRole('tab', { name: 'Konum & zaman' }).click();
      await visitor.page.getByTestId('request-city').selectOption(location.city);
      await visitor.page.getByTestId('request-district').selectOption(location.district);

      const matches = visitor.page.getByTestId('showcase-request-matches');
      await expect(matches).toBeVisible();
      await expect(matches.getByText('E2E Form Ici Vitrin Karti')).toBeVisible();
      await expect(matches.getByText(`${location.district}, ${location.city}`)).toBeVisible();

      for (const width of NARROW_WIDTHS) {
        await visitor.page.setViewportSize({ width, height: 900 });
        await expectNoHorizontalOverflow(visitor.page, `talep formu vitrin bloğu @ ${width}px`);
      }
      await visitor.page.setViewportSize({ width: 1280, height: 900 });

      // Choosing one leaves the marketplace form for that card, carrying the
      // place the customer already picked so it is not asked twice.
      await matches.getByTestId('showcase-request-match-cta').first().click();
      await assertNoErrorScreen(visitor.page);
      await expect(visitor.page).toHaveURL(new RegExp(`/vitrin/${card.id}`));
      await expect(visitor.page.getByTestId('showcase-card-decision')).toBeVisible();
    } finally {
      await visitor.close();
    }
  });

  test('hizmet veren yayındaki süresini ve arşivleme bedelini kartında görür', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin Panel' });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });

    const { card, version } = await seedApprovedCard({
      providerId: owner.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: 'E2E Yayındaki Kart',
    });
    await seedLivePlacement({
      providerId: owner.id,
      cardId: card.id,
      versionId: version.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
    });

    const provider = await Actor.open(browser, 'web', primaryRuntime);

    try {
      await provider.loginToWeb(owner.email, owner.password);
      await provider.gotoWeb(`/providers/${owner.id}/vitrin/${card.id}`);
      await assertNoErrorScreen(provider.page);

      // What was bought, in the provider's own words — and nothing about a
      // placement, a version number or a raw status.
      await expect(
        provider.page.getByRole('heading', { name: 'Vitrin yayını' }),
      ).toBeVisible();
      await expect(provider.page.getByTestId('showcase-live-until')).toContainText('Yayında');
      await expect(provider.page.getByText('E2E Vitrin 30 Gün')).toBeVisible();
      await expect(
        provider.page.getByText(`${location.district}, ${location.city}`).first(),
      ).toBeVisible();
      await expect(provider.page.getByText('sürüm', { exact: false })).toHaveCount(0);

      // A business that *has* published gets the lead inbox in its navigation.
      await expect(provider.page.getByTestId('pdash-nav-showcase-leads')).toBeVisible();

      /*
       * The sentence that has to be read before the button, not after.
       *
       * Archiving takes the card off the air and the paid days go on being
       * spent. That is deliberate — a run that could be frozen and resumed at
       * will would be a voucher rather than a dated placement — but it is only
       * fair if it is said first.
       */
      await expect(
        provider.page.getByText('arşivdeyken de işlemeye devam eder', { exact: false }),
      ).toBeVisible();

      for (const width of NARROW_WIDTHS) {
        await provider.page.setViewportSize({ width, height: 900 });
        await expectNoHorizontalOverflow(provider.page, `vitrin kart ekranı @ ${width}px`);
      }
    } finally {
      await provider.close();
    }
  });

  test('yönetim yerleşimi durdurur; süre durur ve kart raftan kalkar', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin Admin' });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const adminAccount = await createAdmin();

    const { card, version } = await seedApprovedCard({
      providerId: owner.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: 'E2E Durdurulacak Kart',
    });
    const { placement } = await seedLivePlacement({
      providerId: owner.id,
      cardId: card.id,
      versionId: version.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
    });

    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const visitor = await Actor.open(browser, 'web', primaryRuntime);
    const provider = await Actor.open(browser, 'web', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/showcase/placements/${placement.id}`);
      await assertNoErrorScreen(admin.page);

      await expect(admin.page.getByRole('heading', { name: 'E2E Durdurulacak Kart' })).toBeVisible();

      await admin.page
        .getByRole('textbox', { name: 'Not' })
        .first()
        .fill('İnceleme için geçici durdurma.');
      await admin.page.getByRole('button', { name: 'Yerleşimi durdur' }).click();
      await assertNoErrorScreen(admin.page);

      // The screen says what the clock did, because that is the operationally
      // important half of a suspension.
      await expect(
        admin.page.getByText('Süre işlemiyor', { exact: false }),
      ).toBeVisible();
      await expect(
        admin.page.getByText('Operatör kararı — süre durdu', { exact: false }).first(),
      ).toBeVisible();

      // And the card is off the shelf immediately, not at the next sweep.
      await visitor.gotoWeb('/');
      await assertNoErrorScreen(visitor.page);
      await expect(
        visitor.page.getByText('E2E Durdurulacak Kart', { exact: false }),
      ).toHaveCount(0);

      /*
       * ── And the provider's own screen says the same thing ─────────────────
       *
       * The two panels used to derive a card's state independently — the
       * operator's from the placement row, the provider's from the card status
       * plus a filtered placement list plus an eligibility dry run — and could
       * disagree. Both now read the same resolution, and this is the assertion
       * that keeps them there. Note what the provider is told and what they are
       * not: no raw status, no placement id, and the sentence about the clock,
       * because that is the part that costs them money.
       */
      await provider.loginToWeb(owner.email, owner.password);
      await provider.gotoWeb(`/providers/${owner.id}/vitrin`);
      await assertNoErrorScreen(provider.page);

      await expect(
        provider.page.getByText('Geçici olarak yayında değil'),
      ).toBeVisible();
      await expect(
        provider.page.getByText('durduğu süre yayın sürenize eklenir', { exact: false }),
      ).toBeVisible();
      await expect(provider.page.getByText('SUSPENDED', { exact: false })).toHaveCount(0);
    } finally {
      await admin.close();
      await visitor.close();
      await provider.close();
    }
  });
});
