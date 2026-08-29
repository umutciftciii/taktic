import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createProvider,
  prisma,
  uniqueLocation,
} from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The operator attaching a provider to an unreleased service, on the screens.
 *
 * `apps/api/test/provider-draft-category-binding.spec.ts` owns the rules; this
 * owns the two things only a browser can show. First, that the readiness panel
 * a release is signed off on actually moves when an operator does the work —
 * the number and the act of producing it are on different screens, and a count
 * that did not refresh would be read as "still nobody behind this". Second,
 * that the provider on the other end of that binding is told nothing: the draft
 * category's name and slug are the unreleased catalogue, and the provider's own
 * panel is the surface with the strongest claim to leak them.
 *
 * There is deliberately no signed-out case here. The web app has no public
 * provider page — `/providers/[id]` is the provider's own panel and sends a
 * visitor to the sign-in screen — so the public projection is an API shape with
 * no browser to check it in, and the API spec pins it at the HTTP boundary.
 */

/** A draft service under a draft group, which is the shape a wave lands in. */
async function draftServiceUnderGroup(namePrefix: string, offerCreditCost: number) {
  // A group takes no request and carries no price, but the database refuses a
  // non-positive one, so it gets a 1 that nothing ever reads.
  const group = await createCategory(1, { kind: 'GROUP', status: 'DRAFT', namePrefix: 'E2E Grup' });
  const service = await createCategory(offerCreditCost, { status: 'DRAFT', namePrefix });

  await prisma().serviceCategory.update({
    where: { id: service.id },
    data: { parentId: group.id },
  });

  return { group, service };
}

test.describe('binding a provider to a draft category', () => {
  test('an operator attaches an approved provider and the readiness panel says so', async ({
    browser,
  }) => {
    const { service } = await draftServiceUnderGroup('E2E Taslak Bag', 4);
    // The provider is seeded against a live category, which is the only kind
    // they could ever have chosen themselves. The draft is added below, through
    // the product, because that is the thing under test.
    const liveCategory = await createCategory(3);
    const providerAccount = await createProvider({
      categoryId: liveCategory.id,
      location: uniqueLocation(),
      credits: 0,
    });
    const adminAccount = await createAdmin();

    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);

      // Before: the draft is on the checklist and has nobody behind it.
      await admin.gotoAdmin('/categories');
      const rowBefore = admin.page.getByTestId(`release-row-${service.slug}`);
      await expect(rowBefore).toContainText('Hazır değil');
      await expect(rowBefore).toContainText('Onaylı hizmet veren yok');

      await admin.gotoAdmin(`/providers/${providerAccount.id}`);
      await assertNoErrorScreen(admin.page);

      // Found by searching, because the catalogue is longer than a page of
      // buttons and searching is how an operator actually reaches one row.
      await admin.page.getByTestId('provider-category-search').fill(service.name);
      await admin.page.getByRole('button', { name: 'Ara' }).click();

      const addButton = admin.page
        .getByTestId(`provider-category-add-${service.slug}`)
        .getByRole('button');
      await expect(addButton).toBeVisible();
      await addButton.click();

      await expect(admin.page.getByTestId('provider-category-notice')).toContainText(
        'bağlandı',
      );
      const binding = admin.page.getByTestId(`provider-category-${service.slug}`);
      await expect(binding).toContainText('Taslak');
      await expect(binding).toContainText('Hazırlık sayacına dahil');

      // The screen's half of the idempotency promise: an already-bound category
      // stops being offered, so the operator cannot even ask for the duplicate.
      // The API refusing one when it *is* asked for is pinned in
      // apps/api/test/provider-draft-category-binding.spec.ts.
      await admin.page.getByTestId('provider-category-search').fill(service.name);
      await admin.page.getByRole('button', { name: 'Ara' }).click();
      await expect(
        admin.page.getByTestId(`provider-category-add-${service.slug}`),
      ).toHaveCount(0);

      // After: the same panel, the same row, a different verdict.
      await admin.gotoAdmin('/categories');
      const rowAfter = admin.page.getByTestId(`release-row-${service.slug}`);
      await expect(rowAfter).not.toContainText('Onaylı hizmet veren yok');
      await expect(rowAfter.getByText('Hazır', { exact: true })).toBeVisible();

      await admin.gotoAdmin(`/categories/${service.slug}`);
      await expect(admin.page.getByTestId('release-checklist')).toBeVisible();
      await expect(admin.page.getByTestId('release-blockers')).toHaveCount(0);
    } finally {
      await admin.close();
    }
  });

  test('a pending provider can be attached and is told the count did not move', async ({
    browser,
  }) => {
    const { service } = await draftServiceUnderGroup('E2E Onaysiz Bag', 5);
    const liveCategory = await createCategory(3);
    const providerAccount = await createProvider({
      categoryId: liveCategory.id,
      location: uniqueLocation(),
      credits: 0,
    });
    // The one fact the readiness count turns on. Set directly rather than
    // through moderation: this test is about what the screen says, not about
    // how a profile gets its status.
    await prisma().providerProfile.update({
      where: { id: providerAccount.id },
      data: { status: 'PENDING_REVIEW' },
    });
    const adminAccount = await createAdmin();

    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/providers/${providerAccount.id}`);

      await admin.page.getByTestId('provider-category-search').fill(service.name);
      await admin.page.getByRole('button', { name: 'Ara' }).click();
      await admin.page
        .getByTestId(`provider-category-add-${service.slug}`)
        .getByRole('button')
        .click();

      // Bound, and said out loud to be inert. An operator who is not told this
      // goes looking for a bug in the counter.
      await expect(admin.page.getByTestId(`provider-category-${service.slug}`)).toContainText(
        'Sayaca dahil değil',
      );
      await expect(admin.page.getByTestId('provider-category-not-counted')).toContainText(
        'sayılmaz',
      );

      await admin.gotoAdmin('/categories');
      await expect(admin.page.getByTestId(`release-row-${service.slug}`)).toContainText(
        'Onaylı hizmet veren yok',
      );
    } finally {
      await admin.close();
    }
  });

  test('the provider is never shown the draft they were attached to', async ({ browser }) => {
    const { service } = await draftServiceUnderGroup('E2E Gizli Taslak', 4);
    const liveCategory = await createCategory(3);
    const providerAccount = await createProvider({
      categoryId: liveCategory.id,
      location: uniqueLocation(),
      credits: 0,
    });
    // Seeded straight into the table: this test is about what the provider's
    // screens do with an existing binding, and going through the admin UI to
    // create it would only re-test the case above.
    await prisma().providerServiceCategory.create({
      data: { providerId: providerAccount.id, categoryId: service.id },
    });

    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);

      // The two screens that print a provider's service list: the profile, and
      // the form they edit it on. The live category is asserted present on both
      // so "nothing leaked" cannot pass because nothing rendered.
      for (const path of [
        `/providers/${providerAccount.id}`,
        `/providers/${providerAccount.id}/edit`,
      ]) {
        await provider.gotoWeb(path);
        await assertNoErrorScreen(provider.page);

        const body = await provider.page.locator('body').innerText();
        expect(body).not.toContain(service.name);
        expect(body).not.toContain(service.slug);
        expect(body).toContain(liveCategory.name);
      }

      // The panel itself prints no service list, so this is a negative check
      // only — and it is the screen a provider actually lives on.
      await provider.gotoWeb('/providers/me');
      await assertNoErrorScreen(provider.page);
      const panel = await provider.page.locator('body').innerText();
      expect(panel).not.toContain(service.name);
      expect(panel).not.toContain(service.slug);
    } finally {
      await provider.close();
    }
  });
});
