import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCategory, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The screens somebody reads before releasing a draft service.
 *
 * A draft category is easy to release and hard to un-release: the moment it is
 * ACTIVE it is on the customer catalogue and taking requests. The two things
 * that make a released category *silently* useless — no offer price, and no
 * approved provider behind it — are not visible anywhere the customer or the
 * provider would notice, which is why they have to be visible here.
 *
 * The rows are addressed by their own test ids because the readiness list holds
 * every draft in the database, and the rest of this suite creates drafts of its
 * own.
 */

/** A draft service under a group, which is the shape the expansion waves land in. */
async function draftServiceUnderGroup(namePrefix: string, offerCreditCost: number) {
  // The group's own price is never read — a group takes no request and carries
  // no offer — but the database refuses a non-positive one, so it gets a 1.
  const group = await createCategory(1, { kind: 'GROUP', status: 'DRAFT', namePrefix: 'E2E Grup' });
  const service = await createCategory(offerCreditCost, {
    status: 'DRAFT',
    namePrefix,
  });

  await prisma().serviceCategory.update({
    where: { id: service.id },
    data: { parentId: group.id },
  });

  return { group, service };
}

test.describe('release readiness', () => {
  test('a draft with no provider behind it is listed as not ready, and says why', async ({
    browser,
  }) => {
    const { group, service } = await draftServiceUnderGroup('E2E Hazir Degil', 4);
    const adminAccount = await createAdmin();

    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/categories');
      await assertNoErrorScreen(admin.page);

      const row = admin.page.getByTestId(`release-row-${service.slug}`);
      await expect(row).toBeVisible();

      // The facts a release decision is made on, on one row: where it hangs,
      // and the verdict that follows from having nobody to answer a request.
      await expect(row.getByRole('link', { name: group.name })).toBeVisible();
      await expect(row).toContainText('Hazır değil');
      await expect(row).toContainText('Onaylı hizmet veren yok');

      // And the same verdict, with the two numbers behind it, on the screen
      // where the status is actually flipped.
      await admin.gotoAdmin(`/categories/${service.slug}`);
      const checklist = admin.page.getByTestId('release-checklist');
      await expect(checklist).toBeVisible();
      await expect(checklist).toContainText('4');
      await expect(checklist).toContainText('Hazır değil');
      await expect(admin.page.getByTestId('release-blockers')).toContainText(
        'Onaylı hizmet veren yok',
      );
    } finally {
      await admin.close();
    }
  });

  test('the same draft reads as ready once an approved provider is attached', async ({
    browser,
  }) => {
    const { service } = await draftServiceUnderGroup('E2E Hazir Olacak', 3);
    await createProvider({ categoryId: service.id, location: uniqueLocation(), credits: 0 });
    const adminAccount = await createAdmin();

    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/categories');
      await assertNoErrorScreen(admin.page);

      const row = admin.page.getByTestId(`release-row-${service.slug}`);
      await expect(row).toBeVisible();
      // "Hazır değil" contains "Hazır", so the verdict is read as a whole cell
      // rather than as a substring of the row.
      await expect(row.getByText('Hazır', { exact: true })).toBeVisible();
      await expect(row).not.toContainText('Hazır değil');

      await admin.gotoAdmin(`/categories/${service.slug}`);
      // Nothing is blocking it, so there is no blocker list to read.
      await expect(admin.page.getByTestId('release-checklist')).toBeVisible();
      await expect(admin.page.getByTestId('release-blockers')).toHaveCount(0);
    } finally {
      await admin.close();
    }
  });
});
