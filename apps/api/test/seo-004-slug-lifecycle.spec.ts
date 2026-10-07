import {
  AdminPermission,
  SeoAuditAction,
  SeoRedirectOrigin,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdminWithPermissions,
  createCategory,
  createTestApp,
  createUser,
  indexEligibleText,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';
import { SEO_INDEX_THRESHOLDS } from '../src/modules/seo/seo-index-eligibility';

/**
 * SEO-004 — the slug lifecycle: one server-side path for every slug change,
 * the 301 that comes with it, and the redirect graph it must leave intact.
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

async function snapshot() {
  const response = await request(ctx.server).get('/seo/redirects/active').expect(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.body.redirects as { source: string; target: string; status: number }[];
}

function changeSlug(categoryId: string, slug: string, cookie = root.cookie) {
  return request(ctx.server).post(`/admin/seo/categories/${categoryId}/slug`).set('Cookie', cookie).send({ slug });
}

async function graph() {
  return ctx.prisma.seoRedirect.findMany({ where: { active: true }, orderBy: { sourcePath: 'asc' } });
}

/** Invariants 1–3 of the redirect graph, checked on the stored rows. */
async function expectGraphIntact() {
  const active = await graph();
  const sources = active.map((row) => row.sourcePath);
  expect(new Set(sources).size).toBe(sources.length);
  const sourceSet = new Set(sources);
  for (const row of active) {
    expect(sourceSet.has(row.targetPath), `${row.sourcePath} → ${row.targetPath} is a chain`).toBe(false);
    expect(row.sourcePath).not.toBe(row.targetPath);
  }
}

async function indexableCategory(name: string) {
  const category = await createCategory(ctx.prisma, name);
  return ctx.prisma.serviceCategory.update({
    where: { id: category.id },
    data: {
      description: indexEligibleText(SEO_INDEX_THRESHOLDS.categoryDescriptionMinChars),
      editorialDecisionGuide: indexEligibleText(80, 'rehber'),
      editorialPriceFactors: indexEligibleText(80, 'fiyat'),
      editorialFaq: [{ question: 'Ne kadar sürer?', answer: indexEligibleText(80, 'sss') }],
    },
  });
}

describe('a public category’s slug change', () => {
  it('writes the 301 old → new in the same transaction, and the old address leaves the sitemap', async () => {
    const category = await indexableCategory('Kombi');
    const before = await request(ctx.server).get('/sitemap/entries').expect(200);
    expect(before.body.categories.map((row: { slug: string }) => row.slug)).toEqual([category.slug]);

    const response = await changeSlug(category.id, 'Kombi Bakım Servisi').expect(200);
    expect(response.body.category).toMatchObject({ slug: 'kombi-bakim-servisi', path: '/categories/kombi-bakim-servisi' });
    expect(response.body.redirect).toMatchObject({
      sourcePath: `/categories/${category.slug}`,
      targetPath: '/categories/kombi-bakim-servisi',
      type: 'PERMANENT',
      status: 301,
      origin: 'SLUG_CHANGE',
    });

    expect(await snapshot()).toEqual([
      { source: `/categories/${category.slug}`, target: '/categories/kombi-bakim-servisi', status: 301 },
    ]);
    // The old address is gone from the public read and the sitemap; the new one is the page.
    await request(ctx.server).get(`/categories/${category.slug}`).expect(404);
    const page = await request(ctx.server).get('/categories/kombi-bakim-servisi').expect(200);
    expect(page.body.slug).toBe('kombi-bakim-servisi');
    expect(page.body.seoIndexable).toBe(true);
    const after = await request(ctx.server).get('/sitemap/entries').expect(200);
    expect(after.body.categories.map((row: { slug: string }) => row.slug)).toEqual(['kombi-bakim-servisi']);

    // Audited twice: the slug with the category, the redirect in the SEO log.
    const catalogue = await ctx.prisma.catalogAuditLog.findMany({ where: { entityId: category.id } });
    expect(catalogue).toHaveLength(1);
    expect(catalogue[0]!.changes).toEqual([{ field: 'slug', from: category.slug, to: 'kombi-bakim-servisi' }]);
    const seo = await ctx.prisma.seoAuditLog.findMany({ where: { entityId: response.body.redirect.id } });
    expect(seo.map((row) => row.action)).toEqual([SeoAuditAction.REDIRECT_CREATED]);
    expect(seo[0]!.actorId).toBe(root.id);
  });

  it('goes through the same path when the category form’s PATCH changes the slug', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    await request(ctx.server)
      .patch(`/categories/${category.id}`)
      .set('Cookie', root.cookie)
      .send({ slug: 'klima-yeni' })
      .expect(200);
    expect(await snapshot()).toEqual([
      { source: `/categories/${category.slug}`, target: '/categories/klima-yeni', status: 301 },
    ]);
  });

  it('writes no redirect for a category that was not public: its old address was a 404 and stays one', async () => {
    for (const options of [
      { status: ServiceCategoryStatus.DRAFT },
      { status: ServiceCategoryStatus.INACTIVE },
      { kind: ServiceCategoryKind.GROUP },
    ]) {
      const category = await createCategory(ctx.prisma, 'Taslak', options);
      const response = await changeSlug(category.id, `yeni-${category.id.slice(-6)}`).expect(200);
      expect(response.body.redirect).toBeNull();
    }
    expect(await ctx.prisma.seoRedirect.count()).toBe(0);
  });

  it('a router category is public, so it gets its 301 too', async () => {
    const router = await createCategory(ctx.prisma, 'Yönlendirici', { kind: ServiceCategoryKind.ROUTER });
    const response = await changeSlug(router.id, 'yonlendirici-yeni').expect(200);
    expect(response.body.redirect).toMatchObject({ status: 301 });
  });

  it('rolls the slug back when the redirect cannot be written', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    await ctx.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION seo004_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'seo004 test: redirect insert refused'; END; $$;`);
    await ctx.prisma.$executeRawUnsafe(
      `CREATE TRIGGER seo004_test_refuse BEFORE INSERT ON "SeoRedirect" FOR EACH ROW EXECUTE FUNCTION seo004_test_refuse();`,
    );
    try {
      await changeSlug(category.id, 'klima-yeni').expect(500);
    } finally {
      await ctx.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS seo004_test_refuse ON "SeoRedirect";`);
      await ctx.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS seo004_test_refuse();`);
    }
    const stored = await ctx.prisma.serviceCategory.findUniqueOrThrow({ where: { id: category.id } });
    expect(stored.slug).toBe(category.slug);
    expect(await ctx.prisma.seoRedirect.count()).toBe(0);
    expect(await ctx.prisma.catalogAuditLog.count({ where: { entityId: category.id } })).toBe(0);
  });
});

describe('the graph a slug change leaves behind', () => {
  it('retargets every redirect that led to the old address (no chain)', async () => {
    const category = await createCategory(ctx.prisma, 'Kombi');
    const manual = await request(ctx.server)
      .post('/admin/seo/redirects')
      .set('Cookie', root.cookie)
      .send({ sourcePath: '/kategori/kombi', targetPath: `/categories/${category.slug}`, type: 'PERMANENT', reason: 'eski site' })
      .expect(201);

    await changeSlug(category.id, 'kombi-yeni').expect(200);

    expect(await snapshot()).toEqual([
      { source: `/categories/${category.slug}`, target: '/categories/kombi-yeni', status: 301 },
      { source: '/kategori/kombi', target: '/categories/kombi-yeni', status: 301 },
    ]);
    const audit = await ctx.prisma.seoAuditLog.findMany({ where: { entityId: manual.body.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((row) => row.action)).toEqual([SeoAuditAction.REDIRECT_CREATED, SeoAuditAction.REDIRECT_RETARGETED]);
    expect(audit[1]!.changes).toEqual([
      { field: 'targetPath', from: `/categories/${category.slug}`, to: '/categories/kombi-yeni' },
    ]);
    await expectGraphIntact();
  });

  it('A → B → C keeps one hop for every old address', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const a = category.slug;
    await changeSlug(category.id, 'klima-b').expect(200);
    await changeSlug(category.id, 'klima-c').expect(200);
    // The snapshot is ordered by source; `kategori-…` sorts before `klima-b`.
    expect(await snapshot()).toEqual([
      { source: `/categories/${a}`, target: '/categories/klima-c', status: 301 },
      { source: '/categories/klima-b', target: '/categories/klima-c', status: 301 },
    ]);
    await expectGraphIntact();
  });

  it('A → B → A reclaims the old address instead of writing a cycle', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const a = category.slug;
    const first = await changeSlug(category.id, 'klima-b').expect(200);
    const back = await changeSlug(category.id, a).expect(200);

    expect(back.body.reclaimedRedirectIds).toEqual([first.body.redirect.id]);
    expect(await snapshot()).toEqual([{ source: '/categories/klima-b', target: `/categories/${a}`, status: 301 }]);
    const reclaimed = await ctx.prisma.seoRedirect.findUniqueOrThrow({ where: { id: first.body.redirect.id } });
    expect(reclaimed).toMatchObject({ active: false, deactivatedById: root.id });
    const actions = await ctx.prisma.seoAuditLog.findMany({ where: { entityId: first.body.redirect.id }, orderBy: { createdAt: 'asc' } });
    expect(actions.map((row) => row.action)).toEqual([SeoAuditAction.REDIRECT_CREATED, SeoAuditAction.REDIRECT_RECLAIMED]);
    await request(ctx.server).get(`/categories/${a}`).expect(200);
    await expectGraphIntact();
  });

  it('refuses a new slug that another redirect owns (SLUG_HELD_BY_REDIRECT), changing nothing', async () => {
    const target = await createCategory(ctx.prisma, 'Hedef');
    const category = await createCategory(ctx.prisma, 'Klima');
    await request(ctx.server)
      .post('/admin/seo/redirects')
      .set('Cookie', root.cookie)
      .send({ sourcePath: '/categories/eski-klima', targetPath: `/categories/${target.slug}`, type: 'PERMANENT', reason: 'eski' })
      .expect(201);

    const refused = await changeSlug(category.id, 'eski-klima').expect(409);
    expect(refused.body.code).toBe('SLUG_HELD_BY_REDIRECT');
    expect((await ctx.prisma.serviceCategory.findUniqueOrThrow({ where: { id: category.id } })).slug).toBe(category.slug);

    // Another category's earlier address is not "its own": held, too.
    const other = await createCategory(ctx.prisma, 'Diğer');
    await changeSlug(other.id, 'diger-yeni').expect(200);
    expect((await changeSlug(category.id, other.slug).expect(409)).body.code).toBe('SLUG_HELD_BY_REDIRECT');
  });

  it('derives, checks and refuses slugs on the server', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const taken = await createCategory(ctx.prisma, 'Dolu');
    expect((await changeSlug(category.id, taken.slug).expect(409)).body.code).toBe('CATEGORY_SLUG_TAKEN');
    expect((await changeSlug(category.id, 'Yeni').expect(400)).body).toMatchObject({ code: 'CATEGORY_SLUG_INVALID', refusal: 'RESERVED' });
    expect((await changeSlug(category.id, '日本').expect(400)).body).toMatchObject({ refusal: 'EMPTY' });
    expect((await changeSlug(category.id, 'a'.repeat(81)).expect(400)).body).toMatchObject({ refusal: 'TOO_LONG' });
    // The strict PATCH holds the same reserved list.
    await request(ctx.server).patch(`/categories/${category.id}`).set('Cookie', root.cookie).send({ slug: 'admin' }).expect(400);

    const same = await changeSlug(category.id, category.slug).expect(200);
    expect(same.body.redirect).toBeNull();
    expect(await ctx.prisma.seoRedirect.count()).toBe(0);
  });

  it('previews what a save would do without doing it', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const preview = await request(ctx.server)
      .get(`/admin/seo/categories/${category.id}/slug-preview`)
      .query({ slug: 'Klima Bakımı' })
      .set('Cookie', root.cookie)
      .expect(200);
    expect(preview.body).toMatchObject({
      slug: 'klima-bakimi',
      newPath: '/categories/klima-bakimi',
      conflict: null,
      createsRedirect: true,
      retargetCount: 0,
    });
    expect(await ctx.prisma.seoRedirect.count()).toBe(0);
  });
});

describe('concurrency', () => {
  it('two parallel renames of one category leave one slug and an intact graph', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const results = await Promise.all([changeSlug(category.id, 'klima-x'), changeSlug(category.id, 'klima-y')]);
    for (const result of results) expect([200, 409]).toContain(result.status);
    const stored = await ctx.prisma.serviceCategory.findUniqueOrThrow({ where: { id: category.id } });
    expect(['klima-x', 'klima-y']).toContain(stored.slug);
    await expectGraphIntact();
    // Every served redirect leads to the slug the category has now.
    for (const row of await snapshot()) expect(row.target).toBe(`/categories/${stored.slug}`);
  });

  it('a rename racing a manual redirect into the old address cannot leave a chain', async () => {
    for (let round = 0; round < 3; round += 1) {
      const category = await createCategory(ctx.prisma, `Yarış ${round}`);
      const [rename, manual] = await Promise.all([
        changeSlug(category.id, `yaris-yeni-${round}`),
        request(ctx.server)
          .post('/admin/seo/redirects')
          .set('Cookie', root.cookie)
          .send({ sourcePath: `/eski/yaris-${round}`, targetPath: `/categories/${category.slug}`, type: 'PERMANENT', reason: 'yarış' }),
      ]);
      expect([200, 409]).toContain(rename.status);
      expect([201, 409]).toContain(manual.status);
      await expectGraphIntact();
    }
  });

  it('parallel manual redirects with the same source store one', async () => {
    const target = await createCategory(ctx.prisma, 'Hedef');
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        request(ctx.server)
          .post('/admin/seo/redirects')
          .set('Cookie', root.cookie)
          .send({ sourcePath: '/eski/ayni', targetPath: `/categories/${target.slug}`, type: 'TEMPORARY', reason: 'yarış' }),
      ),
    );
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    for (const result of results.filter((r) => r.status !== 201)) expect(result.status).toBe(409);
    expect(await ctx.prisma.seoRedirect.count({ where: { active: true } })).toBe(1);
  });
});

describe('who may change a slug', () => {
  it('needs CATEGORIES_WRITE; SEO permissions alone are not enough', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const seoOnly = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.SEO_READ,
      AdminPermission.SEO_CONTENT_WRITE,
      AdminPermission.SEO_REDIRECTS_WRITE,
    ]);
    await changeSlug(category.id, 'klima-yeni', await loginAs(ctx.prisma, seoOnly.admin.id)).expect(403);
    const writer = await createAdminWithPermissions(ctx.prisma, [AdminPermission.CATEGORIES_WRITE]);
    const ok = await changeSlug(category.id, 'klima-yeni', await loginAs(ctx.prisma, writer.admin.id)).expect(200);
    expect(ok.body.redirect).toMatchObject({ origin: SeoRedirectOrigin.SLUG_CHANGE });
    expect((await ctx.prisma.seoRedirect.findFirstOrThrow()).createdById).toBe(writer.admin.id);
  });
});

describe('the illustration key survives a slug change', () => {
  it('keeps illustrationKey on the row and in the public read', async () => {
    const category = await createCategory(ctx.prisma, 'Kombi');
    await ctx.prisma.serviceCategory.update({ where: { id: category.id }, data: { illustrationKey: 'kombi-servisi' } });
    await changeSlug(category.id, 'kombi-bakimi').expect(200);
    const page = await request(ctx.server).get('/categories/kombi-bakimi').expect(200);
    expect(page.body.illustrationKey).toBe('kombi-servisi');
    const list = await request(ctx.server).get('/categories').expect(200);
    expect(list.body.find((row: { id: string }) => row.id === category.id).illustrationKey).toBe('kombi-servisi');
  });
});
