import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { confirmThrough } from '../src/confirm-dialog';
import {
  createAdmin,
  createCategory,
  createOfferPackage,
  createRouterRule,
  createSelectQuestion,
  createStaffAdmin,
  prisma,
} from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESIGN-001 Faz 3F — katalog: /categories, /categories/new,
 * /categories/[slug], /credit-packages, /credit-packages/new and
 * /credit-packages/[id], through the real Next screens against the real API.
 *
 * The per-flow specs already drive the editors (category-expansion: router
 * rules, conditions, question create; category-release-readiness,
 * -supply-status, -wave-2-drafts: the checklist; provider-invite-links: the
 * invitation desk; admin-status-permission: WRITE vs STATUS; offer-packages).
 * What this one pins is the part the redesign could quietly break:
 *
 * - Every section and control of the category screen is drawn under exactly
 *   the permission combination it was drawn under before (plan belgesi,
 *   "Faz 3F envanter"), and a session without it sees the state, not the
 *   control. No delete control appears anywhere (K9).
 * - The credit-package list keeps ↑/↓ (CREDIT_PACKAGES_WRITE), Aktifleştir /
 *   Pasifleştir (CREDIT_PACKAGES_STATUS) and all three package types, and
 *   both still write.
 * - No page is wider than the window at 320, 390, 768, 1024, 1280 and 1440,
 *   with long names.
 */

const SCREENS_DIR = resolve(artifactsDir, 'faz-3f-screens');
const WIDTHS = [320, 390, 768, 1024, 1280, 1440];

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  // The design package's width, so the captures compare one to one.
  await actor.page.setViewportSize({ width: 1440, height: 1617 });
  await actor.loginToAdmin(account.email, account.password);
  return actor;
}

async function expectOpen(page: Page, path: RegExp) {
  await expect(page).toHaveURL(path);
  await assertNoErrorScreen(page);
  await expect(page.getByRole('heading', { name: /yetkiniz yok/i })).toHaveCount(0);
}

async function expectNoPageOverflow(page: Page, label: string) {
  const { overflow, culprits } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const scrolls = (element: Element | null): boolean => {
      for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll|hidden)/.test(style.overflowX) && node.scrollWidth > node.clientWidth) return true;
      }
      return false;
    };
    const culprits = [...document.querySelectorAll('main *')]
      .filter((element) => element.getBoundingClientRect().right > width + 1 && !scrolls(element))
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`);
    return { overflow: document.documentElement.scrollWidth - width, culprits };
  });
  expect(overflow, `${label}: page overflow (${culprits.join(', ')})`).toBeLessThanOrEqual(1);
}

async function capture(page: Page, name: string) {
  const project = test.info().project.name;
  mkdirSync(SCREENS_DIR, { recursive: true });
  const width = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: resolve(SCREENS_DIR, `${project}-${name}-${width}.png`) });
}

/** A group, a draft service under it with two questions, and a router onto it. */
async function seedCatalogue(prefix = 'E2E Faz3F') {
  const group = await createCategory(null, { kind: 'GROUP', namePrefix: `${prefix} Grup` });
  const service = await createCategory(3, {
    status: 'DRAFT',
    parentId: group.id,
    namePrefix: `${prefix} Hizmet`,
    providerEnrollmentOpen: true,
  });
  const source = await createSelectQuestion({
    categoryId: service.id,
    key: 'kaynak',
    label: `${prefix} kaynak soru`,
    sortOrder: 10,
    options: [
      { key: 'evet', label: 'Evet' },
      { key: 'hayir', label: 'Hayır' },
    ],
  });
  await createSelectQuestion({
    categoryId: service.id,
    key: 'hedef',
    label: `${prefix} hedef soru`,
    sortOrder: 20,
    options: [{ key: 'a', label: 'A' }],
  });
  const router = await createCategory(1, { kind: 'ROUTER', namePrefix: `${prefix} Yönlendirici` });
  const routerQuestion = await createSelectQuestion({
    categoryId: router.id,
    key: 'cihaz',
    label: `${prefix} hangi cihaz`,
    sortOrder: 10,
    isRequired: true,
    isRouter: true,
    options: [{ key: 'servis', label: 'Servis' }],
  });
  await createRouterRule({ questionId: routerQuestion.id, optionKey: 'servis', targetCategoryId: service.id });
  return { group, service, router, source };
}

test.describe('ADMIN-DESIGN-001 Faz 3F — catalogue screens', () => {
  test('the category screen draws each section and control under its own permission', async ({ browser }) => {
    test.setTimeout(240_000);
    const { service, router } = await seedCatalogue();
    const reader = await openAs(browser, ['CATALOG_READ']);
    const questionReader = await openAs(browser, ['CATALOG_READ', 'QUESTIONS_READ', 'PROVIDER_INVITES_READ']);
    const editor = await openAs(browser, [
      'CATALOG_READ',
      'CATEGORIES_WRITE',
      'QUESTIONS_READ',
      'QUESTIONS_WRITE',
      'PROVIDER_INVITES_READ',
      'PROVIDER_INVITES_ISSUE',
    ]);
    const switcher = await openAs(browser, [
      'CATALOG_READ',
      'CATEGORIES_STATUS',
      'PROVIDER_INVITES_READ',
      'PROVIDER_INVITES_REVOKE',
    ]);
    const admin = await openAs(browser, 'super');
    const servicePath = `/categories/${service.slug}`;

    try {
      // ---- CATALOG_READ only: the category, read-only, nothing else --------
      let page = reader.page;
      await reader.gotoAdmin('/categories');
      await expectOpen(page, /\/categories$/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hizmet kategorileri');
      await expect(page.getByTestId('category-new-link')).toHaveCount(0);
      await expect(page.getByTestId(`release-row-${service.slug}`)).toContainText('Hazır değil');
      await expect(page.getByTestId(`tree-readiness-${service.slug}`)).toContainText('Onaylı hizmet veren yok');
      // The tree keeps its depth: the service sits under its group.
      await expect(page.getByTestId(`category-row-${service.slug}`)).toContainText('altında');
      await reader.gotoAdmin('/categories/new');
      await expect(page).toHaveURL(/\/yetkisiz/);

      await reader.gotoAdmin(servicePath);
      await expectOpen(page, new RegExp(`${servicePath}$`));
      await expect(page.getByTestId('category-header')).toContainText(service.slug);
      await expect(page.getByTestId('category-read-only')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Kategoriyi kaydet' })).toHaveCount(0);
      await expect(page.getByTestId('question-set-card')).toHaveCount(0);
      await expect(page.getByTestId('category-fact-questions')).toHaveCount(0);
      await expect(page.getByTestId('category-status-panel')).toHaveCount(0);
      await expect(page.getByTestId('provider-invite-panel')).toHaveCount(0);
      await expect(page.getByTestId('release-checklist')).toBeVisible();
      await expect(page.getByTestId('release-checklist')).not.toContainText('Soru sayısı');
      await expect(page.locator('.catalog-detail-page form')).toHaveCount(0);
      await expect(page.locator('.catalog-detail-page').getByRole('button', { name: /sil/i })).toHaveCount(0);
      // Faz 3F.1: a tab the session may not read is not drawn, and asking for
      // it by URL lands on the first tab.
      await expect(page.getByTestId('category-tab-sorular')).toHaveCount(0);
      await expect(page.getByTestId('category-tab-davetler')).toHaveCount(0);
      await reader.gotoAdmin(`${servicePath}?tab=sorular`);
      await expect(page.getByTestId('category-panel-bilgiler')).toBeVisible();
      await expect(page.getByTestId('question-set-card')).toHaveCount(0);
      await reader.gotoAdmin(`${servicePath}?tab=gecmis`);
      await expect(page.getByTestId('category-activity')).toContainText('Kategori oluşturuldu');
      await expect(page.getByTestId('category-activity')).not.toContainText('sorusu eklendi');
      await expect(page.getByTestId('category-activity-footnote')).toContainText('geçmişi tutulmuyor');

      await reader.gotoAdmin(`/categories/${router.slug}`);
      await expect(page.getByTestId('router-explainer')).toBeVisible();
      await expect(page.getByTestId('router-targets-card')).toHaveCount(0);

      // ---- + QUESTIONS_READ, PROVIDER_INVITES_READ: read, never write -------
      page = questionReader.page;
      await questionReader.gotoAdmin(servicePath);
      await expectOpen(page, new RegExp(`${servicePath}$`));
      await expect(page.getByTestId('category-fact-questions')).toContainText('2');
      await expect(page.getByTestId('release-checklist')).toContainText('Soru sayısı');
      await expect(page.getByTestId('category-tab-sorular')).toContainText('2');
      await page.getByTestId('category-tab-sorular').click();
      await expect(page).toHaveURL(/\?tab=sorular$/);
      await expect(page.getByTestId('question-set-card').locator('details.question-row')).toHaveCount(2);
      await expect(page.getByTestId('question-set-card').locator('form')).toHaveCount(0);
      await expect(page.locator('.question-create-panel')).toHaveCount(0);
      // The design's "Ne zaman sorulur" column (a rule's wording is unit-tested).
      await expect(page.locator('details.question-row').filter({ hasText: 'hedef soru' })).toContainText('Her zaman');
      await questionReader.gotoAdmin(`${servicePath}?tab=davetler`);
      await expect(page.getByTestId('provider-invite-panel')).toBeVisible();
      await expect(page.getByTestId('provider-invite-create')).toHaveCount(0);

      await questionReader.gotoAdmin(`/categories/${router.slug}?tab=sorular`);
      await expect(page.getByTestId('router-rules-read-only')).toContainText(service.name);
      await expect(page.getByRole('button', { name: 'Yönlendirmeyi kaydet' })).toHaveCount(0);

      // ---- WRITE + QUESTIONS_WRITE + ISSUE: the editors, status locked ------
      page = editor.page;
      await editor.gotoAdmin(servicePath);
      await expectOpen(page, new RegExp(`${servicePath}$`));
      const form = page.locator('form', { has: page.getByRole('button', { name: 'Kategoriyi kaydet' }) });
      await expect(form.locator('select[disabled]:has(option[value="INACTIVE"])')).toHaveCount(1);
      await expect(form.locator('input[name="statusLocked"]')).toHaveCount(1);
      await expect(page.getByTestId('category-status-panel')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Dosya yükle' })).toHaveCount(0);
      await editor.gotoAdmin(`${servicePath}?tab=sorular`);
      const target = page.locator('details.question-row').filter({ hasText: 'hedef soru' });
      await target.locator('summary').click();
      await expect(target.getByRole('button', { name: 'Soruyu kaydet' })).toBeVisible();
      await expect(target.getByRole('button', { name: 'Koşulu kaydet' })).toBeVisible();
      await expect(target.locator('select[name="expectedValues"] option[value="kaynak::evet"]')).toHaveCount(1);
      await expect(target.getByRole('button', { name: 'Pasifleştir' })).toBeVisible();
      await expect(page.locator('.question-create-panel')).toBeVisible();
      await editor.gotoAdmin(`${servicePath}?tab=davetler`);
      await page.getByTestId('provider-invite-create').click();
      await expect(page.getByTestId('provider-invite-url')).toBeVisible();
      await expect(page.getByTestId('provider-invite-count')).toContainText('1 geçerli');
      await expect(page.locator('[data-testid^="provider-invite-revoke-"]')).toHaveCount(0);
      // The form still writes, and still leaves the status alone.
      await editor.gotoAdmin(servicePath);
      await form.locator('input[name="name"]').fill(`${service.name} yeni`);
      await form.getByRole('button', { name: 'Kategoriyi kaydet' }).click();
      await expect
        .poll(async () => (await prisma().serviceCategory.findUniqueOrThrow({ where: { id: service.id } })).name)
        .toBe(`${service.name} yeni`);
      expect((await prisma().serviceCategory.findUniqueOrThrow({ where: { id: service.id } })).status).toBe('DRAFT');
      // The save redirects back to this screen; let it land before leaving,
      // or the next goto is interrupted by it (WebKit on CI).
      await expect(page.getByTestId('category-header')).toContainText(`${service.name} yeni`);

      await editor.gotoAdmin(`/categories/${router.slug}?tab=sorular`);
      await expect(page.getByRole('button', { name: 'Yönlendirmeyi kaydet' })).toBeVisible();

      // ---- STATUS + REVOKE: the status desk and the withdraw button ---------
      page = switcher.page;
      await switcher.gotoAdmin(servicePath);
      await expectOpen(page, new RegExp(`${servicePath}$`));
      await expect(page.getByTestId('category-read-only')).toBeVisible();
      await expect(page.getByTestId('category-status-panel')).toBeVisible();
      await switcher.gotoAdmin(`${servicePath}?tab=davetler`);
      await expect(page.getByTestId('provider-invite-create')).toHaveCount(0);
      const invite = await prisma().providerInviteToken.findFirstOrThrow({ where: { categoryId: service.id } });
      // Withdrawing asks first: the link dies for good (Paket B).
      await confirmThrough(page.getByTestId(`provider-invite-revoke-${invite.id}`), 'Evet, bağlantıyı iptal et', async (dialog) => {
        await expect(dialog.getByTestId('invite-revoke-impact')).toContainText('kalıcı olarak geçersiz olur');
      });
      await expect(page.getByTestId('provider-invite-revoked')).toBeVisible();
      await expect
        .poll(async () => (await prisma().providerInviteToken.findUniqueOrThrow({ where: { id: invite.id } })).revokedAt)
        .not.toBeNull();

      // ---- super admin: everything, the upload button included -------------
      page = admin.page;
      await admin.gotoAdmin(servicePath);
      await expect(page.getByRole('button', { name: 'Dosya yükle' })).toHaveCount(2);
      await expect(page.getByTestId('category-status-panel')).toBeVisible();
      await admin.gotoAdmin(`${servicePath}?tab=davetler`);
      await expect(page.getByTestId('provider-invite-create')).toBeVisible();
      // The revoked link is a row with its state, and "Neler oldu" names who
      // issued it — and only that: nobody is recorded for the withdrawal.
      await expect(page.getByTestId(`provider-invite-${invite.id}`)).toContainText('İptal edildi');
      await admin.gotoAdmin(`${servicePath}?tab=gecmis`);
      const log = page.getByTestId('category-activity');
      await expect(log).toContainText('Davet bağlantısı oluşturuldu');
      await expect(log).toContainText('Davet bağlantısı iptal edildi');
      await expect(log).toContainText('sorusu eklendi');
      await admin.gotoAdmin('/categories');
      await expect(page.getByTestId('category-new-link')).toHaveText('Yeni kategori ekle');
    } finally {
      await Promise.all([reader.close(), questionReader.close(), editor.close(), switcher.close(), admin.close()]);
    }
  });

  test('credit packages keep order, status and all three types, each behind its permission', async ({ browser }) => {
    test.setTimeout(180_000);
    const scope = await createCategory(3, { namePrefix: 'E2E Faz3F Kapsam', unlimitedPackageEligible: true });
    const oneTime = await createOfferPackage({ type: 'ONE_TIME_CREDITS', name: 'E2E Faz3F Tek', creditAmount: 50 });
    const quota = await createOfferPackage({ type: 'MONTHLY_QUOTA', name: 'E2E Faz3F Kota', quotaCredits: 200 });
    const unlimited = await createOfferPackage({
      type: 'CATEGORY_UNLIMITED',
      name: 'E2E Faz3F Limitsiz',
      dailyOfferLimit: 5,
      scopeCategoryIds: [scope.id],
    });
    const ids = [oneTime.id, quota.id, unlimited.id];
    // Last in the canonical order, so ↓ is closed on the unlimited package.
    const base = 990_000 + (Date.now() % 1000) * 10;
    for (const [index, id] of ids.entries()) {
      await prisma().offerCreditPackage.update({ where: { id }, data: { sortOrder: base + index } });
    }

    const reader = await openAs(browser, ['CREDIT_PACKAGES_READ']);
    const writer = await openAs(browser, ['CREDIT_PACKAGES_READ', 'CREDIT_PACKAGES_WRITE']);
    const switcher = await openAs(browser, ['CREDIT_PACKAGES_READ', 'CREDIT_PACKAGES_STATUS']);
    const admin = await openAs(browser, 'super');
    const row = (page: Page, id: string) => page.locator(`[data-testid="credit-package-row"][data-package-id="${id}"]`);

    try {
      // ---- read only: every type, no control -------------------------------
      let page = reader.page;
      await reader.gotoAdmin('/credit-packages');
      await expectOpen(page, /\/credit-packages$/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kredi paketleri');
      await expect(row(page, oneTime.id)).toContainText('Tek seferlik kredi');
      await expect(row(page, oneTime.id)).toContainText('50');
      await expect(row(page, quota.id)).toContainText('Aylık kota');
      await expect(row(page, quota.id)).toContainText('30 gün geçerli');
      await expect(row(page, quota.id)).toContainText('200');
      await expect(row(page, unlimited.id)).toContainText('Kategori limitsiz');
      await expect(row(page, unlimited.id)).toContainText(scope.name);
      await expect(row(page, unlimited.id)).toContainText('günlük 5');
      await expect(row(page, unlimited.id)).toContainText('Limitsiz');
      await expect(page.getByTestId('package-move-up')).toHaveCount(0);
      await expect(page.getByTestId('package-status-toggle')).toHaveCount(0);
      await expect(page.getByTestId('credit-package-new-link')).toHaveCount(0);
      await reader.gotoAdmin('/credit-packages/new');
      await expect(page).toHaveURL(/\/yetkisiz/);
      await reader.gotoAdmin(`/credit-packages/${unlimited.id}`);
      await expectOpen(page, new RegExp(`/credit-packages/${unlimited.id}$`));
      await expect(page.getByTestId('credit-package-read-only')).toContainText(scope.name);
      await expect(page.getByTestId('credit-package-fact-allowance')).toContainText('günlük en fazla 5 teklif');
      await expect(page.getByTestId('credit-package-sales')).toHaveCount(0);
      await expect(page.getByTestId('credit-package-tab-satislar')).toHaveCount(0);
      await expect(page.getByTestId('credit-package-status-panel')).toHaveCount(0);
      await expect(page.getByTestId('credit-package-type-locked')).toHaveCount(0);
      await reader.gotoAdmin(`/credit-packages/${unlimited.id}?tab=satislar`);
      await expect(page.getByTestId('credit-package-panel-bilgiler')).toBeVisible();
      await reader.gotoAdmin(`/credit-packages/${unlimited.id}?tab=gecmis`);
      await expect(page.getByTestId('credit-package-activity')).toContainText('Paket oluşturuldu');

      // ---- WRITE: ↑/↓ and the new-package form, no status switch ------------
      page = writer.page;
      await writer.gotoAdmin('/credit-packages');
      await expectOpen(page, /\/credit-packages$/);
      await expect(page.getByTestId('credit-package-new-link')).toBeVisible();
      await expect(page.getByTestId('package-status-toggle')).toHaveCount(0);
      await expect(row(page, unlimited.id).getByTestId('package-move-down')).toBeDisabled();
      await expect(row(page, unlimited.id).getByTestId('package-move-up')).toBeEnabled();
      await row(page, unlimited.id).getByTestId('package-move-up').click();
      // A swap is two PATCHes; wait for both.
      await expect
        .poll(async () =>
          (await prisma().offerCreditPackage.findMany({ where: { id: { in: [quota.id, unlimited.id] } }, orderBy: { sortOrder: 'asc' } }))
            .map((pkg) => [pkg.id, pkg.sortOrder]),
        )
        .toEqual([
          [unlimited.id, base + 1],
          [quota.id, base + 2],
        ]);
      await writer.gotoAdmin('/credit-packages/new');
      await expectOpen(page, /\/credit-packages\/new$/);
      for (const name of ['name', 'sortOrder', 'slug', 'type', 'creditAmount', 'quotaCredits', 'dailyOfferLimit', 'currency', 'priceAmount', 'isActive', 'description']) {
        await expect(page.locator(`.catalog-form-page [name="${name}"]`), name).toHaveCount(1);
      }
      await expect(page.locator('.catalog-form-page select[name="type"] option')).toHaveCount(3);
      await expect(page.locator('.catalog-form-page select[name="scopeCategoryIds"] option', { hasText: scope.name })).toHaveCount(1);

      // ---- STATUS: the switch, no reorder ----------------------------------
      page = switcher.page;
      await switcher.gotoAdmin('/credit-packages');
      await expect(page.getByTestId('package-move-up')).toHaveCount(0);
      await confirmThrough(row(page, oneTime.id).getByTestId('package-status-toggle'), 'Evet, pasifleştir', async (deactivateDialog) => {
        await expect(deactivateDialog).toContainText('yeni satışa kapanır');
      });
      await expect(page).toHaveURL(/ok=deactivated/);
      expect((await prisma().offerCreditPackage.findUniqueOrThrow({ where: { id: oneTime.id } })).isActive).toBe(false);
      await expect(row(page, oneTime.id)).toContainText('Pasif');

      // ---- super admin: the sales summary is its own read ------------------
      page = admin.page;
      await admin.gotoAdmin(`/credit-packages/${oneTime.id}`);
      await expect(page.getByTestId('credit-package-status-panel')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Değişiklikleri kaydet' })).toBeVisible();
      // The type is shown, locked, and rides along as the hidden field it was.
      await expect(page.getByTestId('credit-package-type-locked')).toContainText('Tek seferlik kredi');
      await expect(page.locator('input[type="hidden"][name="type"]')).toHaveValue('ONE_TIME_CREDITS');
      await page.getByTestId('credit-package-tab-satislar').click();
      await expect(page).toHaveURL(/\?tab=satislar$/);
      await expect(page.getByTestId('credit-package-sales')).toBeVisible();
    } finally {
      // Left active, a fixture package breaks lemon-checkout's one-package view.
      await prisma().offerCreditPackage.updateMany({ where: { id: { in: ids } }, data: { isActive: false } });
      await Promise.all([reader.close(), writer.close(), switcher.close(), admin.close()]);
    }
  });

  test('no catalogue screen is wider than the window, from 320 to 1440', async ({ browser }) => {
    test.setTimeout(300_000);
    // Long, as real names get, but words: an unbroken 60-letter token left in
    // the shared database would widen other screens' category lists (the
    // provider detail lists every category) and fail the route scan there.
    const long = `E2E Faz3F çok uzun bir kategori adı ${'uzun kelime '.repeat(8).trim()}`;
    const { service, router } = await seedCatalogue(long);
    // One invitation row, so the Hizmet veren davetleri table is measured with
    // content in it rather than as an empty state.
    await prisma().providerInviteToken.create({
      data: {
        categoryId: service.id,
        tokenHash: `e2e-faz3f1-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      },
    });
    const pkg = await createOfferPackage({ type: 'CATEGORY_UNLIMITED', name: long, scopeCategoryIds: [service.id], dailyOfferLimit: 3 });
    const admin = await openAs(browser, 'super');
    const page = admin.page;
    const paths: Array<[string, string]> = [
      ['hizmet-kategorileri', '/categories'],
      ['yeni-kategori', '/categories/new'],
      ['kategori-detayi', `/categories/${service.slug}`],
      ['kategori-sorular', `/categories/${service.slug}?tab=sorular`],
      ['kategori-davetler', `/categories/${service.slug}?tab=davetler`],
      ['kategori-neler-oldu', `/categories/${service.slug}?tab=gecmis`],
      ['yonlendirici-detayi', `/categories/${router.slug}`],
      ['yonlendirici-sorular', `/categories/${router.slug}?tab=sorular`],
      ['kredi-paketleri', '/credit-packages'],
      ['yeni-kredi-paketi', '/credit-packages/new'],
      ['kredi-paketi-detayi', `/credit-packages/${pkg.id}`],
      ['kredi-paketi-satislar', `/credit-packages/${pkg.id}?tab=satislar`],
      ['kredi-paketi-neler-oldu', `/credit-packages/${pkg.id}?tab=gecmis`],
    ];

    try {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width === 1440 ? 1617 : 900 });
        for (const [name, path] of paths) {
          await admin.gotoAdmin(path);
          await expectOpen(page, new RegExp(`${path.replace('?', '\\?')}$`));
          await expectNoPageOverflow(page, `${path} @${width}`);
          if (width === 1440 || width === 320) await capture(page, name);
        }
      }

      // A question row opened: its editor holds selects as wide as their
      // longest option, which must scroll in the question table instead.
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1617 : 900 });
        await admin.gotoAdmin(`/categories/${service.slug}?tab=sorular`);
        await page.locator('details.question-row').filter({ hasText: 'hedef soru' }).locator('summary').click();
        await expect(page.getByRole('button', { name: 'Koşulu kaydet' })).toBeVisible();
        await expectNoPageOverflow(page, `question editor @${width}`);
        await capture(page, 'soru-duzenleme');
      }
    } finally {
      await prisma().offerCreditPackage.update({ where: { id: pkg.id }, data: { isActive: false } });
      await admin.close();
    }
  });
});
