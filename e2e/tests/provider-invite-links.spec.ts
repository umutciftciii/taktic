import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createSelectQuestion,
  prisma,
  uniqueLocation,
  uniqueSuffix,
} from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * Recruiting one business for a service the marketplace has not released.
 *
 * `apps/api/test/provider-invite-links.spec.ts` owns the rules. This owns the
 * things only a browser can show, and each of them is a rule that lives in the
 * *rendering* rather than in the API:
 *
 *   - the link is shown once and cannot be recovered by refreshing. The API's
 *     half of that promise is "no endpoint returns it twice"; the screen's half
 *     is that it never puts the link anywhere a reload could read it back — not
 *     a URL, not a cookie, not the list underneath. That is only checkable by
 *     reloading a real page.
 *   - the invited screen shows one fact about an unreleased service. The API
 *     returns only a name, but the page is where the description, the question
 *     set and the price would have leaked if anything had loaded the category
 *     the ordinary way.
 *   - a dead link renders as the site's ordinary 404, indistinguishable from a
 *     mistyped URL. A status code is not the promise; the screen is.
 *   - the readiness panel counts the invitation as sourcing and not as supply,
 *     which is a sentence on a screen rather than a number in a response.
 *
 * The whole run is on the shipped default stack. Nothing here depends on the
 * claim flag: an invited application is a guest application, and what happens to
 * it afterwards is provider-claim.spec.ts's subject, not this file's.
 */

/** A draft service carrying everything the invited screen must not show. */
async function draftServiceWithSecrets(namePrefix: string) {
  const service = await createCategory(4, { status: 'DRAFT', namePrefix });

  await prisma().serviceCategory.update({
    where: { id: service.id },
    data: { description: 'Bu aciklama yalnizca yoneticiye aittir.' },
  });
  await createSelectQuestion({
    categoryId: service.id,
    key: 'gizli-soru',
    label: 'Gizli musteri sorusu',
    options: [{ key: 'evet', label: 'Evet' }],
  });

  return service;
}

/**
 * Issues a link through the admin screen and reads it off the page.
 *
 * Reading it from the rendered field rather than from the database is the
 * point: the operator's copy of the link is the *only* copy anybody will ever
 * have, so a test that reconstructed it from a token would be testing a path
 * the product does not have.
 */
async function issueInviteUrl(admin: Actor, categorySlug: string): Promise<string> {
  await admin.gotoAdmin(`/categories/${categorySlug}`);
  await assertNoErrorScreen(admin.page);

  await admin.page.getByTestId('provider-invite-create').click();

  const field = admin.page.getByTestId('provider-invite-url');
  await expect(field).toBeVisible();

  const url = await field.inputValue();
  expect(url).toContain('/provider-invite/');

  return url;
}

/** Fills and submits the invited application form. */
async function submitInvitedApplication(
  page: Page,
  values: { businessName: string; city: string; district: string },
): Promise<void> {
  const form = page.locator('form.provider-apply-form');
  await form.locator('input[name="businessName"]').fill(values.businessName);
  await form.locator('input[name="contactName"]').fill('E2E Davetli Yetkili');
  await form.locator('input[name="phone"]').fill('05551119988');
  await form.locator('input[name="email"]').fill(`e2e-invite-${uniqueSuffix()}@example.test`);
  await form.locator('select[name="city"]').selectOption(values.city);
  await form.locator('select[name="district"]').selectOption(values.district);
  // The service area is chosen and then added, which is what makes it one of a
  // list: the form posts nothing for an area that was picked and never added.
  await form.getByTestId('service-area-city').selectOption(values.city);
  await form.getByTestId('service-area-district').selectOption(values.district);
  await form.getByTestId('service-area-add').click();

  await form.getByRole('button', { name: 'Başvuruyu Gönder' }).click();
}

test.describe('provider application invitations', () => {
  test('an operator issues a link once and a business applies through it', async ({ browser }) => {
    const service = await draftServiceWithSecrets('E2E Davet Hizmeti');
    const adminAccount = await createAdmin();
    const location = uniqueLocation();
    const businessName = `E2E Davetli ${uniqueSuffix()}`;

    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const invited = await Actor.open(browser, 'invited', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);

      // Before: the draft is on the release checklist with nobody behind it and
      // nobody approached.
      await admin.gotoAdmin('/categories');
      const rowBefore = admin.page.getByTestId(`release-row-${service.slug}`);
      await expect(rowBefore).toContainText('Hazır değil');
      await expect(admin.page.getByTestId(`release-invites-${service.slug}`)).toHaveText('0');

      const url = await issueInviteUrl(admin, service.slug);

      // The list underneath now has a row, and the row does not carry the link.
      await expect(admin.page.getByTestId('provider-invite-count')).toContainText('1 geçerli');
      const token = url.split('/').at(-1) as string;
      await expect(admin.page.getByTestId('provider-invite-list')).not.toContainText(token);

      // Shown once, and the page is the thing that has to prove it: after a
      // reload the field is gone and the token appears nowhere in the HTML.
      await admin.page.reload({ waitUntil: 'domcontentloaded' });
      await expect(admin.page.getByTestId('provider-invite-url')).toHaveCount(0);
      expect(await admin.page.content()).not.toContain(token);

      // The invited business, in its own browser context and signed in as
      // nobody, follows the link.
      await invited.page.goto(url, { waitUntil: 'domcontentloaded' });
      await assertNoErrorScreen(invited.page);

      await expect(
        invited.page.getByRole('heading', { name: 'Bu hizmet için başvuru davetiniz var' }),
      ).toBeVisible();
      await expect(invited.page.getByTestId('invite-category')).toHaveText(service.name);
      // The brand, from the shared site chrome rather than from anything this
      // page invents — the invited business has to be able to tell whose
      // marketplace just asked them for their tax number.
      await expect(
        invited.page.getByRole('banner').getByRole('link', { name: 'TakTick ana sayfa' }),
      ).toBeVisible();

      // One fact about the service and no more: not its description, not the
      // questions its customers will answer, not what an offer will cost.
      const body = await invited.page.locator('body').innerText();
      expect(body).not.toContain('yalnizca yoneticiye');
      expect(body).not.toContain('Gizli musteri sorusu');
      expect(body).not.toContain(service.slug);
      // The category picker the open form has is absent: the binding is the
      // server's, so there is no control here to change it.
      await expect(invited.page.locator('input[name="categoryIds"]')).toHaveCount(0);

      await submitInvitedApplication(invited.page, {
        businessName,
        city: location.city,
        district: location.district,
      });

      await expect(invited.page).toHaveURL(/\/providers\/success$/);
      await assertNoErrorScreen(invited.page);

      // Single use, on the screen: the same link now renders the site's
      // ordinary "page not found", which is what a mistyped URL renders too.
      await invited.page.goto(url, { waitUntil: 'domcontentloaded' });
      await expectNotFoundScreen(invited.page);

      // The application landed, bound to the draft, and nobody owns it yet.
      const applicant = await prisma().providerProfile.findFirstOrThrow({
        where: { businessName },
        select: { id: true, userId: true, status: true, serviceCategories: true },
      });
      expect(applicant.userId).toBeNull();
      expect(applicant.serviceCategories.map((binding) => binding.categoryId)).toEqual([
        service.id,
      ]);

      // The operator's list says the link was used, and the readiness panel is
      // unmoved: somebody applied, nobody is approved, and the service is still
      // not ready. A count that had gone green here would be the whole release
      // decision made on a form submission.
      await admin.gotoAdmin(`/categories/${service.slug}`);
      await expect(admin.page.getByTestId('provider-invite-list')).toContainText('Kullanıldı');
      await expect(admin.page.getByTestId('provider-invite-count')).toContainText('0 geçerli');
      await expect(admin.page.getByTestId('release-blockers')).toContainText(
        'Onaylı hizmet veren yok',
      );

      // Approving the applicant is what moves it, with no re-binding.
      await admin.gotoAdmin(`/providers/${applicant.id}`);
      await assertNoErrorScreen(admin.page);
      await admin.page.getByTestId('provider-category-list');
      await prisma().providerProfile.update({
        where: { id: applicant.id },
        data: { status: 'APPROVED' },
      });

      await admin.gotoAdmin('/categories');
      const rowAfter = admin.page.getByTestId(`release-row-${service.slug}`);
      await expect(rowAfter.getByText('Hazır', { exact: true })).toBeVisible();
    } finally {
      await invited.close();
      await admin.close();
    }
  });

  test('a withdrawn link stops working, and the draft never reaches the catalogue', async ({
    browser,
  }) => {
    const service = await draftServiceWithSecrets('E2E Iptal Daveti');
    const adminAccount = await createAdmin();

    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      const url = await issueInviteUrl(admin, service.slug);

      // Live first, so the refusal below is the revoke and not the link never
      // having worked.
      await visitor.page.goto(url, { waitUntil: 'domcontentloaded' });
      await expect(visitor.page.getByTestId('invite-category')).toHaveText(service.name);

      const inviteRow = admin.page.getByTestId('provider-invite-list').locator('li').first();
      await expect(inviteRow).toContainText('Geçerli');
      await inviteRow.getByRole('button', { name: 'İptal et' }).click();

      await expect(admin.page.getByTestId('provider-invite-revoked')).toBeVisible();
      await expect(admin.page.getByTestId('provider-invite-list')).toContainText('İptal edildi');
      await expect(admin.page.getByTestId('provider-invite-count')).toContainText('0 geçerli');

      await visitor.page.goto(url, { waitUntil: 'domcontentloaded' });
      await expectNotFoundScreen(visitor.page);

      // Nothing about issuing, following or withdrawing a link widened the
      // customer catalogue. The draft is still absent from the listing, and its
      // own page is still the 404 a stranger gets for a service that has not
      // been released.
      await visitor.gotoWeb('/categories');
      await assertNoErrorScreen(visitor.page);
      expect(await visitor.page.locator('body').innerText()).not.toContain(service.name);

      await visitor.gotoWeb(`/categories/${service.slug}`);
      await expectNotFoundScreen(visitor.page);
    } finally {
      await visitor.close();
      await admin.close();
    }
  });
});
