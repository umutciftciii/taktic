import { AdminPermission, ProviderStatus, SeoAuditAction, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdminWithPermissions,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createProviderProfile,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * SEO-004 — manual redirects: the address contract, the graph rules, what is
 * served, soft deletion, and who may do what.
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

function create(body: Record<string, unknown>, cookie = root.cookie) {
  return request(ctx.server)
    .post('/admin/seo/redirects')
    .set('Cookie', cookie)
    .send({ type: 'PERMANENT', reason: 'test', ...body });
}

async function snapshot() {
  return (await request(ctx.server).get('/seo/redirects/active').expect(200)).body.redirects as {
    source: string;
    target: string;
    status: number;
  }[];
}

describe('the address contract on the way in', () => {
  it.each([
    ['https://evil.com/x', 'ABSOLUTE_URL'],
    ['//evil.com', 'PROTOCOL_RELATIVE'],
    ['/\\evil.com', 'BACKSLASH'],
    ['/%2Fevil.com', 'ENCODED_SEPARATOR'],
    ['/%5Cevil.com', 'ENCODED_SEPARATOR'],
    ['/eski/%252F', 'DOUBLE_ENCODED'],
    ['/eski/../admin', 'DOT_SEGMENT'],
    ['/eski/a%00', 'CONTROL_CHARACTER'],
    ['/eski?utm=1', 'QUERY'],
    ['/eski#x', 'FRAGMENT'],
    ['eski', 'NOT_ROOTED'],
    [`/${'a'.repeat(200)}`, 'TOO_LONG'],
  ])('refuses the source %j (%s)', async (sourcePath, refusal) => {
    const target = await createCategory(ctx.prisma, 'Hedef');
    const response = await create({ sourcePath, targetPath: `/categories/${target.slug}` }).expect(400);
    expect(response.body).toMatchObject({ code: 'SEO_PATH_INVALID', field: 'sourcePath', refusal });
  });

  it.each([
    ['https://evil.com/categories/x', 'SEO_PATH_INVALID'],
    ['//evil.com/categories/x', 'SEO_PATH_INVALID'],
    ['javascript:alert(1)', 'SEO_PATH_INVALID'],
    ['/login', 'SEO_TARGET_NOT_CANONICAL'],
    ['/kategori/x', 'SEO_TARGET_NOT_CANONICAL'],
    ['/categories/x/y', 'SEO_TARGET_NOT_CANONICAL'],
  ])('refuses the target %j — never off the site, never a non-page', async (targetPath, code) => {
    const response = await create({ sourcePath: '/eski/sayfa', targetPath }).expect(400);
    expect(response.body.code).toBe(code);
  });

  it('refuses reserved, root and file-like sources', async () => {
    const target = await createCategory(ctx.prisma, 'Hedef');
    for (const sourcePath of ['/', '/login', '/account/x', '/api/x', '/_next/x', '/categories', '/vitrin', '/eski.html', '/brand/x']) {
      const response = await create({ sourcePath, targetPath: `/categories/${target.slug}` });
      expect(response.status, sourcePath).toBe(400);
      expect(['SEO_SOURCE_RESERVED', 'SEO_PATH_INVALID'], sourcePath).toContain(response.body.code);
    }
  });

  it('stores the normalised spelling: case, encoding and one trailing slash fold into one address', async () => {
    const target = await createCategory(ctx.prisma, 'Hedef');
    const created = await create({ sourcePath: '/Kategori/Ev-Temizli%C4%9Fi/', targetPath: `/categories/${target.slug}/` }).expect(201);
    expect(created.body).toMatchObject({ sourcePath: '/kategori/ev-temizliği', targetPath: `/categories/${target.slug}` });
    // The same address in another spelling is the same source.
    const duplicate = await create({ sourcePath: '/kategori/EV-TEMIZLIĞI', targetPath: '/' }).expect(409);
    expect(duplicate.body.code).toBe('SEO_SOURCE_TAKEN');
  });

  it('requires a reason for a manual redirect', async () => {
    const target = await createCategory(ctx.prisma, 'Hedef');
    const response = await create({ sourcePath: '/eski', targetPath: `/categories/${target.slug}`, reason: '   ' }).expect(400);
    expect(response.body.code).toBe('SEO_REASON_REQUIRED');
  });
});

describe('the graph rules', () => {
  it('refuses a redirect to itself, a chain in either direction, and so any cycle', async () => {
    const a = await createCategory(ctx.prisma, 'A');
    expect((await create({ sourcePath: `/categories/eski-a`, targetPath: '/categories/eski-a' }).expect(400)).body.code).toBe(
      'SEO_REDIRECT_TO_ITSELF',
    );
    await create({ sourcePath: '/eski/x', targetPath: `/categories/${a.slug}` }).expect(201);
    // Onward: the target is itself a source.
    const onward = await create({ sourcePath: '/eski/y', targetPath: '/eski/x' }).expect(400);
    expect(onward.body.code).toBe('SEO_TARGET_NOT_CANONICAL');
    await create({ sourcePath: '/categories/kapali', targetPath: `/categories/${a.slug}` }).expect(201);
    const chainOnward = await create({ sourcePath: '/eski/z', targetPath: '/categories/kapali' }).expect(409);
    expect(chainOnward.body).toMatchObject({ code: 'SEO_REDIRECT_CHAIN', direction: 'TARGET_IS_SOURCE' });
    // Inbound: something already leads to the new source.
    const b = await createCategory(ctx.prisma, 'B');
    await ctx.prisma.serviceCategory.update({ where: { id: b.id }, data: { slug: 'gecici-b' } });
    await create({ sourcePath: '/eski/w', targetPath: '/categories/gecici-b' }).expect(201);
    await ctx.prisma.serviceCategory.update({ where: { id: b.id }, data: { status: ServiceCategoryStatus.INACTIVE, isActive: false } });
    const inbound = await create({ sourcePath: '/categories/gecici-b', targetPath: `/categories/${a.slug}` }).expect(409);
    expect(inbound.body).toMatchObject({ code: 'SEO_REDIRECT_CHAIN', direction: 'SOURCE_IS_TARGET' });
  });

  it('refuses a live page as a source and a dead page as a target', async () => {
    const live = await createCategory(ctx.prisma, 'Canlı');
    const draft = await createCategory(ctx.prisma, 'Taslak', { status: ServiceCategoryStatus.DRAFT });
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: live.id });
    const pending = await createProviderProfile(ctx.prisma, { status: ProviderStatus.PENDING_REVIEW });

    expect((await create({ sourcePath: `/categories/${live.slug}`, targetPath: '/' }).expect(409)).body.code).toBe(
      'SEO_SOURCE_IS_LIVE_PAGE',
    );
    expect((await create({ sourcePath: `/isletme/${provider.id}`, targetPath: '/' }).expect(409)).body.code).toBe(
      'SEO_SOURCE_IS_LIVE_PAGE',
    );
    expect((await create({ sourcePath: '/eski/a', targetPath: `/categories/${draft.slug}` }).expect(409)).body.code).toBe(
      'SEO_TARGET_NOT_LIVE',
    );
    expect((await create({ sourcePath: '/eski/b', targetPath: `/isletme/${pending.id}` }).expect(409)).body.code).toBe(
      'SEO_TARGET_NOT_LIVE',
    );
    expect((await create({ sourcePath: '/eski/c', targetPath: '/vitrin/yok' }).expect(409)).body.code).toBe('SEO_TARGET_NOT_LIVE');
    // A non-public category's address is not a page: it may be a source.
    await create({ sourcePath: `/categories/${draft.slug}`, targetPath: `/categories/${live.slug}` }).expect(201);
    // Every always-live page is a valid target.
    for (const [index, targetPath] of ['/', '/categories', '/vitrin', `/isletme/${provider.id}`].entries()) {
      await create({ sourcePath: `/eski/hedef-${index}`, targetPath }).expect(201);
    }
  });
});

describe('what the web is told to serve', () => {
  it('serves 301 and 302, and drops a row whose target died or whose source came alive — without rewriting it', async () => {
    const target = await createCategory(ctx.prisma, 'Hedef');
    const draft = await createCategory(ctx.prisma, 'Taslak', { status: ServiceCategoryStatus.DRAFT });
    await create({ sourcePath: '/eski/kalici', targetPath: `/categories/${target.slug}` }).expect(201);
    await create({ sourcePath: '/eski/gecici', targetPath: '/vitrin', type: 'TEMPORARY' }).expect(201);
    await create({ sourcePath: `/categories/${draft.slug}`, targetPath: `/categories/${target.slug}` }).expect(201);

    expect(await snapshot()).toEqual([
      { source: `/categories/${draft.slug}`, target: `/categories/${target.slug}`, status: 301 },
      { source: '/eski/gecici', target: '/vitrin', status: 302 },
      { source: '/eski/kalici', target: `/categories/${target.slug}`, status: 301 },
    ]);

    // The target closes: its two redirects stop being served, and are still on record.
    await ctx.prisma.serviceCategory.update({ where: { id: target.id }, data: { status: ServiceCategoryStatus.INACTIVE, isActive: false } });
    expect(await snapshot()).toEqual([{ source: '/eski/gecici', target: '/vitrin', status: 302 }]);
    expect(await ctx.prisma.seoRedirect.count({ where: { active: true } })).toBe(3);
    const overview = await request(ctx.server).get('/admin/seo/overview').set('Cookie', root.cookie).expect(200);
    expect(overview.body.redirects).toEqual({ active: 3, served: 1, notServed: 2 });

    // It reopens, and the source category is published: one comes back, the
    // other stays out because its source is a page now.
    await ctx.prisma.serviceCategory.update({ where: { id: target.id }, data: { status: ServiceCategoryStatus.ACTIVE, isActive: true } });
    await ctx.prisma.serviceCategory.update({ where: { id: draft.id }, data: { status: ServiceCategoryStatus.ACTIVE, isActive: true } });
    expect((await snapshot()).map((row) => row.source)).toEqual(['/eski/gecici', '/eski/kalici']);
  });

  it('carries nothing but the three fields per row, to anybody', async () => {
    const target = await createCategory(ctx.prisma, 'Hedef');
    await create({ sourcePath: '/eski/x', targetPath: `/categories/${target.slug}`, reason: 'Gizli sebep' }).expect(201);
    const response = await request(ctx.server).get('/seo/redirects/active').expect(200);
    expect(Object.keys(response.body).sort()).toEqual(['generatedAt', 'redirects']);
    expect(Object.keys(response.body.redirects[0]).sort()).toEqual(['source', 'status', 'target']);
    expect(response.text).not.toContain('Gizli sebep');
  });

  it('serves a live showcase card as a target', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
    const pkg = await createShowcasePackage(ctx.prisma);
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: provider.id,
      categoryId: category.id,
      title: 'Kart',
      areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    });
    await createLiveShowcasePlacement(ctx, { providerId: provider.id, cardId: card.id, versionId: version.id, packageId: pkg.id });
    await create({ sourcePath: '/eski/kart', targetPath: `/vitrin/${card.id}` }).expect(201);
    expect(await snapshot()).toEqual([{ source: '/eski/kart', target: `/vitrin/${card.id}`, status: 301 }]);
  });
});

describe('editing and removing', () => {
  it('changes target, type and reason — never the source — and audits each change', async () => {
    const a = await createCategory(ctx.prisma, 'A');
    const b = await createCategory(ctx.prisma, 'B');
    const created = await create({ sourcePath: '/eski/x', targetPath: `/categories/${a.slug}` }).expect(201);
    const updated = await request(ctx.server)
      .patch(`/admin/seo/redirects/${created.body.id}`)
      .set('Cookie', root.cookie)
      .send({ targetPath: `/categories/${b.slug}`, type: 'TEMPORARY', reason: 'kampanya' })
      .expect(200);
    expect(updated.body).toMatchObject({ sourcePath: '/eski/x', targetPath: `/categories/${b.slug}`, status: 302 });
    await request(ctx.server)
      .patch(`/admin/seo/redirects/${created.body.id}`)
      .set('Cookie', root.cookie)
      .send({ sourcePath: '/baska' })
      .expect(400);

    const detail = await request(ctx.server).get(`/admin/seo/redirects/${created.body.id}`).set('Cookie', root.cookie).expect(200);
    expect(detail.body.redirect).toMatchObject({ served: true, createdBy: { id: root.id } });
    expect(detail.body.history.items.map((item: { action: string }) => item.action)).toEqual([
      SeoAuditAction.REDIRECT_UPDATED,
      SeoAuditAction.REDIRECT_CREATED,
    ]);
    expect(detail.body.history.items[0]).toMatchObject({ domain: 'SEO_REDIRECT', reason: 'kampanya' });
  });

  it('keeps a slug change’s redirect permanent', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const changed = await request(ctx.server)
      .post(`/admin/seo/categories/${category.id}/slug`)
      .set('Cookie', root.cookie)
      .send({ slug: 'klima-yeni' })
      .expect(200);
    const refused = await request(ctx.server)
      .patch(`/admin/seo/redirects/${changed.body.redirect.id}`)
      .set('Cookie', root.cookie)
      .send({ type: 'TEMPORARY' })
      .expect(400);
    expect(refused.body.code).toBe('SEO_SLUG_REDIRECT_PERMANENT');
  });

  it('deactivates instead of deleting; the database refuses a hard delete', async () => {
    const target = await createCategory(ctx.prisma, 'Hedef');
    const created = await create({ sourcePath: '/eski/x', targetPath: `/categories/${target.slug}` }).expect(201);
    const removed = await request(ctx.server)
      .post(`/admin/seo/redirects/${created.body.id}/deactivate`)
      .set('Cookie', root.cookie)
      .send({ reason: 'artık gerekmiyor' })
      .expect(200);
    expect(removed.body.active).toBe(false);
    expect(await snapshot()).toEqual([]);
    await request(ctx.server).post(`/admin/seo/redirects/${created.body.id}/deactivate`).set('Cookie', root.cookie).send({}).expect(409);
    await request(ctx.server)
      .patch(`/admin/seo/redirects/${created.body.id}`)
      .set('Cookie', root.cookie)
      .send({ reason: 'x' })
      .expect(409);
    // The address is free again for a new row; the old one stays as history.
    await create({ sourcePath: '/eski/x', targetPath: '/' }).expect(201);
    expect(await ctx.prisma.seoRedirect.count({ where: { sourcePath: '/eski/x' } })).toBe(2);

    await expect(ctx.prisma.seoRedirect.delete({ where: { id: created.body.id } })).rejects.toThrow();
    expect(await ctx.prisma.seoRedirect.count()).toBe(2);
  });
});

describe('who may do what', () => {
  it('reads with SEO_READ, writes redirects with SEO_REDIRECTS_WRITE only', async () => {
    const target = await createCategory(ctx.prisma, 'Hedef');
    const reader = await loginAs(ctx.prisma, (await createAdminWithPermissions(ctx.prisma, [AdminPermission.SEO_READ])).admin.id);
    const content = await loginAs(
      ctx.prisma,
      (await createAdminWithPermissions(ctx.prisma, [AdminPermission.SEO_READ, AdminPermission.SEO_CONTENT_WRITE])).admin.id,
    );
    const writer = await loginAs(
      ctx.prisma,
      (await createAdminWithPermissions(ctx.prisma, [AdminPermission.SEO_REDIRECTS_WRITE])).admin.id,
    );
    const catalogue = await loginAs(ctx.prisma, (await createAdminWithPermissions(ctx.prisma, [AdminPermission.CATALOG_READ])).admin.id);
    const customer = await loginAs(ctx.prisma, (await createUser(ctx.prisma, { role: UserRole.CUSTOMER })).id);

    for (const path of ['/admin/seo/overview', '/admin/seo/pages', '/admin/seo/slugs', '/admin/seo/redirects', '/admin/seo/not-found']) {
      await request(ctx.server).get(path).set('Cookie', reader).expect(200);
      await request(ctx.server).get(path).set('Cookie', catalogue).expect(403);
      await request(ctx.server).get(path).set('Cookie', customer).expect(403);
      await request(ctx.server).get(path).expect(401);
    }

    const body = { sourcePath: '/eski/x', targetPath: `/categories/${target.slug}` };
    await create(body, reader).expect(403);
    await create(body, content).expect(403);
    const created = await create(body, writer).expect(201);
    // Writing is not reading: the writer alone cannot list.
    await request(ctx.server).get('/admin/seo/redirects').set('Cookie', writer).expect(403);
    await request(ctx.server).post(`/admin/seo/redirects/${created.body.id}/deactivate`).set('Cookie', reader).send({}).expect(403);
    await request(ctx.server).post(`/admin/seo/redirects/${created.body.id}/deactivate`).set('Cookie', writer).send({}).expect(200);
  });
});
