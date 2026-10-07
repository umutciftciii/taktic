import { AdminPermission, SeoAuditAction, SeoNotFoundRouteFamily, SeoNotFoundStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SeoRetentionScheduler } from '../src/modules/seo/admin/seo-retention.scheduler';
import { NOT_FOUND_LIMITS, SeoNotFoundRecorder } from '../src/modules/seo/seo-not-found.recorder';
import {
  createAdminWithPermissions,
  createCategory,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * SEO-004 — 404 suggestions: recorded only from the three public lookups,
 * without any personal data, bounded, and never a redirect until an operator
 * approves one.
 */

let ctx: TestContext;
let recorder: SeoNotFoundRecorder;
let root: { cookie: string; id: string };

beforeAll(async () => {
  ctx = await createTestApp();
  recorder = ctx.app.get(SeoNotFoundRecorder);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  recorder.clear();
  await resetDatabase(ctx.prisma);
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  root = { id: user.id, cookie: await loginAs(ctx.prisma, user.id) };
});

async function rows() {
  return ctx.prisma.seoNotFoundPath.findMany({ orderBy: { path: 'asc' } });
}

describe('what is recorded', () => {
  it('records the public 404s of a category, a business and a card — the address only', async () => {
    await request(ctx.server).get('/categories/olmayan-hizmet').query({ utm_source: 'x', phone: '05551112233' }).expect(404);
    await request(ctx.server).get('/providers/cmissingprovider00000xyz').expect(404);
    await request(ctx.server).get('/showcase/cards/cmissingcard00abcxyz').expect(404);
    await recorder.flush();

    const stored = await rows();
    expect(stored.map((row) => [row.path, row.routeFamily])).toEqual([
      ['/categories/olmayan-hizmet', SeoNotFoundRouteFamily.CATEGORY],
      ['/isletme/cmissingprovider00000xyz', SeoNotFoundRouteFamily.PROVIDER],
      ['/vitrin/cmissingcard00abcxyz', SeoNotFoundRouteFamily.SHOWCASE_CARD],
    ]);
    // Nothing else exists to hold a query, an IP, a user agent or a user.
    const columns = await ctx.prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'SeoNotFoundPath' ORDER BY column_name`;
    expect(columns.map((column) => column.column_name)).toEqual(
      [
        'candidateTargetPath',
        'createdAt',
        'decidedAt',
        'decidedById',
        'firstSeenAt',
        'id',
        'lastSeenAt',
        'occurrenceCount',
        'path',
        'redirectId',
        'routeFamily',
        'seenDays',
        'status',
        'updatedAt',
      ].sort(),
    );
    expect(JSON.stringify(stored)).not.toMatch(/utm|0555|phone/);
  });

  it('records a draft category’s address too (it is a 404 to the public), but not an operator’s 404', async () => {
    const admin = await createAdminWithPermissions(ctx.prisma, [AdminPermission.PROVIDERS_READ]);
    await request(ctx.server)
      .get('/providers/cmissingprovider00000abc')
      .set('Cookie', await loginAs(ctx.prisma, admin.admin.id))
      .expect(404);
    await recorder.flush();
    expect(await rows()).toEqual([]);
  });

  it('never records a path that may carry an e-mail or a phone number, or one the contract refuses', async () => {
    await request(ctx.server).get('/categories/ali@example.com').expect(404);
    await request(ctx.server).get('/categories/05551234567').expect(404);
    await request(ctx.server).get('/categories/a%2Fb').expect(404);
    await request(ctx.server).get('/categories/dosya.html').expect(404);
    await recorder.flush();
    expect(await rows()).toEqual([]);
  });

  it('counts hits and distinct days on one row per address', async () => {
    const day1 = new Date('2026-10-01T10:00:00Z');
    const day2 = new Date('2026-10-02T09:00:00Z');
    recorder.record(SeoNotFoundRouteFamily.CATEGORY, '/categories/eski', day1);
    recorder.record(SeoNotFoundRouteFamily.CATEGORY, '/categories/eski', day1);
    recorder.record(SeoNotFoundRouteFamily.CATEGORY, '/categories/ESKI/', day2);
    await recorder.flush();
    recorder.record(SeoNotFoundRouteFamily.CATEGORY, '/categories/eski', day2);
    await recorder.flush();

    const [row] = await rows();
    expect(row).toMatchObject({ path: '/categories/eski', occurrenceCount: 4, seenDays: 2, status: 'OPEN' });
    expect(row!.firstSeenAt.toISOString()).toBe(day1.toISOString());
    expect(row!.lastSeenAt.toISOString()).toBe(day2.toISOString());
  });

  it('bounds the buffer and the OPEN rows', async () => {
    for (let index = 0; index < NOT_FOUND_LIMITS.bufferMaxKeys + 25; index += 1) {
      recorder.record(SeoNotFoundRouteFamily.CATEGORY, `/categories/yok-${index}`);
    }
    expect(recorder.pending()).toBe(NOT_FOUND_LIMITS.bufferMaxKeys);
    await recorder.flush();
    expect(await ctx.prisma.seoNotFoundPath.count()).toBe(NOT_FOUND_LIMITS.bufferMaxKeys);

    // Fill the OPEN cap directly, then: an existing row still counts, a new one is not stored.
    const now = new Date();
    await ctx.prisma.seoNotFoundPath.createMany({
      data: Array.from({ length: NOT_FOUND_LIMITS.openRowCap - NOT_FOUND_LIMITS.bufferMaxKeys }, (_, index) => ({
        path: `/categories/dolgu-${index}`,
        routeFamily: SeoNotFoundRouteFamily.CATEGORY,
        firstSeenAt: now,
        lastSeenAt: now,
        occurrenceCount: 1,
        seenDays: 1,
      })),
    });
    recorder.record(SeoNotFoundRouteFamily.CATEGORY, '/categories/yok-0');
    recorder.record(SeoNotFoundRouteFamily.CATEGORY, '/categories/tasan-yeni');
    const outcome = await recorder.flush();
    expect(outcome).toEqual({ inserted: 0, updated: 1, suppressed: 0, overCap: 1 });
    expect(await ctx.prisma.seoNotFoundPath.count()).toBe(NOT_FOUND_LIMITS.openRowCap);
  });

  it('suggests a target only when the transliterated slug is a live category', async () => {
    const live = await createCategory(ctx.prisma, 'Kombi');
    await ctx.prisma.serviceCategory.update({ where: { id: live.id }, data: { slug: 'kombi-servisi' } });
    recorder.record(SeoNotFoundRouteFamily.CATEGORY, '/categories/kombi-serv%C4%B1s%C4%B1');
    recorder.record(SeoNotFoundRouteFamily.CATEGORY, '/categories/kombi-servisleri');
    await recorder.flush();
    expect((await rows()).map((row) => [row.path, row.candidateTargetPath])).toEqual([
      ['/categories/kombi-servisleri', null],
      ['/categories/kombi-servısı', '/categories/kombi-servisi'],
    ]);
  });
});

describe('deciding', () => {
  async function suggestion(rawPath: string) {
    recorder.record(SeoNotFoundRouteFamily.CATEGORY, rawPath);
    await recorder.flush();
    return ctx.prisma.seoNotFoundPath.findUniqueOrThrow({ where: { path: decodeURIComponent(rawPath) } });
  }

  it('approves into a redirect, in one transaction, through every redirect rule', async () => {
    const target = await createCategory(ctx.prisma, 'Hedef');
    const row = await suggestion('/categories/eski-hedef');
    const listed = await request(ctx.server).get('/admin/seo/not-found').set('Cookie', root.cookie).expect(200);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toEqual([row.id]);

    // A target off the site, or not live, is refused and nothing changes.
    await request(ctx.server)
      .post(`/admin/seo/not-found/${row.id}/approve`)
      .set('Cookie', root.cookie)
      .send({ targetPath: 'https://evil.com' })
      .expect(400);
    await request(ctx.server)
      .post(`/admin/seo/not-found/${row.id}/approve`)
      .set('Cookie', root.cookie)
      .send({})
      .expect(400);
    expect((await ctx.prisma.seoNotFoundPath.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('OPEN');
    expect(await ctx.prisma.seoRedirect.count()).toBe(0);

    const approved = await request(ctx.server)
      .post(`/admin/seo/not-found/${row.id}/approve`)
      .set('Cookie', root.cookie)
      .send({ targetPath: `/categories/${target.slug}`, reason: 'yazım hatası' })
      .expect(200);
    expect(approved.body.redirect).toMatchObject({ sourcePath: '/categories/eski-hedef', status: 301, origin: 'NOT_FOUND_SUGGESTION' });
    const stored = await ctx.prisma.seoNotFoundPath.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({ status: 'APPROVED', decidedById: root.id, redirectId: approved.body.redirect.id });
    const audit = await ctx.prisma.seoAuditLog.findMany({ where: { entityId: row.id } });
    expect(audit.map((entry) => [entry.action, entry.reason])).toEqual([[SeoAuditAction.SUGGESTION_APPROVED, 'yazım hatası']]);
    await request(ctx.server).post(`/admin/seo/not-found/${row.id}/approve`).set('Cookie', root.cookie).send({}).expect(409);

    // An approved path is suppressed: further hits change nothing.
    recorder.record(SeoNotFoundRouteFamily.CATEGORY, '/categories/eski-hedef');
    expect(await recorder.flush()).toMatchObject({ suppressed: 1 });
  });

  it('approves the recorded candidate when no target is given', async () => {
    const live = await createCategory(ctx.prisma, 'Kombi');
    await ctx.prisma.serviceCategory.update({ where: { id: live.id }, data: { slug: 'kombi-servisi' } });
    const row = await suggestion('/categories/kombi-serv%C4%B1s%C4%B1');
    const approved = await request(ctx.server)
      .post(`/admin/seo/not-found/${row.id}/approve`)
      .set('Cookie', root.cookie)
      .send({})
      .expect(200);
    expect(approved.body.redirect.targetPath).toBe('/categories/kombi-servisi');
  });

  it('rejects, audits, and suppresses the path from then on', async () => {
    const row = await suggestion('/categories/bot-taramasi');
    await request(ctx.server)
      .post(`/admin/seo/not-found/${row.id}/reject`)
      .set('Cookie', root.cookie)
      .send({ reason: 'tarama' })
      .expect(200);
    expect((await ctx.prisma.seoNotFoundPath.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('REJECTED');
    await request(ctx.server).post(`/admin/seo/not-found/${row.id}/reject`).set('Cookie', root.cookie).send({}).expect(409);
    recorder.record(SeoNotFoundRouteFamily.CATEGORY, '/categories/bot-taramasi');
    expect(await recorder.flush()).toMatchObject({ suppressed: 1, inserted: 0 });
    expect(await ctx.prisma.seoRedirect.count()).toBe(0);
    const audit = await ctx.prisma.seoAuditLog.findMany({ where: { entityId: row.id } });
    expect(audit.map((entry) => entry.action)).toEqual([SeoAuditAction.SUGGESTION_REJECTED]);
  });

  it('needs SEO_REDIRECTS_WRITE to decide and SEO_READ to list', async () => {
    const row = await suggestion('/categories/izin');
    const reader = await loginAs(ctx.prisma, (await createAdminWithPermissions(ctx.prisma, [AdminPermission.SEO_READ])).admin.id);
    const writer = await loginAs(
      ctx.prisma,
      (await createAdminWithPermissions(ctx.prisma, [AdminPermission.SEO_REDIRECTS_WRITE])).admin.id,
    );
    await request(ctx.server).get('/admin/seo/not-found').set('Cookie', reader).expect(200);
    await request(ctx.server).post(`/admin/seo/not-found/${row.id}/reject`).set('Cookie', reader).send({}).expect(403);
    await request(ctx.server).post(`/admin/seo/not-found/${row.id}/reject`).set('Cookie', writer).send({}).expect(200);
  });
});

describe('retention', () => {
  it('drops OPEN rows unseen for 90 days and REJECTED rows decided 180 days ago, and records its run', async () => {
    const now = new Date('2026-10-07T12:00:00Z');
    const days = (count: number) => new Date(now.getTime() - count * 24 * 60 * 60 * 1000);
    const base = { routeFamily: SeoNotFoundRouteFamily.CATEGORY, occurrenceCount: 1, seenDays: 1 };
    await ctx.prisma.seoNotFoundPath.createMany({
      data: [
        { ...base, path: '/categories/eski-acik', firstSeenAt: days(120), lastSeenAt: days(91) },
        { ...base, path: '/categories/yeni-acik', firstSeenAt: days(120), lastSeenAt: days(89) },
        { ...base, path: '/categories/eski-ret', firstSeenAt: days(400), lastSeenAt: days(300), status: SeoNotFoundStatus.REJECTED, decidedAt: days(181), decidedById: root.id },
        { ...base, path: '/categories/yeni-ret', firstSeenAt: days(400), lastSeenAt: days(300), status: SeoNotFoundStatus.REJECTED, decidedAt: days(179), decidedById: root.id },
      ],
    });
    const removed = await ctx.app.get(SeoRetentionScheduler).run(now);
    expect(removed).toEqual({ open: 1, rejected: 1 });
    expect((await rows()).map((row) => row.path)).toEqual(['/categories/yeni-acik', '/categories/yeni-ret']);
    const run = await ctx.prisma.schedulerRun.findFirstOrThrow({ where: { jobKey: 'seo-not-found-retention' } });
    expect(run).toMatchObject({ status: 'SUCCESS', summary: 'open=1 rejected=1' });
  });
});
