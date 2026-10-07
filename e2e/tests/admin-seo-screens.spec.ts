import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { confirmThrough, waitForHydration } from '../src/confirm-dialog';
import { createAdmin, createCategory, createStaffAdmin, prisma, uniqueSuffix } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * SEO-004 PR B — the admin's "SEO ve adresler" screens and the category's
 * "Arama motoru" tab, driven as an operator drives them, against PR A's API.
 *
 *   RBAC        SEO_READ: the group, four screens, no write control;
 *               without it: no group, and the URL is /yetkisiz.
 *   overview    the API's own figures; no visit / hit / "last generated" text.
 *   indexing    the reason with required/actual; "Aç" to the record's screen.
 *   slug        category → "Adresi değiştir" → the mandatory 301 said → saved:
 *               the new slug shown, the redirect row there, old 301 / new 200.
 *   redirects   a 302 created, edited, a chain refused, one removed (soft).
 *   404         one suggestion approved into a redirect, one rejected.
 *   content     the category's SEO fields saved and rendered on the public page.
 *
 * Every record is made here, uniquely named, and the public web serves
 * redirects from a snapshot it refreshes every minute — so the first answer
 * for a fresh redirect is polled for.
 */

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.loginToAdmin(account.email, account.password);
  return actor;
}

/** A super admin's API cookie, for reading what the screen should show. */
async function adminCookie(): Promise<string> {
  const admin = await createAdmin();
  const id = `e2e-seo-ui-${randomUUID()}`;
  await prisma().session.create({ data: { id, userId: admin.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
  return `taktic_session=${id}`;
}

async function webStatus(request: APIRequestContext, path: string) {
  const response = await request.get(`${primaryRuntime.webUrl}${path}`, { maxRedirects: 0 });
  return { status: response.status(), location: response.headers()['location'] ?? null };
}

async function eventuallyStatus(request: APIRequestContext, path: string, status: number) {
  await expect
    .poll(async () => (await webStatus(request, path)).status, { timeout: 90_000, intervals: [1_000, 2_000, 5_000] })
    .toBe(status);
  return webStatus(request, path);
}

/**
 * Opens a URL-driven window from its link and waits until the address says it
 * is open. A soft navigation started in the instant the page is still settling
 * can be dropped by the router; pressing again until the URL moves is what an
 * operator would do, and the assertion is still on the window that opens.
 */
async function openWindow(page: Page, link: ReturnType<Page['getByTestId']>, url: RegExp) {
  await waitForHydration(link);
  await expect(async () => {
    if (!url.test(page.url())) await link.click();
    await expect(page).toHaveURL(url, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

async function sidebarGroups(page: Page): Promise<string[]> {
  return page.locator('#admin-sidebar .admin-sidebar-group-title').allTextContents();
}

function eligibleText(chars: number, salt: string): string {
  const sentence = 'Kadıköy ve çevresinde kombi bakımı ve arıza onarımı için dikkat edilecekler. ';
  let text = `${salt}. `;
  while (text.replace(/[^\p{L}\p{N}]/gu, '').length < chars) text += sentence;
  return text.trim();
}

test.describe('SEO-004 PR B: SEO ve adresler', () => {
  test('SEO_READ: the group, its four screens, and no write control anywhere', async ({ browser }) => {
    const category = await createCategory(3, { namePrefix: 'E2E SEO Okur' });
    const reader = await openAs(browser, ['SEO_READ', 'CATALOG_READ']);
    try {
      await reader.gotoAdmin('/seo');
      expect(await sidebarGroups(reader.page)).toContain('SEO ve adresler');
      const group = reader.page.locator('#admin-sidebar [role="group"]', { hasText: 'SEO ve adresler' });
      await expect(group.locator('.admin-sidebar-link')).toHaveText([
        'Arama motoru durumu',
        'İndekslenmeyen sayfalar',
        'Adresler',
        'Yönlendirmeler',
      ]);

      for (const path of ['/seo', '/seo/indexing', '/seo/slugs', '/seo/redirects', '/seo/redirects?sekme=oneriler']) {
        await reader.gotoAdmin(path);
        await assertNoErrorScreen(reader.page);
        await expect(reader.page).toHaveURL(new RegExp(path.replace(/[?]/g, '\\?')));
        await expect(reader.page.locator('h1').first()).toBeVisible();
      }
      // Read-only: no add, edit, remove, approve, reject or address change.
      await reader.gotoAdmin('/seo/redirects');
      await expect(reader.page.getByTestId('seo-redirect-new')).toHaveCount(0);
      await expect(reader.page.getByTestId('seo-redirect-edit')).toHaveCount(0);
      await expect(reader.page.getByTestId('seo-redirect-deactivate')).toHaveCount(0);
      await reader.gotoAdmin('/seo/redirects?sekme=oneriler');
      await expect(reader.page.getByTestId('seo-suggestion-approve')).toHaveCount(0);
      await reader.gotoAdmin(`/seo/slugs?q=${encodeURIComponent(category.slug)}`);
      await expect(reader.page.getByTestId('seo-slug-row')).toHaveCount(1);
      await expect(reader.page.getByTestId('seo-slug-change')).toHaveCount(0);
      // A window asked for by URL does not open either.
      await reader.gotoAdmin('/seo/redirects?yonlendirme=yeni');
      await expect(reader.page.getByTestId('seo-redirect-dialog')).toHaveCount(0);
    } finally {
      await reader.close();
    }
  });

  test('without SEO_READ: no group, and a direct address is refused', async ({ browser }) => {
    const other = await openAs(browser, ['CATALOG_READ', 'SEO_CONTENT_WRITE', 'SEO_REDIRECTS_WRITE']);
    try {
      await other.gotoAdmin('/categories');
      expect(await sidebarGroups(other.page)).not.toContain('SEO ve adresler');
      for (const path of ['/seo', '/seo/indexing', '/seo/slugs', '/seo/redirects']) {
        await other.gotoAdmin(path);
        await expect(other.page).toHaveURL(/\/yetkisiz$/);
      }
    } finally {
      await other.close();
    }
  });

  test('overview: the API’s figures, the real thresholds, and no made-up metric', async ({ browser, request }) => {
    const admin = await openAs(browser, 'super');
    try {
      const cookie = await adminCookie();
      await admin.gotoAdmin('/seo');
      await assertNoErrorScreen(admin.page);
      // Read after the page so a parallel write cannot make the two disagree by more than it changed.
      const overview = await (await request.get(`${primaryRuntime.apiUrl}/admin/seo/overview`, { headers: { cookie } })).json();
      const metric = (key: string) => admin.page.locator(`[data-metric="${key}"] .metric`);
      await expect(metric('seo-redirects')).toHaveText(String(overview.redirects.active));
      await expect(metric('seo-not-found')).toHaveText(String(overview.notFound.open));
      await expect(admin.page.getByTestId('seo-type-shelf-count')).toHaveText(
        `${overview.pages.showcaseShelf.indexable ? 1 : 0} / 1`,
      );
      await expect(admin.page.getByTestId('seo-rules')).toContainText(
        `en az ${overview.thresholds.categoryDescriptionMinChars} karakter`,
      );
      await expect(admin.page.getByTestId('seo-site-band')).toContainText('İstek anında üretilir');
      await expect(admin.page.getByTestId('seo-overview')).not.toContainText(/30 gün|ziyaret|kez kullanıldı|son güncelleme/i);
    } finally {
      await admin.close();
    }
  });

  test('non-indexable: the reason with its numbers, and "Aç" opens the category', async ({ browser }) => {
    const category = await createCategory(3, { namePrefix: 'E2E SEO Kapalı' });
    const admin = await openAs(browser, 'super');
    try {
      await admin.gotoAdmin(`/seo/indexing?type=CATEGORY&q=${encodeURIComponent(category.name)}`);
      const row = admin.page.getByTestId('seo-indexing-row').filter({ hasText: category.name });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(`/categories/${category.slug}`);
      await expect(row).toContainText('Açıklama metni çok kısa');
      await expect(row).toContainText(/400 karakter gerek · şu an \d+ karakter/);
      await expect(row).toContainText('Aramaya kapalı');
      await row.getByTestId('seo-indexing-open').click();
      await expect(admin.page).toHaveURL(new RegExp(`/categories/${category.slug}$`));
      await assertNoErrorScreen(admin.page);
    } finally {
      await admin.close();
    }
  });

  test('slug: from the category, the mandatory 301 said, saved — old 301, new 200', async ({ browser, request }) => {
    test.setTimeout(180_000);
    const category = await createCategory(3, { namePrefix: 'E2E SEO Adres' });
    const newSlug = `e2e-seo-adres-yeni-${uniqueSuffix()}`;
    const admin = await openAs(browser, 'super');
    const page = admin.page;
    try {
      await admin.gotoAdmin(`/categories/${category.slug}`);
      const field = page.getByTestId('category-slug-field');
      await expect(field).toContainText(`/categories/${category.slug}`);
      await expect(field).toContainText('Adres değiştiğinde eski adres otomatik olarak yeni adrese 301 ile yönlendirilir.');
      const editForm = page.locator('form', { has: page.getByTestId('category-save') });
      await expect(editForm.locator('input[name="slug"]')).toHaveCount(0);
      await expect(page.getByTestId('category-info-card')).not.toContainText('bağlantılar kırılır');

      await openWindow(page, page.getByTestId('category-slug-change'), /\/seo\/slugs\?kategori=/);
      const dialog = page.getByTestId('seo-slug-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('seo-slug-current')).toHaveText(`/categories/${category.slug}`);
      await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(0);
      await expect(dialog.getByTestId('seo-slug-301')).toHaveText(
        'Eski adres otomatik olarak yeni adrese kalıcı (301) yönlendirilir.',
      );

      const input = dialog.getByTestId('seo-slug-input');
      await waitForHydration(input);
      // A taken address is refused before the save is offered.
      await input.fill('Kombi Servisi');
      const taken = await prisma().serviceCategory.findFirst({ where: { slug: 'kombi-servisi' } });
      if (taken) await expect(dialog.getByTestId('seo-slug-problem')).toContainText('başka bir kategoride');

      await input.fill(newSlug);
      await expect(dialog.getByTestId('seo-slug-preview')).toContainText(`/categories/${newSlug}`);
      await expect(dialog.getByTestId('seo-slug-preview')).not.toContainText('kontrol ediliyor');
      await confirmThrough(dialog.getByTestId('seo-slug-submit'), 'Evet, adresi değiştir', async (confirm) => {
        await expect(confirm.getByTestId('seo-slug-confirm-body')).toContainText(`/categories/${newSlug}`);
        await expect(confirm.getByTestId('seo-slug-confirm-body')).toContainText('kalıcı (301)');
      });

      await expect(page).toHaveURL(new RegExp(`/categories/${newSlug}\\?`));
      await expect(page.getByTestId('category-slug-changed')).toContainText(`/categories/${newSlug}`);
      await expect(page.getByTestId('category-slug-value')).toHaveText(`/categories/${newSlug}`);

      const redirect = await prisma().seoRedirect.findFirstOrThrow({
        where: { sourcePath: `/categories/${category.slug}`, active: true },
      });
      expect([redirect.targetPath, redirect.type, redirect.origin]).toEqual([`/categories/${newSlug}`, 'PERMANENT', 'SLUG_CHANGE']);

      // The address list shows the new slug and one old address.
      await admin.gotoAdmin(`/seo/slugs?q=${encodeURIComponent(newSlug)}`);
      const row = page.getByTestId('seo-slug-row').filter({ hasText: category.name });
      await expect(row.getByTestId('seo-slug-path')).toHaveText(`/categories/${newSlug}`);
      await expect(row.getByTestId('seo-slug-previous')).toHaveText('1 eski adres');
      // …and the redirect list the 301, with no way to make it a 302.
      await admin.gotoAdmin(`/seo/redirects?q=${encodeURIComponent(category.slug)}`);
      const redirectRow = page.locator(`[data-redirect-id="${redirect.id}"]`);
      await expect(redirectRow.getByTestId('seo-redirect-type-badge')).toHaveText('301 · kalıcı');
      await openWindow(page, redirectRow.getByTestId('seo-redirect-edit'), new RegExp(`yonlendirme=${redirect.id}`));
      await expect(page.getByTestId('seo-redirect-dialog').locator('input[name="type"]')).toHaveCount(0);

      const old = await eventuallyStatus(request, `/categories/${category.slug}`, 301);
      expect(new URL(old.location!).pathname).toBe(`/categories/${newSlug}`);
      expect((await webStatus(request, `/categories/${newSlug}`)).status).toBe(200);
    } finally {
      await admin.close();
    }
  });

  test('redirects: a 302 created and edited, a chain refused, one removed — never deleted', async ({ browser }) => {
    const target = await createCategory(3, { namePrefix: 'E2E SEO Hedef' });
    const suffix = uniqueSuffix();
    const source = `/e2e-seo-kampanya-${suffix}`;
    const admin = await openAs(browser, 'super');
    const page = admin.page;
    try {
      await admin.gotoAdmin('/seo/redirects');
      await openWindow(page, page.getByTestId('seo-redirect-new'), /yonlendirme=yeni/);
      let dialog = page.getByTestId('seo-redirect-dialog');
      await expect(dialog).toBeVisible();
      await waitForHydration(dialog.getByTestId('seo-redirect-source'));
      await dialog.getByTestId('seo-redirect-source').fill(source);
      await dialog.getByTestId('seo-redirect-target').fill('/vitrin');
      await dialog.locator('label.seo-type-option', { hasText: 'Geçici (302)' }).click();
      await dialog.getByTestId('seo-redirect-reason').fill('E2E kampanya');
      await dialog.getByTestId('seo-redirect-submit').click();
      await expect(page.getByTestId('seo-redirects-ok')).toContainText('eklendi');

      const created = await prisma().seoRedirect.findFirstOrThrow({ where: { sourcePath: source, active: true } });
      expect([created.type, created.targetPath, created.origin]).toEqual(['TEMPORARY', '/vitrin', 'MANUAL']);
      await admin.gotoAdmin(`/seo/redirects?q=${encodeURIComponent(source)}`);
      const row = page.locator(`[data-redirect-id="${created.id}"]`);
      await expect(row.getByTestId('seo-redirect-type-badge')).toHaveText('302 · geçici');

      // Edit: the source is fixed; the target and the reason move.
      await openWindow(page, row.getByTestId('seo-redirect-edit'), new RegExp(`yonlendirme=${created.id}`));
      dialog = page.getByTestId('seo-redirect-dialog');
      await expect(dialog.getByTestId('seo-redirect-source-locked')).toContainText(source);
      await expect(dialog.getByTestId('seo-redirect-source')).toHaveCount(0);
      await waitForHydration(dialog.getByTestId('seo-redirect-target'));
      await dialog.getByTestId('seo-redirect-target').fill(`/categories/${target.slug}`);
      await dialog.getByTestId('seo-redirect-reason').fill('E2E yeni hedef');
      await dialog.getByTestId('seo-redirect-submit').click();
      await expect(page.getByTestId('seo-redirects-ok')).toContainText('güncellendi');
      const edited = await prisma().seoRedirect.findUniqueOrThrow({ where: { id: created.id } });
      expect([edited.sourcePath, edited.targetPath, edited.reason]).toEqual([source, `/categories/${target.slug}`, 'E2E yeni hedef']);

      // A chain: a new redirect whose target is that redirect's source.
      const stale = `/categories/e2e-seo-eski-${suffix}`;
      await admin.gotoAdmin('/seo/redirects?yonlendirme=yeni');
      dialog = page.getByTestId('seo-redirect-dialog');
      await waitForHydration(dialog.getByTestId('seo-redirect-source'));
      await dialog.getByTestId('seo-redirect-source').fill(stale);
      await dialog.getByTestId('seo-redirect-target').fill(`/categories/${target.slug}`);
      await dialog.getByTestId('seo-redirect-reason').fill('E2E zincir başı');
      await dialog.getByTestId('seo-redirect-submit').click();
      await expect(page.getByTestId('seo-redirects-ok')).toBeVisible();
      await admin.gotoAdmin('/seo/redirects?yonlendirme=yeni');
      dialog = page.getByTestId('seo-redirect-dialog');
      await waitForHydration(dialog.getByTestId('seo-redirect-source'));
      await dialog.getByTestId('seo-redirect-source').fill(`/e2e-seo-zincir-${suffix}`);
      await dialog.getByTestId('seo-redirect-target').fill(stale);
      await dialog.getByTestId('seo-redirect-reason').fill('E2E zincir');
      await dialog.getByTestId('seo-redirect-submit').click();
      await expect(dialog.getByTestId('seo-redirect-error')).toContainText('zincir veya döngü');
      // What was typed is kept.
      await expect(dialog.getByTestId('seo-redirect-source')).toHaveValue(`/e2e-seo-zincir-${suffix}`);
      expect(await prisma().seoRedirect.count({ where: { sourcePath: `/e2e-seo-zincir-${suffix}` } })).toBe(0);

      // Remove (soft): asks, then the row stays — inactive.
      await admin.gotoAdmin(`/seo/redirects?q=${encodeURIComponent(source)}`);
      await confirmThrough(
        page.locator(`[data-redirect-id="${created.id}"]`).getByTestId('seo-redirect-deactivate'),
        'Evet, kaldır',
        async (confirm) => {
          await expect(confirm).toContainText('Kayıt silinmez');
        },
      );
      await expect(page.getByTestId('seo-redirects-ok')).toContainText('kaldırıldı');
      const removed = await prisma().seoRedirect.findUniqueOrThrow({ where: { id: created.id } });
      expect([removed.active, removed.deactivatedAt === null]).toEqual([false, false]);
    } finally {
      await admin.close();
    }
  });

  test('404 suggestions: one approved into a redirect, one rejected — nothing on its own', async ({ browser }) => {
    const target = await createCategory(3, { namePrefix: 'E2E SEO Öneri' });
    const suffix = uniqueSuffix();
    const now = new Date();
    const [approve, reject] = await Promise.all(
      ['onay', 'ret'].map((kind) =>
        prisma().seoNotFoundPath.create({
          data: {
            path: `/categories/e2e-404-${kind}-${suffix}`,
            routeFamily: 'CATEGORY',
            firstSeenAt: now,
            lastSeenAt: now,
            // Above anything else in the queue, so the rows are on its first page.
            occurrenceCount: 9_000_000,
            seenDays: 3,
            candidateTargetPath: kind === 'onay' ? `/categories/${target.slug}` : null,
          },
        }),
      ),
    );
    const admin = await openAs(browser, 'super');
    const page = admin.page;
    try {
      await admin.gotoAdmin('/seo/redirects?sekme=oneriler');
      await expect(page.locator(`[data-suggestion-id="${approve!.id}"]`)).toContainText(`/categories/${target.slug}`);
      expect(await prisma().seoRedirect.count({ where: { sourcePath: approve!.path } })).toBe(0);

      await openWindow(
        page,
        page.locator(`[data-suggestion-id="${approve!.id}"]`).getByTestId('seo-suggestion-approve'),
        new RegExp(`oneri=${approve!.id}`),
      );
      const dialog = page.getByTestId('seo-suggestion-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('seo-redirect-target')).toHaveValue(`/categories/${target.slug}`);
      await expect(dialog.getByTestId('seo-redirect-type-301')).toBeChecked();
      await confirmThrough(dialog.getByTestId('seo-suggestion-approve-submit'), 'Evet, yönlendirmeyi oluştur');
      await expect(page.getByTestId('seo-redirects-ok')).toContainText('onaylandı');
      const approved = await prisma().seoNotFoundPath.findUniqueOrThrow({ where: { id: approve!.id } });
      expect(approved.status).toBe('APPROVED');
      const made = await prisma().seoRedirect.findUniqueOrThrow({ where: { id: approved.redirectId! } });
      expect([made.sourcePath, made.targetPath, made.origin]).toEqual([approve!.path, `/categories/${target.slug}`, 'NOT_FOUND_SUGGESTION']);

      // A fresh page for the second decision: the approve's redirect may still
      // be settling, and a confirmation pressed on the outgoing tree is lost.
      await admin.gotoAdmin('/seo/redirects?sekme=oneriler');
      await confirmThrough(
        page.locator(`[data-suggestion-id="${reject!.id}"]`).getByTestId('seo-suggestion-reject'),
        'Evet, reddet',
        async (confirm) => {
          await confirm.getByTestId('seo-suggestion-reject-reason').fill('E2E: bilinçli 404');
        },
      );
      await expect
        .poll(async () => {
          const rejected = await prisma().seoNotFoundPath.findUniqueOrThrow({ where: { id: reject!.id } });
          return [rejected.status, rejected.redirectId];
        })
        .toEqual(['REJECTED', null]);
      await expect(page.getByTestId('seo-redirects-ok')).toContainText('reddedildi');
    } finally {
      await admin.close();
    }
  });

  test('category "Arama motoru": fields, counters and the FAQ saved, then rendered on the public page', async ({
    browser,
    request,
  }) => {
    const category = await createCategory(3, { namePrefix: 'E2E SEO İçerik' });
    const admin = await openAs(browser, 'super');
    const page = admin.page;
    const title = `E2E Başlık ${uniqueSuffix()}`;
    const guide = eligibleText(90, 'E2E rehber metni');
    try {
      await admin.gotoAdmin(`/categories/${category.slug}?tab=arama-motoru`);
      await expect(page.getByTestId('category-seo-indexable')).toHaveText('Aramaya kapalı');
      const form = page.getByTestId('category-seo-form');
      await waitForHydration(form.getByTestId('category-seo-title'));
      await form.getByTestId('category-seo-title').fill(title);
      await expect(form.getByTestId('category-seo-title-count')).toContainText(`${title.length} / 70`);
      await form.getByTestId('category-seo-description').fill('E2E açıklama satırı');
      await expect(form.getByTestId('category-seo-description-count')).toContainText('19 / 160');
      await form.getByTestId('category-seo-guide').fill(guide);
      await form.getByTestId('category-seo-factors').fill(eligibleText(90, 'E2E fiyat'));

      await expect(form.getByTestId('category-seo-faq-empty')).toBeVisible();
      await form.getByTestId('category-seo-faq-add').click();
      await form.getByTestId('category-seo-faq-add').click();
      await expect(form.getByTestId('category-seo-faq-row')).toHaveCount(2);
      await expect(form.getByTestId('category-seo-faq-count')).toHaveText('2 / 20');
      await form.getByTestId('category-seo-faq-question').first().fill('E2E sorusu nedir?');
      // Half a row is named before it is sent.
      await expect(form.getByTestId('category-seo-faq-half')).toBeVisible();
      await expect(form.getByTestId('category-seo-save')).toBeDisabled();
      await form.getByTestId('category-seo-faq-answer').first().fill('E2E cevabı budur.');
      await form.getByTestId('category-seo-faq-remove').nth(1).click();
      await expect(form.getByTestId('category-seo-faq-row')).toHaveCount(1);
      await form.getByTestId('category-seo-save').click();
      await expect(page.getByTestId('category-seo-saved')).toBeVisible();

      const saved = await prisma().serviceCategory.findUniqueOrThrow({ where: { id: category.id } });
      expect([saved.seoTitle, saved.seoDescription, saved.editorialDecisionGuide]).toEqual([title, 'E2E açıklama satırı', guide]);
      expect(saved.editorialFaq).toEqual([{ question: 'E2E sorusu nedir?', answer: 'E2E cevabı budur.' }]);

      const publicPage = await request.get(`${primaryRuntime.webUrl}/categories/${category.slug}`);
      expect(publicPage.status()).toBe(200);
      const body = await publicPage.text();
      expect(body.match(/<title>([^<]*)<\/title>/)?.[1]).toBe(title);
      expect(body).toContain('E2E açıklama satırı');
      expect(body).toContain('E2E rehber metni');
      expect(body).toContain('E2E sorusu nedir?');
    } finally {
      await admin.close();
    }
  });

  test('phone and desktop: the four screens never scroll sideways', async ({ browser }) => {
    const admin = await openAs(browser, 'super');
    try {
      for (const viewport of [
        { width: 375, height: 812 },
        { width: 1440, height: 900 },
      ]) {
        await admin.page.setViewportSize(viewport);
        for (const path of ['/seo', '/seo/indexing', '/seo/slugs', '/seo/redirects', '/seo/redirects?yonlendirme=yeni']) {
          await admin.gotoAdmin(path);
          await expect(admin.page.locator('h1').first()).toBeVisible();
          const overflow = await admin.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          expect(overflow, `${path} at ${viewport.width}px`).toBeLessThanOrEqual(0);
        }
      }
    } finally {
      await admin.close();
    }
  });
});
