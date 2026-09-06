import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createCategory,
  createProvider,
  prisma,
  uniqueLocation,
  uniquePhone,
  uniqueSuffix,
} from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The provider application's location fields, driven the way an applicant
 * drives them.
 *
 * These were the last free-text place names in the product, and the ones that
 * cost the most when they were wrong: discovery compares a provider's service
 * area against a request's city and district as text, so a typo here made the
 * business invisible to every request in its own district. The API refuses an
 * impossible pair on its own — `apps/api/test/provider-location.spec.ts` posts
 * the tampered bodies — and this covers what the form itself allows.
 */
test.describe('provider application location', () => {
  test('province and district cascade, and the district clears when the province changes', async ({
    browser,
  }) => {
    const applicant = await Actor.open(browser, 'applicant', primaryRuntime);

    try {
      await applicant.gotoWeb('/providers/register');
      await expect(
        applicant.page.getByRole('heading', { name: 'Hizmet Veren Başvurusu' }),
      ).toBeVisible();

      const form = applicant.page.locator('form.provider-apply-form');
      const city = form.getByTestId('location-city-city');
      const district = form.getByTestId('location-district-district');

      // Nothing below the province can be chosen before the province is.
      await expect(district).toBeDisabled();

      await city.selectOption('İstanbul');
      await expect(district).toBeEnabled();

      const istanbulDistricts = await district.locator('option').allTextContents();
      expect(istanbulDistricts).toContain('Kadıköy');
      expect(istanbulDistricts).not.toContain('Çankaya');

      await district.selectOption('Kadıköy');
      await expect(district).toHaveValue('Kadıköy');

      // Changing the province clears what hung off it, rather than leaving an
      // İstanbul district under Ankara.
      await city.selectOption('Ankara');
      await expect(district).toHaveValue('');
      const ankaraDistricts = await district.locator('option').allTextContents();
      expect(ankaraDistricts).toContain('Çankaya');
      expect(ankaraDistricts).not.toContain('Kadıköy');

      // The service area is three dependent selects of its own, and both levels
      // below the province stay optional: a province alone means the whole
      // province, a district alone the whole district.
      const areaCity = form.getByTestId('service-area-city');
      const areaDistrict = form.getByTestId('service-area-district');
      const areaNeighborhood = form.getByTestId('service-area-neighborhood');
      await expect(areaDistrict).toBeDisabled();
      await expect(areaNeighborhood).toBeDisabled();
      await expect(areaDistrict).not.toHaveAttribute('required', '');

      await areaCity.selectOption('İstanbul');
      await expect(areaDistrict).toBeEnabled();
      // Still no free text anywhere: the neighbourhood is a select that only
      // opens once a district names which list it should hold.
      await expect(areaNeighborhood).toBeDisabled();

      await areaDistrict.selectOption('Kadıköy');
      await expect(areaNeighborhood).toBeEnabled();
      const neighborhoods = await areaNeighborhood.locator('option').allTextContents();
      expect(neighborhoods).toContain('Caferağa Mah');
      expect(neighborhoods).not.toContain('Kızılay Mah');
    } finally {
      await applicant.close();
    }
  });

  test('several areas can be added and removed, and the covered ones are refused', async ({
    browser,
  }) => {
    const applicant = await Actor.open(browser, 'applicant', primaryRuntime);

    try {
      await applicant.gotoWeb('/providers/register');
      const form = applicant.page.locator('form.provider-apply-form');
      const areaCity = form.getByTestId('service-area-city');
      const areaDistrict = form.getByTestId('service-area-district');
      const areaNeighborhood = form.getByTestId('service-area-neighborhood');
      const add = form.getByTestId('service-area-add');
      const list = form.getByTestId('service-area-list');

      await expect(list).toContainText('Henüz bölge eklemediniz');

      // A whole province.
      await areaCity.selectOption('Ankara');
      await add.click();
      await expect(list).toContainText('Ankara geneli');

      // A district of another province, and a neighbourhood inside it.
      await areaCity.selectOption('İstanbul');
      await areaDistrict.selectOption('Beşiktaş');
      await add.click();
      await expect(list).toContainText('Beşiktaş, İstanbul');

      await areaCity.selectOption('İstanbul');
      await areaDistrict.selectOption('Kadıköy');
      await areaNeighborhood.selectOption('Caferağa Mah');
      await add.click();
      await expect(list).toContainText('Caferağa Mah, Kadıköy, İstanbul');

      // The same area again, refused by name.
      await areaCity.selectOption('Ankara');
      await add.click();
      await expect(form.getByTestId('service-area-error')).toContainText('Ankara geneli zaten ekli');

      // A district under a province already covered whole, refused for the
      // other reason — and the message says which area is in the way.
      await areaCity.selectOption('Ankara');
      await areaDistrict.selectOption('Çankaya');
      await add.click();
      await expect(form.getByTestId('service-area-error')).toContainText(
        'Ankara geneli bu bölgeyi zaten kapsıyor',
      );

      // Nothing was added by either refusal.
      await expect(form.locator('input[name="serviceAreas"]')).toHaveCount(3);

      await form.getByRole('button', { name: 'Beşiktaş, İstanbul bölgesini kaldır' }).click();
      await expect(list).not.toContainText('Beşiktaş, İstanbul');
      await expect(form.locator('input[name="serviceAreas"]')).toHaveCount(2);
    } finally {
      await applicant.close();
    }
  });

  test('the service area section fits a 320px screen', async ({ browser }) => {
    const applicant = await Actor.open(browser, 'applicant', primaryRuntime);

    try {
      await applicant.page.setViewportSize({ width: 320, height: 720 });
      await applicant.gotoWeb('/providers/register');
      const form = applicant.page.locator('form.provider-apply-form');

      await form.getByTestId('service-area-city').selectOption('İstanbul');
      await form.getByTestId('service-area-district').selectOption('Kadıköy');
      await form.getByTestId('service-area-add').click();
      await expect(form.getByTestId('service-area-list')).toContainText('Kadıköy, İstanbul');

      // Nothing in the document may be wider than the viewport: a select or a
      // chip that overflows takes the whole page sideways with it.
      const overflow = await applicant.page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await applicant.close();
    }
  });

  test('an application is stored with the canonical names that were chosen', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(3);
    const businessName = `E2E Konum İşletmesi ${uniqueSuffix()}`;
    const applicant = await Actor.open(browser, 'applicant', primaryRuntime);

    try {
      await applicant.gotoWeb('/providers/register');
      const form = applicant.page.locator('form.provider-apply-form');

      await form.locator('input[name="businessName"]').fill(businessName);
      await form.locator('input[name="contactName"]').fill('E2E Yetkili');
      await form.locator('input[name="phone"]').fill(uniquePhone());
      await form.locator('select[name="city"]').selectOption(location.city);
      await form.locator('select[name="district"]').selectOption(location.district);
      await form.locator(`input[name="categoryIds"][value="${category.id}"]`).check();
      await form.getByTestId('service-area-city').selectOption(location.city);
      await form.getByTestId('service-area-district').selectOption(location.district);
      await form.getByTestId('service-area-add').click();
      // A second area, a whole province away from the first, so what is stored
      // proves the form posts a list rather than the one area it used to carry.
      // Chosen against the allocated district's province, because a province
      // that covered it would be refused rather than added.
      const wholeProvince = location.city === 'Ankara' ? 'İstanbul' : 'Ankara';
      await form.getByTestId('service-area-city').selectOption(wholeProvince);
      await form.getByTestId('service-area-add').click();

      await form.getByRole('button', { name: 'Başvuruyu Gönder' }).click();
      await expect(applicant.page).toHaveURL(/\/providers\/success$/);
      await assertNoErrorScreen(applicant.page);

      const stored = await prisma().providerProfile.findFirstOrThrow({
        where: { businessName },
        select: { city: true, district: true, serviceAreas: true },
      });
      expect(stored.city).toBe(location.city);
      expect(stored.district).toBe(location.district);
      // Both areas, each stored at the scope its levels imply — the province-wide
      // one with no district at all, which is how "all of X" is written down.
      expect(
        stored.serviceAreas
          .map((area) => ({
            scope: area.scope,
            city: area.city,
            district: area.district,
            neighborhood: area.neighborhood,
          }))
          .sort((a, b) => a.city.localeCompare(b.city, 'tr-TR')),
      ).toEqual(
        [
          {
            scope: 'DISTRICT',
            city: location.city,
            district: location.district,
            neighborhood: null,
          },
          { scope: 'CITY', city: wholeProvince, district: null, neighborhood: null },
        ].sort((a, b) => a.city.localeCompare(b.city, 'tr-TR')),
      );
    } finally {
      await applicant.close();
    }
  });
});

/**
 * The same editor on the provider's own profile, where the areas are not new —
 * they are the coverage the business already has, and a save that dropped one
 * would take the business off requests it is currently being shown.
 */
test.describe('provider profile service areas', () => {
  test('an existing area is shown, and areas can be added and removed', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(3);
    const seeded = await createProvider({ categoryId: category.id, location, credits: 0 });
    const provider = await Actor.open(browser, 'area-editor', primaryRuntime);

    try {
      await provider.loginToWeb(seeded.email, seeded.password);
      await provider.gotoWeb(`/providers/${seeded.id}/edit`);

      const form = provider.page.locator('form.pdash-form');
      const list = form.getByTestId('service-area-list');

      // The one area the profile was seeded with, on screen as itself.
      await expect(list).toContainText(`${location.district}, ${location.city}`);

      // A second province, added.
      const wholeProvince = location.city === 'Ankara' ? 'İstanbul' : 'Ankara';
      await form.getByTestId('service-area-city').selectOption(wholeProvince);
      await form.getByTestId('service-area-add').click();
      await expect(list).toContainText(`${wholeProvince} geneli`);

      await form.getByRole('button', { name: 'Profili Kaydet' }).click();
      await expect(provider.page).toHaveURL(new RegExp(`/providers/${seeded.id}$`));
      await assertNoErrorScreen(provider.page);

      const afterAdd = await prisma().providerServiceArea.findMany({
        where: { providerId: seeded.id },
        select: { scope: true, city: true, district: true },
      });
      expect(afterAdd).toHaveLength(2);
      expect(afterAdd).toContainEqual({
        scope: 'DISTRICT',
        city: location.city,
        district: location.district,
      });
      expect(afterAdd).toContainEqual({ scope: 'CITY', city: wholeProvince, district: null });

      // And removed again, from the same screen.
      await provider.gotoWeb(`/providers/${seeded.id}/edit`);
      await form
        .getByRole('button', { name: `${wholeProvince} geneli bölgesini kaldır` })
        .click();
      await form.getByRole('button', { name: 'Profili Kaydet' }).click();
      await expect(provider.page).toHaveURL(new RegExp(`/providers/${seeded.id}$`));

      const afterRemove = await prisma().providerServiceArea.findMany({
        where: { providerId: seeded.id },
        select: { scope: true, city: true, district: true },
      });
      expect(afterRemove).toEqual([
        { scope: 'DISTRICT', city: location.city, district: location.district },
      ]);
    } finally {
      await provider.close();
    }
  });

  test('an overlapping pair inherited from before is shown, saves untouched, and can be removed', async ({
    browser,
  }) => {
    // The shape the migration deliberately left alone: a whole province beside
    // a district inside it. The API refuses a *new* overlap; this one is on
    // file, so the screen has to show both and the form has to save.
    const location = uniqueLocation();
    const category = await createCategory(3);
    const seeded = await createProvider({ categoryId: category.id, location, credits: 0 });
    await prisma().providerServiceArea.create({
      data: { providerId: seeded.id, scope: 'CITY', city: location.city, district: null },
    });
    const provider = await Actor.open(browser, 'area-overlap', primaryRuntime);

    try {
      await provider.loginToWeb(seeded.email, seeded.password);
      await provider.gotoWeb(`/providers/${seeded.id}/edit`);

      const form = provider.page.locator('form.pdash-form');
      const list = form.getByTestId('service-area-list');
      await expect(list).toContainText(`${location.city} geneli`);
      await expect(list).toContainText(`${location.district}, ${location.city}`);

      // Saved without touching the areas at all.
      await form.getByRole('button', { name: 'Profili Kaydet' }).click();
      await expect(provider.page).toHaveURL(new RegExp(`/providers/${seeded.id}$`));
      await assertNoErrorScreen(provider.page);
      expect(
        await prisma().providerServiceArea.count({ where: { providerId: seeded.id } }),
      ).toBe(2);

      // The redundant half comes off when the provider decides it should, one
      // row at a time, from the same list.
      await provider.gotoWeb(`/providers/${seeded.id}/edit`);
      await form
        .getByRole('button', { name: `${location.district}, ${location.city} bölgesini kaldır` })
        .click();
      await form.getByRole('button', { name: 'Profili Kaydet' }).click();
      await expect(provider.page).toHaveURL(new RegExp(`/providers/${seeded.id}$`));

      expect(
        await prisma().providerServiceArea.findMany({
          where: { providerId: seeded.id },
          select: { scope: true, city: true, district: true },
        }),
      ).toEqual([{ scope: 'CITY', city: location.city, district: null }]);
    } finally {
      await provider.close();
    }
  });
});
