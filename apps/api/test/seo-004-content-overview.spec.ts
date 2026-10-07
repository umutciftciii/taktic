import { AdminPermission, ServiceCategoryKind, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEO_INDEX_THRESHOLDS } from '../src/modules/seo/seo-index-eligibility';
import {
  createAdminWithPermissions,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  indexEligibleText,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * SEO-004 — a category's SEO content (write, audit, public read, the index
 * rule reading it), the overview's figures and the non-indexable list.
 */

let ctx: TestContext;
let root: { cookie: string; id: string };

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  root = { id: user.id, cookie: await loginAs(ctx.prisma, user.id) };
});

function patchContent(categoryId: string, body: unknown, cookie = root.cookie) {
  return request(ctx.server).patch(`/admin/seo/categories/${categoryId}/content`).set('Cookie', cookie).send(body as object);
}

const FULL_CONTENT = {
  seoTitle: 'Kombi Servisi — Teklif Al',
  seoDescription: 'Bölgenizdeki onaylı kombi servislerinden teklif alın.',
  editorialDecisionGuide: indexEligibleText(80, 'Nasıl seçilir'),
  editorialPriceFactors: indexEligibleText(80, 'Fiyat'),
  editorialFaq: [{ question: 'Bakım ne kadar sürer?', answer: indexEligibleText(80, 'Cevap') }],
};

describe('category SEO content', () => {
  it('writes, audits and serves the five fields; the index rule reads them', async () => {
    const category = await createCategory(ctx.prisma, 'Kombi');
    await ctx.prisma.serviceCategory.update({
      where: { id: category.id },
      data: { description: indexEligibleText(SEO_INDEX_THRESHOLDS.categoryDescriptionMinChars) },
    });

    const before = await request(ctx.server).get(`/admin/seo/categories/${category.id}/content`).set('Cookie', root.cookie).expect(200);
    expect(before.body.evaluation.indexable).toBe(false);
    expect(before.body.evaluation.reasons.map((reason: { block: string }) => reason.block)).toEqual([
      'decisionGuide',
      'priceFactors',
      'faq',
    ]);

    const saved = await patchContent(category.id, FULL_CONTENT).expect(200);
    expect(saved.body).toMatchObject({ ...FULL_CONTENT, evaluation: { indexable: true, reasons: [] } });

    const page = await request(ctx.server).get(`/categories/${category.slug}`).expect(200);
    expect(page.body).toMatchObject({ ...FULL_CONTENT, seoIndexable: true });
    // The public page carries the boolean and never the reasons.
    expect(page.text).not.toMatch(/CATEGORY_|reasons|evaluation/);
    const sitemap = await request(ctx.server).get('/sitemap/entries').expect(200);
    expect(sitemap.body.categories.map((row: { slug: string }) => row.slug)).toEqual([category.slug]);

    const audit = await ctx.prisma.catalogAuditLog.findMany({ where: { entityId: category.id } });
    expect(audit).toHaveLength(1);
    expect((audit[0]!.changes as { field: string }[]).map((change) => change.field)).toEqual([
      'seoTitle',
      'seoDescription',
      'editorialDecisionGuide',
      'editorialPriceFactors',
      'editorialFaq',
    ]);
    expect(audit[0]!.actorId).toBe(root.id);

    // Clearing a block takes the page back out of the index; an unchanged save records nothing.
    await patchContent(category.id, { editorialFaq: [] }).expect(200);
    expect((await request(ctx.server).get(`/categories/${category.slug}`).expect(200)).body.seoIndexable).toBe(false);
    await patchContent(category.id, { seoTitle: FULL_CONTENT.seoTitle }).expect(200);
    expect(await ctx.prisma.catalogAuditLog.count({ where: { entityId: category.id } })).toBe(2);
  });

  it('refuses invalid content with the field named, writing nothing', async () => {
    const category = await createCategory(ctx.prisma, 'Kombi');
    const refused = await patchContent(category.id, { seoTitle: 'x'.repeat(71) }).expect(400);
    expect(refused.body).toMatchObject({ code: 'SEO_CONTENT_INVALID', field: 'seoTitle' });
    await patchContent(category.id, { editorialFaq: [{ question: 'q' }] }).expect(400);
    await patchContent(category.id, { slug: 'baska' }).expect(400);
    await patchContent('missing', { seoTitle: 'x' }).expect(404);
    expect(await ctx.prisma.catalogAuditLog.count()).toBe(0);
  });

  it('keeps the page content out of the public listing', async () => {
    const category = await createCategory(ctx.prisma, 'Kombi');
    await patchContent(category.id, FULL_CONTENT).expect(200);
    const list = await request(ctx.server).get('/categories').expect(200);
    const row = list.body.find((item: { id: string }) => item.id === category.id);
    for (const field of ['seoTitle', 'seoDescription', 'editorialDecisionGuide', 'editorialPriceFactors', 'editorialFaq']) {
      expect(row, field).not.toHaveProperty(field);
    }
  });

  it('needs SEO_CONTENT_WRITE to write and SEO_READ to read', async () => {
    const category = await createCategory(ctx.prisma, 'Kombi');
    const reader = await loginAs(ctx.prisma, (await createAdminWithPermissions(ctx.prisma, [AdminPermission.SEO_READ])).admin.id);
    const writer = await loginAs(
      ctx.prisma,
      (await createAdminWithPermissions(ctx.prisma, [AdminPermission.SEO_CONTENT_WRITE])).admin.id,
    );
    const categories = await loginAs(
      ctx.prisma,
      (await createAdminWithPermissions(ctx.prisma, [AdminPermission.CATEGORIES_WRITE])).admin.id,
    );
    await request(ctx.server).get(`/admin/seo/categories/${category.id}/content`).set('Cookie', reader).expect(200);
    await patchContent(category.id, { seoTitle: 'x' }, reader).expect(403);
    await patchContent(category.id, { seoTitle: 'x' }, categories).expect(403);
    await patchContent(category.id, { seoTitle: 'x' }, writer).expect(200);
  });
});

describe('overview and the non-indexable list', () => {
  it('counts what the rules say, names each closed page’s reasons, and invents no figure', async () => {
    const indexable = await createCategory(ctx.prisma, 'Açık');
    await ctx.prisma.serviceCategory.update({
      where: { id: indexable.id },
      data: { description: indexEligibleText(400) },
    });
    await patchContent(indexable.id, FULL_CONTENT).expect(200);
    const thin = await createCategory(ctx.prisma, 'İnce');
    await createCategory(ctx.prisma, 'Yönlendirici', { kind: ServiceCategoryKind.ROUTER });
    await createCategory(ctx.prisma, 'Taslak', { status: ServiceCategoryStatus.DRAFT });
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: indexable.id });

    const overview = await request(ctx.server).get('/admin/seo/overview').set('Cookie', root.cookie).expect(200);
    expect(overview.body.pages).toEqual({
      static: { indexable: 2 },
      categories: { public: 3, indexable: 1 },
      providers: { public: 1, indexable: 0 },
      showcaseCards: { live: 0, indexable: 0 },
      showcaseShelf: { indexable: false, indexableCards: 0, required: 5 },
    });
    expect(overview.body.indexableCount).toBe(3);
    // Closed here (APP_ENVIRONMENT is not production): the sitemap lists nothing.
    expect(overview.body.site).toMatchObject({ open: false, source: 'API_ENVIRONMENT' });
    expect(overview.body.sitemapUrlCount).toBe(0);
    expect(overview.body.nonIndexableCount).toBe(4);
    expect(overview.body.thresholds).toEqual(SEO_INDEX_THRESHOLDS);
    expect(overview.body.redirects).toEqual({ active: 0, served: 0, notServed: 0 });
    expect(overview.body.notFound).toEqual({ open: 0 });
    // No visits, no hit counts, no "last generated" time: there is no data for them.
    expect(JSON.stringify(overview.body)).not.toMatch(/visit|hit|lastGenerated|ziyaret/i);

    const pages = await request(ctx.server).get('/admin/seo/pages').set('Cookie', root.cookie).expect(200);
    expect(pages.body.total).toBe(4);
    const byType = Object.fromEntries(pages.body.items.map((item: { type: string; id: string }) => [`${item.type}:${item.id}`, item]));
    expect(byType[`CATEGORY:${thin.id}`]).toMatchObject({ path: `/categories/${thin.slug}` });
    expect(byType[`PROVIDER:${provider.id}`].reasons.map((reason: { code: string }) => reason.code)).toContain(
      'PROVIDER_DESCRIPTION_TOO_SHORT',
    );
    expect(byType['SHOWCASE_SHELF:vitrin'].reasons).toEqual([{ code: 'SHELF_TOO_FEW_INDEXABLE_CARDS', required: 5, actual: 0 }]);

    const routers = await request(ctx.server)
      .get('/admin/seo/pages')
      .query({ reason: 'CATEGORY_NOT_LEAF' })
      .set('Cookie', root.cookie)
      .expect(200);
    expect(routers.body.items).toHaveLength(1);
    const providersOnly = await request(ctx.server).get('/admin/seo/pages').query({ type: 'PROVIDER' }).set('Cookie', root.cookie).expect(200);
    expect(providersOnly.body.items.map((item: { id: string }) => item.id)).toEqual([provider.id]);
    await request(ctx.server).get('/admin/seo/pages').query({ reason: 'MADE_UP' }).set('Cookie', root.cookie).expect(400);
  });

  it('lists slugs with their public state, last change and earlier addresses', async () => {
    const category = await createCategory(ctx.prisma, 'Kombi');
    await request(ctx.server).post(`/admin/seo/categories/${category.id}/slug`).set('Cookie', root.cookie).send({ slug: 'kombi-b' }).expect(200);
    await request(ctx.server).post(`/admin/seo/categories/${category.id}/slug`).set('Cookie', root.cookie).send({ slug: 'kombi-c' }).expect(200);
    await createCategory(ctx.prisma, 'Taslak', { status: ServiceCategoryStatus.DRAFT });

    const slugs = await request(ctx.server).get('/admin/seo/slugs').set('Cookie', root.cookie).expect(200);
    const row = slugs.body.items.find((item: { id: string }) => item.id === category.id);
    expect(row).toMatchObject({ slug: 'kombi-c', path: '/categories/kombi-c', publiclyReachable: true, previousAddressCount: 2 });
    expect(row.lastSlugChangeAt).toEqual(expect.any(String));
    expect(slugs.body.total).toBe(2);
    expect(slugs.body.items.find((item: { id: string }) => item.id !== category.id)).toMatchObject({
      publiclyReachable: false,
      lastSlugChangeAt: null,
      previousAddressCount: 0,
    });
  });
});
