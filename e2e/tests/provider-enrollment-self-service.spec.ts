import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCategory, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The repairer this feature was built for: they find the marketplace, open the
 * application form, and the service they actually do is one the marketplace has
 * not released yet.
 *
 * Two halves, and both matter. They can tick it — that is the supply problem
 * being solved — and their own panel then says what they joined, because a
 * category that disappears the moment it is chosen reads as a bug rather than
 * as a release process.
 */

test.describe('signing up for an unreleased service', () => {
  test('an applicant is offered an opened draft, told it is not open yet, and never shown a closed one', async ({
    browser,
  }) => {
    const openDraft = await createCategory(4, {
      status: 'DRAFT',
      namePrefix: 'E2E Acik Taslak',
      providerEnrollmentOpen: true,
    });
    const closedDraft = await createCategory(4, {
      status: 'DRAFT',
      namePrefix: 'E2E Kapali Taslak',
    });

    // Signed out on purpose: this is the applicant with no account yet, and the
    // form they land on is the one this endpoint exists to feed.
    const applicant = await Actor.open(browser, 'web', primaryRuntime);

    try {
      await applicant.gotoWeb('/providers/register');
      await assertNoErrorScreen(applicant.page);

      const openChip = applicant.page.locator('.check-chip', { hasText: openDraft.name });
      await expect(openChip).toBeVisible();
      await expect(openChip).toContainText('Yakında açılacak');

      // A draft nobody opened is not on the form at all.
      await expect(
        applicant.page.locator('.check-chip', { hasText: closedDraft.name }),
      ).toHaveCount(0);
    } finally {
      await applicant.close();
    }
  });

  test('the provider panel lists it as upcoming, with no supply figure', async ({ browser }) => {
    const openDraft = await createCategory(4, {
      status: 'DRAFT',
      namePrefix: 'E2E Panel Taslak',
      providerEnrollmentOpen: true,
    });
    const liveCategory = await createCategory(3);
    const providerAccount = await createProvider({
      categoryId: liveCategory.id,
      location: uniqueLocation(),
      credits: 0,
    });

    await prisma().providerServiceCategory.create({
      data: { providerId: providerAccount.id, categoryId: openDraft.id },
    });

    const provider = await Actor.open(browser, 'web', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb(`/providers/${providerAccount.id}`);
      await assertNoErrorScreen(provider.page);

      await expect(provider.page.getByTestId('upcoming-service-categories')).toContainText(
        openDraft.name,
      );
      await expect(
        provider.page.getByText('Yakında açılacak — henüz talep alamaz.'),
      ).toBeVisible();

      // The operational figures stay on the operator's panel.
      const body = await provider.page.locator('body').innerText();
      expect(body).not.toContain('Onaylı hizmet veren');
      expect(body).not.toContain('Yayına hazır');
    } finally {
      await provider.close();
    }
  });

  test('a profile save keeps the upcoming service the provider chose', async ({ browser }) => {
    const openDraft = await createCategory(4, {
      status: 'DRAFT',
      namePrefix: 'E2E Kalici Taslak',
      providerEnrollmentOpen: true,
    });
    const liveCategory = await createCategory(3);
    const providerAccount = await createProvider({
      categoryId: liveCategory.id,
      location: uniqueLocation(),
      credits: 0,
    });

    await prisma().providerServiceCategory.create({
      data: { providerId: providerAccount.id, categoryId: openDraft.id },
    });

    const provider = await Actor.open(browser, 'web', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      // The edit form pre-ticks both lists; saving it unchanged must not quietly
      // drop the draft, which is what it would do if the form read only the
      // live one.
      await provider.gotoWeb(`/providers/${providerAccount.id}/edit`);
      await assertNoErrorScreen(provider.page);

      const draftBox = provider.page
        .locator('.check-chip', { hasText: openDraft.name })
        .locator('input');
      await expect(draftBox).toBeChecked();

      await provider.page.getByRole('button', { name: 'Profili Kaydet' }).click();

      await provider.gotoWeb(`/providers/${providerAccount.id}`);
      await expect(provider.page.getByTestId('upcoming-service-categories')).toContainText(
        openDraft.name,
      );
    } finally {
      await provider.close();
    }
  });
});
