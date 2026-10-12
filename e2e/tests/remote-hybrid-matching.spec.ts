import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { settleActionRedirect } from '../src/action-redirect';
import { confirmThrough } from '../src/confirm-dialog';
import {
  createAdmin,
  createCategory,
  createProvider,
  prisma,
  uniqueLocation,
  uniquePhone,
  uniqueSuffix,
  type SeededCategory,
} from '../src/fixtures';
import {
  approveRequest,
  completeContactStep,
  matchingRequestIds,
  submitOffer,
  submitRequestForm,
  type RequestFormValues,
} from '../src/journeys';
import { primaryRuntime } from '../src/runtime';

/**
 * MATCH-001 — remote and hybrid categories, on real screens.
 *
 *   1. An operator turns a service REMOTE in the category form (the change asks
 *      first). A guest's request in one district reaches a provider serving a
 *      different district and a provider with no area at all; both can offer.
 *      The ON_SITE control in the same districts stays region-bound. Turning
 *      the category back to ON_SITE leaves the existing request REMOTE, and the
 *      admin detail shows both facts.
 *   2. A HYBRID service asks the customer: "Yerinde" stays region-bound,
 *      "Uzaktan" crosses regions.
 */

const COST = 2;

function values(location: { city: string; district: string }): RequestFormValues {
  const suffix = uniqueSuffix();
  return {
    customerName: `E2E Uzaktan ${suffix}`,
    customerPhone: uniquePhone(),
    customerEmail: `e2e-remote-${suffix}@example.test`,
    city: location.city,
    district: location.district,
    description: 'Uzaktan verilebilecek bir iş için uçtan uca test talebi; ayrıntılar açıklamada.',
  };
}

/**
 * The request form from the category page to the success screen. `mode`
 * answers the HYBRID question when the form asks it.
 */
async function sendRequest(
  actor: Actor,
  category: SeededCategory,
  location: { city: string; district: string },
  mode?: 'ON_SITE' | 'REMOTE',
): Promise<string> {
  const page = actor.page;
  const form = page.locator('form.form-card');
  const answers = values(location);
  await actor.gotoWeb(`/categories/${category.slug}`);
  await expect(page.locator('#request-step-contact')).toBeVisible();
  await completeContactStep(actor, answers);
  await form.locator('textarea[name="description"]').fill(answers.description);
  await page.getByRole('button', { name: 'Devam et' }).click();
  await expect(page.locator('#request-step-place')).toBeVisible();

  if (mode) {
    await expect(page.getByTestId('delivery-mode-field')).toBeVisible();
    await page.getByTestId(`delivery-mode-${mode.toLowerCase()}`).check();
  } else {
    await expect(page.getByTestId('delivery-mode-field')).toHaveCount(0);
  }
  const remoteNote = page.getByTestId('delivery-mode-remote-note');
  if (mode === 'REMOTE' || (!mode && (await categoryModel(category)) === 'REMOTE')) {
    await expect(remoteNote).toBeVisible();
  } else {
    await expect(remoteNote).toHaveCount(0);
  }

  await form.locator('select[name="city"]').selectOption(answers.city);
  await form.locator('select[name="district"]').selectOption(answers.district);
  await submitRequestForm(actor);
  const requestId = new URL(page.url()).searchParams.get('id');
  expect(requestId).toBeTruthy();
  return requestId as string;
}

async function categoryModel(category: SeededCategory) {
  return (await prisma().serviceCategory.findUniqueOrThrow({ where: { id: category.id } })).deliveryModel;
}

async function modeOf(requestId: string) {
  return (await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } })).deliveryMode;
}

/** Saves a new delivery model through the category form and its confirmation. */
async function setDeliveryModel(admin: Actor, category: SeededCategory, to: 'ON_SITE' | 'REMOTE', label: string) {
  const page: Page = admin.page;
  await admin.gotoAdmin(`/categories/${category.slug}`);
  const form = page.locator('form', { has: page.getByTestId('category-save') });
  await form.locator('select[name="deliveryModel"]').selectOption(to);
  await settleActionRedirect(page, () =>
    confirmThrough(form.getByTestId('category-save'), 'Evet, kaydet', async (dialog) => {
      await expect(dialog.getByTestId('category-delivery-model-change')).toContainText(label);
    }),
  );
  await expect.poll(() => categoryModel(category)).toBe(to);
  await assertNoErrorScreen(page);
}

test.describe('remote and hybrid matching (MATCH-001)', () => {
  test('REMOTE crosses regions (and needs no area); ON_SITE does not; a later category change leaves the request as it was', async ({ browser }) => {
    const here = uniqueLocation();
    const there = uniqueLocation();
    const remoteCategory = await createCategory(COST, { namePrefix: 'E2E Online Ders' });
    const onSiteCategory = await createCategory(COST, { namePrefix: 'E2E Yerinde Klima' });
    const adminAccount = await createAdmin();
    const farAccount = await createProvider({ categoryId: remoteCategory.id, location: there, credits: 10 });
    const nowhereAccount = await createProvider({ categoryId: remoteCategory.id, location: there, credits: 10, serviceArea: false });
    const farOnSiteAccount = await createProvider({ categoryId: onSiteCategory.id, location: there, credits: 10 });

    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const customer = await Actor.open(browser, 'customer', primaryRuntime, {
      extraHTTPHeaders: { 'x-forwarded-for': `10.201.${test.info().retry}.1` },
    });
    const far = await Actor.open(browser, 'provider-far', primaryRuntime);
    const nowhere = await Actor.open(browser, 'provider-nowhere', primaryRuntime);
    const farOnSite = await Actor.open(browser, 'provider-far-onsite', primaryRuntime);
    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);

      // 1. The operator makes the service remote — the save asks first.
      await setDeliveryModel(admin, remoteCategory, 'REMOTE', 'Yerinde → Uzaktan');

      // 2. A guest asks for it from `here`; the form says the place does not limit matching.
      const remoteRequest = await sendRequest(customer, remoteCategory, here);
      expect(await modeOf(remoteRequest)).toBe('REMOTE');
      const onSiteRequest = await sendRequest(customer, onSiteCategory, here);
      expect(await modeOf(onSiteRequest)).toBe('ON_SITE');
      await approveRequest(admin, remoteRequest);
      await approveRequest(admin, onSiteRequest);

      // 3–4. A provider serving another district, and one serving none, see it and offer.
      await far.loginToWeb(farAccount.email, farAccount.password);
      expect(await matchingRequestIds(far, farAccount.id)).toContain(remoteRequest);
      await expect(far.page.getByTestId('delivery-mode-badge').first()).toHaveText('Uzaktan');
      await submitOffer(far, { providerId: farAccount.id, requestId: remoteRequest, expectedCreditCost: COST, priceAmount: '1500', message: 'Uzaktan yapabilirim.' });

      await nowhere.loginToWeb(nowhereAccount.email, nowhereAccount.password);
      expect(await matchingRequestIds(nowhere, nowhereAccount.id)).toContain(remoteRequest);
      await submitOffer(nowhere, { providerId: nowhereAccount.id, requestId: remoteRequest, expectedCreditCost: COST, priceAmount: '1600', message: 'Online yapabilirim.' });

      // 5. The ON_SITE control: the far provider neither lists nor opens it.
      await farOnSite.loginToWeb(farOnSiteAccount.email, farOnSiteAccount.password);
      expect(await matchingRequestIds(farOnSite, farOnSiteAccount.id)).not.toContain(onSiteRequest);
      await farOnSite.gotoWeb(`/providers/${farOnSiteAccount.id}/requests/${onSiteRequest}`);
      await expect(farOnSite.page.getByRole('button', { name: 'Teklifi Gönder' })).toHaveCount(0);

      // 8. Back to ON_SITE: the existing request keeps REMOTE, the admin detail shows both.
      await setDeliveryModel(admin, remoteCategory, 'ON_SITE', 'Uzaktan → Yerinde');
      expect(await modeOf(remoteRequest)).toBe('REMOTE');
      await admin.gotoAdmin(`/requests/${remoteRequest}`);
      await expect(admin.page.getByText('Hizmet şekli (talep)')).toBeVisible();
      await expect(admin.page.getByText('Uzaktan hizmet').first()).toBeVisible();
      await expect(admin.page.getByText('Kategori sonradan değişti', { exact: false })).toBeVisible();
      await assertNoErrorScreen(admin.page);
    } finally {
      for (const actor of [admin, customer, far, nowhere, farOnSite]) await actor.close();
    }
  });

  test('HYBRID asks the customer: "Yerinde" stays region-bound, "Uzaktan" crosses regions', async ({ browser }) => {
    const here = uniqueLocation();
    const there = uniqueLocation();
    const category = await createCategory(COST, { namePrefix: 'E2E Hibrit Danışmanlık', deliveryModel: 'HYBRID' });
    const adminAccount = await createAdmin();
    const farAccount = await createProvider({ categoryId: category.id, location: there, credits: 10 });
    const localAccount = await createProvider({ categoryId: category.id, location: here, credits: 10 });

    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const customer = await Actor.open(browser, 'customer', primaryRuntime, {
      extraHTTPHeaders: { 'x-forwarded-for': `10.202.${test.info().retry}.1` },
    });
    const far = await Actor.open(browser, 'provider-far', primaryRuntime);
    const local = await Actor.open(browser, 'provider-local', primaryRuntime);
    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      const onSite = await sendRequest(customer, category, here, 'ON_SITE');
      const remote = await sendRequest(customer, category, here, 'REMOTE');
      expect([await modeOf(onSite), await modeOf(remote)]).toEqual(['ON_SITE', 'REMOTE']);
      await approveRequest(admin, onSite);
      await approveRequest(admin, remote);

      await far.loginToWeb(farAccount.email, farAccount.password);
      const farSees = await matchingRequestIds(far, farAccount.id);
      expect(farSees).toContain(remote);
      expect(farSees).not.toContain(onSite);

      await local.loginToWeb(localAccount.email, localAccount.password);
      const localSees = await matchingRequestIds(local, localAccount.id);
      expect(localSees).toEqual(expect.arrayContaining([onSite, remote]));
    } finally {
      for (const actor of [admin, customer, far, local]) await actor.close();
    }
  });
});
