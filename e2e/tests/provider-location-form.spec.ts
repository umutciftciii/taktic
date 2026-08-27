import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCategory, prisma, uniqueLocation, uniquePhone, uniqueSuffix } from '../src/fixtures';
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

      // The service area is the same pair of dependent selects, and its
      // district stays optional: a province on its own means the whole province.
      const areaCity = form.getByTestId('location-city-serviceAreaCity');
      const areaDistrict = form.getByTestId('location-district-serviceAreaDistrict');
      await expect(areaDistrict).toBeDisabled();
      await expect(areaDistrict).not.toHaveAttribute('required', '');
      await areaCity.selectOption('İstanbul');
      await expect(areaDistrict).toBeEnabled();
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
      await form.locator('select[name="serviceAreaCity"]').selectOption(location.city);
      await form.locator('select[name="serviceAreaDistrict"]').selectOption(location.district);

      await form.getByRole('button', { name: 'Başvuruyu Gönder' }).click();
      await expect(applicant.page).toHaveURL(/\/providers\/success$/);
      await assertNoErrorScreen(applicant.page);

      const stored = await prisma().providerProfile.findFirstOrThrow({
        where: { businessName },
        select: { city: true, district: true, serviceAreas: true },
      });
      expect(stored.city).toBe(location.city);
      expect(stored.district).toBe(location.district);
      expect(stored.serviceAreas).toHaveLength(1);
      expect(stored.serviceAreas[0]?.city).toBe(location.city);
      expect(stored.serviceAreas[0]?.district).toBe(location.district);
    } finally {
      await applicant.close();
    }
  });
});
