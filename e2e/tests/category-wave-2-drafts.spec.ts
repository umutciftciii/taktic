import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, prisma } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The second expansion wave on the screens.
 *
 * `apps/api/test/category-import-wave-2.spec.ts` owns what the wave is and what
 * the API will and will not answer with. What only a browser can show is the
 * other half: that the operator reading the readiness panel is told the two
 * things the wave leaves undecided — that nothing is priced, and that two of the
 * services are in regulated work — and that neither sentence exists anywhere a
 * customer or a visitor can reach.
 *
 * The regulated-services warning is the part worth being careful about. It is a
 * list of slugs in the admin app, so its whole safety argument is "the API does
 * not carry this field". A test that only asserted the warning is *shown* would
 * pass just as happily if it had been added to the category entity and rendered
 * from there — so every scenario below also asks the public surfaces whether
 * they have started saying it.
 */

/** The wording the operator reads. Written out rather than imported: the admin app is not on this package's path, and a warning nobody would notice disappearing is not a warning. */
const ELIGIBILITY_WARNING = 'Ek uygunluk incelemesi gerekir';
const NO_PRICE_WARNING = 'Teklif kredisi tanımsız';

/**
 * Three of the wave's services, with the slugs the wave really uses.
 *
 * The slug is the whole point here: the eligibility warning is keyed on it, so
 * a fixture with a generated name would exercise the panel and not the rule.
 * Unpriced, as the import leaves them.
 */
const WAVE_2_GROUP = { slug: 'saglik-ve-wellness', name: 'Sağlık ve Wellness' };

const REGULATED = [
  { slug: 'beslenme-danismanligi', name: 'Beslenme Danışmanlığı' },
  { slug: 'isg-danismanligi', name: 'İSG Danışmanlığı' },
];

const UNREGULATED = { slug: 'mobil-uygulama-gelistirme', name: 'Mobil Uygulama Geliştirme' };

/**
 * Upserted rather than created, so a Playwright retry re-enters the same state
 * instead of failing on a slug that is unique by design.
 */
async function seedWaveTwoDrafts() {
  const groupData = {
    name: WAVE_2_GROUP.name,
    description: 'Kişisel iyilik hali ve yaşam düzeni danışmanlıkları.',
    kind: 'GROUP' as const,
    status: 'DRAFT' as const,
    isActive: false,
    sortOrder: 170,
  };

  const group = await prisma().serviceCategory.upsert({
    where: { slug: WAVE_2_GROUP.slug },
    create: { ...groupData, slug: WAVE_2_GROUP.slug },
    update: groupData,
    select: { id: true, slug: true, name: true },
  });

  for (const service of [...REGULATED, UNREGULATED]) {
    const serviceData = {
      name: service.name,
      description: 'Yayına alınmamış hizmet.',
      kind: 'LEAF' as const,
      status: 'DRAFT' as const,
      isActive: false,
      parentId: group.id,
      sortOrder: 171,
      // The import leaves the whole wave unpriced on purpose, and the panel has
      // to say so.
      offerCreditCost: null,
    };

    await prisma().serviceCategory.upsert({
      where: { slug: service.slug },
      create: { ...serviceData, slug: service.slug },
      update: serviceData,
    });
  }

  return group;
}

let group: Awaited<ReturnType<typeof seedWaveTwoDrafts>>;

test.beforeAll(async () => {
  group = await seedWaveTwoDrafts();
});

test.describe('wave 2 drafts in the admin release panel', () => {
  test('the operator is told what is missing, and the regulated two say so by name', async ({
    browser,
  }) => {
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/categories');
      await assertNoErrorScreen(admin.page);

      for (const service of REGULATED) {
        const row = admin.page.getByTestId(`release-row-${service.slug}`);

        await expect(row, service.slug).toBeVisible();
        await expect(row.getByRole('link', { name: group.name })).toBeVisible();
        // Unpriced, so the wave cannot be released on price alone…
        await expect(row).toContainText(NO_PRICE_WARNING);
        // …and the second sentence, which is the one nothing in the database
        // could have derived.
        await expect(
          row.getByTestId('release-blocker-NEEDS_ELIGIBILITY_REVIEW'),
        ).toContainText(ELIGIBILITY_WARNING);
        await expect(row).toContainText('Hazır değil');
      }

      // The service next to them in the same wave carries the price blocker and
      // not the eligibility one: the warning is about two named services, not
      // about drafts in general.
      const ordinary = admin.page.getByTestId(`release-row-${UNREGULATED.slug}`);
      await expect(ordinary).toContainText(NO_PRICE_WARNING);
      await expect(ordinary).not.toContainText(ELIGIBILITY_WARNING);

      // The tree below the panel, which is the other screen the guarded
      // listing feeds — every wave 2 draft, the group included, under the one
      // account allowed to ask for them.
      const tree = admin.page.getByTestId('category-tree-table');
      for (const category of [WAVE_2_GROUP, ...REGULATED, UNREGULATED]) {
        await expect(
          tree.getByRole('link', { name: category.name, exact: true }),
          category.slug,
        ).toBeVisible();
      }

      // And the same on the screen where the status is actually flipped.
      await admin.gotoAdmin(`/categories/${REGULATED[0]!.slug}`);
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByTestId('release-checklist')).toBeVisible();
      await expect(
        admin.page.getByTestId('release-blocker-NEEDS_ELIGIBILITY_REVIEW'),
      ).toContainText(ELIGIBILITY_WARNING);

      await admin.gotoAdmin(`/categories/${UNREGULATED.slug}`);
      await expect(admin.page.getByTestId('release-blocker-NO_PRICE')).toBeVisible();
      await expect(
        admin.page.getByTestId('release-blocker-NEEDS_ELIGIBILITY_REVIEW'),
      ).toHaveCount(0);
    } finally {
      await admin.close();
    }
  });

  test('a regulated draft can still be invited against', async ({ browser }) => {
    /*
     * The warning is a note to the operator, not a rule the system enforces —
     * and the difference matters. Supply for an unreleased service can only be
     * built by inviting a business to apply for it, so a warning that quietly
     * disabled invitations would leave the two regulated services permanently
     * unstaffable and the eligibility review permanently impossible to conclude.
     *
     * The panel is checked and no link is issued: this asserts the capability,
     * and issuing one would hand out a real credential nobody asked for.
     */
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/categories/${REGULATED[1]!.slug}`);
      await assertNoErrorScreen(admin.page);

      await expect(admin.page.getByTestId('provider-invite-panel')).toBeVisible();
      await expect(admin.page.getByTestId('provider-invite-create')).toBeEnabled();
      await expect(admin.page.getByTestId('provider-invite-closed')).toHaveCount(0);
      // Nothing was issued, so there is nothing in the list.
      await expect(admin.page.getByTestId('provider-invite-issued')).toHaveCount(0);
    } finally {
      await admin.close();
    }
  });
});

test.describe('none of it reaches the customer surfaces', () => {
  test('the wave is absent from the catalogue and its pages 404', async ({ browser }) => {
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      await visitor.gotoWeb('/categories');
      await assertNoErrorScreen(visitor.page);

      const catalogue = (await visitor.page.content()).toLocaleLowerCase('tr-TR');

      for (const service of [...REGULATED, UNREGULATED, WAVE_2_GROUP]) {
        await expect(
          visitor.page.getByRole('link', { name: service.name }),
          service.slug,
        ).toHaveCount(0);
        expect(catalogue, service.slug).not.toContain(service.slug);
      }

      // The operator's sentence, on the page a visitor lands on first.
      expect(catalogue).not.toContain(ELIGIBILITY_WARNING.toLocaleLowerCase('tr-TR'));

      // Knowing a slug is not access. A 404 rather than a 403, so the page does
      // not confirm that an unreleased service exists behind the guess.
      for (const service of [...REGULATED, UNREGULATED, WAVE_2_GROUP]) {
        const response = await visitor.page.goto(
          `${primaryRuntime.webUrl}/categories/${service.slug}`,
        );
        expect(response?.status(), service.slug).toBe(404);

        const body = (await visitor.page.content()).toLocaleLowerCase('tr-TR');
        expect(body, service.slug).not.toContain(ELIGIBILITY_WARNING.toLocaleLowerCase('tr-TR'));
      }
    } finally {
      await visitor.close();
    }
  });

  test('the API says nothing about the eligibility review, to anybody', async ({ browser }) => {
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      for (const path of ['/categories', `/categories/${REGULATED[0]!.slug}`]) {
        const response = await visitor.page.request.get(`${primaryRuntime.apiUrl}${path}`);
        const body = (await response.text()).toLocaleLowerCase('tr-TR');

        expect(body).not.toContain('uygunluk');
        expect(body).not.toContain(REGULATED[0]!.slug);
      }
    } finally {
      await visitor.close();
    }
  });
});
