import { NotificationStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The operator's half of request reports: the queue grouped by request, the
 * per-request list, the one decision that closes every open report at once,
 * and the door back for a request a report took down.
 *
 * Two things these cases guard beyond the happy paths. **A decision and its
 * consequences are one transaction** — a `REQUEST_REMOVED` that cannot remove
 * (a MATCHED request) leaves the reports open. And **nothing about the reporter
 * or the operator's notes reaches the customer**: the removal mail carries a
 * fixed reason label and nothing else about why.
 */
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

async function approvedProvider(categoryId: string) {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { categoryId, userId: user.id });
  return { provider, cookie: await loginAs(ctx.prisma, user.id) };
}

async function adminSession() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { admin, cookie: await loginAs(ctx.prisma, admin.id) };
}

const reportUrl = (p: string, r: string) => `/providers/${p}/requests/${r}/reports`;

async function report(
  party: { provider: { id: string }; cookie: string },
  requestId: string,
  body: Record<string, unknown>,
) {
  return request(ctx.server)
    .post(reportUrl(party.provider.id, requestId))
    .set('Cookie', party.cookie)
    .send(body)
    .expect(201);
}

describe('admin report queue and decisions', () => {
  it('lists open reports grouped by request; DISMISSED closes all of them and keeps the request live', async () => {
    const category = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
    const a = await approvedProvider(category.id);
    const b = await approvedProvider(category.id);
    await report(a, req.id, { reason: 'SPAM' });
    await report(b, req.id, { reason: 'WRONG_CATEGORY', note: 'Aslında elektrik işi' });

    const { admin, cookie } = await adminSession();
    const queue = await request(ctx.server)
      .get('/service-requests/reports?state=open')
      .set('Cookie', cookie)
      .expect(200);
    expect(queue.body.items).toHaveLength(1);
    expect(queue.body.nextCursor).toBeNull();
    expect(queue.body.items[0]).toMatchObject({
      reportCount: 2,
      request: { id: req.id, requestNumber: req.requestNumber, status: 'APPROVED' },
      reasons: ['SPAM', 'WRONG_CATEGORY'],
      lastResolution: null,
      reopened: false,
    });
    expect(queue.body.items[0].reporters.map((r: { id: string }) => r.id).sort()).toEqual(
      [a.provider.id, b.provider.id].sort(),
    );

    const list = await request(ctx.server)
      .get(`/service-requests/${req.id}/reports`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[1]).toMatchObject({
      reason: 'WRONG_CATEGORY',
      note: 'Aslında elektrik işi',
      reporter: { id: b.provider.id },
      resolvedAt: null,
      resolution: null,
      resolvedBy: null,
    });

    await request(ctx.server)
      .post(`/service-requests/${req.id}/reports/resolve`)
      .set('Cookie', cookie)
      .send({ resolution: 'DISMISSED', resolutionNote: 'İçerik uygun' })
      .expect(201);
    const rows = await ctx.prisma.serviceRequestReport.findMany({ where: { requestId: req.id } });
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (r) =>
          r.resolution === 'DISMISSED' &&
          r.resolvedByUserId === admin.id &&
          r.resolvedAt !== null &&
          r.resolutionNote === 'İçerik uygun',
      ),
    ).toBe(true);
    expect(
      (await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: req.id } })).status,
    ).toBe('APPROVED');
    // A dismissal mails nobody.
    expect(ctx.notifications.sent.some((m) => m.template === 'request-removed')).toBe(false);

    const again = await request(ctx.server)
      .post(`/service-requests/${req.id}/reports/resolve`)
      .set('Cookie', cookie)
      .send({ resolution: 'DISMISSED' })
      .expect(409);
    expect(again.body.code).toBe('NO_OPEN_REPORTS');

    const open = await request(ctx.server)
      .get('/service-requests/reports?state=open')
      .set('Cookie', cookie)
      .expect(200);
    expect(open.body.items).toHaveLength(0);
    const resolved = await request(ctx.server)
      .get('/service-requests/reports?state=resolved')
      .set('Cookie', cookie)
      .expect(200);
    expect(resolved.body.items).toHaveLength(1);
    expect(resolved.body.items[0]).toMatchObject({
      request: { id: req.id },
      lastResolution: { resolution: 'DISMISSED' },
      reopened: false,
    });
    expect(resolved.body.items[0].lastResolution.resolvedAt).toBeTruthy();
  });

  it('REQUEST_REMOVED rejects the request, mails the customer, and reopen brings it back', async () => {
    const category = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      approvedAt: new Date(),
      customerEmail: 'c@example.test',
    });
    const a = await approvedProvider(category.id);
    await report(a, req.id, { reason: 'CONTAINS_CONTACT_INFO', note: 'Numarasını yazmış' });
    // The support inbox heard about the report when it was filed, with the
    // reason but never the note.
    const supportMail = ctx.notifications.sent.find(
      (m) => m.template === 'request-report-new-for-support',
    );
    expect(supportMail).toBeDefined();
    expect(supportMail?.data?.requestNumber).toBe(req.requestNumber);
    expect(supportMail?.data?.reasonLabel).toBe('İletişim bilgisi içeriyor');
    expect(JSON.stringify(supportMail?.data)).not.toContain('Numarasını yazmış');

    const { cookie } = await adminSession();
    const removed = await request(ctx.server)
      .post(`/service-requests/${req.id}/reports/resolve`)
      .set('Cookie', cookie)
      .send({
        resolution: 'REQUEST_REMOVED',
        removalReason: 'CONTAINS_CONTACT_INFO',
        resolutionNote: 'Gizli operatör notu',
      })
      .expect(201);
    expect(removed.body.status).toBe('REJECTED');

    let row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('REJECTED');
    expect(row.rejectionReason).toBe('Bildirim: Talep metninde iletişim bilgisi paylaşımı');
    expect(row.moderationNote).toBe('Gizli operatör notu');

    const mail = ctx.notifications.sent.find((m) => m.template === 'request-removed');
    expect(mail?.to).toBe('c@example.test');
    expect(mail?.data?.reasonLabel).toBe('Talep metninde iletişim bilgisi paylaşımı');
    // Neither who reported nor what the operator wrote reaches the customer.
    const serialized = JSON.stringify(mail);
    expect(serialized).not.toContain(a.provider.id);
    expect(serialized).not.toContain('Gizli operatör notu');
    expect(serialized).not.toContain('Numarasını yazmış');
    expect(serialized).not.toContain('CONTAINS_CONTACT_INFO');

    await request(ctx.server)
      .post(`/service-requests/${req.id}/reopen`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);
    row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('APPROVED');
    expect(row.rejectionReason).toBeNull();
    expect(row.approvedAt).not.toBeNull();

    // The reports are append-only: the decision stays on them.
    const reports = await ctx.prisma.serviceRequestReport.findMany({ where: { requestId: req.id } });
    expect(reports.every((r) => r.resolution === 'REQUEST_REMOVED')).toBe(true);

    const queue = await request(ctx.server)
      .get('/service-requests/reports?state=resolved')
      .set('Cookie', cookie)
      .expect(200);
    expect(queue.body.items).toHaveLength(1);
    expect(queue.body.items[0]).toMatchObject({
      request: { id: req.id, status: 'APPROVED' },
      lastResolution: { resolution: 'REQUEST_REMOVED' },
      reopened: true,
    });

    // A second reopen finds nothing to reopen.
    const twice = await request(ctx.server)
      .post(`/service-requests/${req.id}/reopen`)
      .set('Cookie', cookie)
      .send({})
      .expect(409);
    expect(twice.body.code).toBe('REQUEST_NOT_REOPENABLE');
  });

  it('REQUEST_REMOVED without a removal reason is refused before anything moves', async () => {
    const category = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
    const a = await approvedProvider(category.id);
    await report(a, req.id, { reason: 'SPAM' });
    const { cookie } = await adminSession();

    await request(ctx.server)
      .post(`/service-requests/${req.id}/reports/resolve`)
      .set('Cookie', cookie)
      .send({ resolution: 'REQUEST_REMOVED' })
      .expect(400);
    await request(ctx.server)
      .post(`/service-requests/${req.id}/reports/resolve`)
      .set('Cookie', cookie)
      .send({ resolution: 'REQUEST_REMOVED', removalReason: 'NOT_A_REASON' })
      .expect(400);

    const open = await ctx.prisma.serviceRequestReport.count({
      where: { requestId: req.id, resolvedAt: null },
    });
    expect(open).toBe(1);
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('APPROVED');
  });

  it('a failed removal mail is rebuilt on retry from the request alone', async () => {
    const category = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      approvedAt: new Date(),
      customerEmail: 'c@example.test',
    });
    const a = await approvedProvider(category.id);
    await report(a, req.id, { reason: 'DUPLICATE' });
    ctx.notifications.clear();
    const { cookie } = await adminSession();

    ctx.notifications.failNextSend = true;
    await request(ctx.server)
      .post(`/service-requests/${req.id}/reports/resolve`)
      .set('Cookie', cookie)
      .send({ resolution: 'REQUEST_REMOVED', removalReason: 'DUPLICATE' })
      .expect(201);
    expect(ctx.notifications.sent).toHaveLength(0);

    const log = await ctx.prisma.notificationLog.findFirstOrThrow({
      where: { template: 'request-removed' },
    });
    expect(log.status).toBe(NotificationStatus.FAILED);
    expect(log.dedupeKey?.startsWith(`request-removed:${req.id}:`)).toBe(true);

    const retried = await request(ctx.server)
      .post(`/notification-logs/${log.id}/retry`)
      .set('Cookie', cookie)
      .expect(200);
    expect(retried.body.status).toBe('SENT');

    expect(ctx.notifications.sent).toHaveLength(1);
    const mail = ctx.notifications.sent[0]!;
    expect(mail.template).toBe('request-removed');
    expect(mail.to).toBe('c@example.test');
    expect(mail.data?.reasonLabel).toBe('Aynı hizmet için birden fazla talep açılmış');
  });

  it('reopen refuses a request an operator rejected by hand', async () => {
    const category = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
    const { cookie } = await adminSession();
    await request(ctx.server)
      .patch(`/service-requests/${req.id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'REJECTED', rejectionReason: 'x' })
      .expect(200);
    const res = await request(ctx.server)
      .post(`/service-requests/${req.id}/reopen`)
      .set('Cookie', cookie)
      .send({})
      .expect(409);
    expect(res.body.code).toBe('REQUEST_NOT_REOPENABLE');
    expect(
      (await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: req.id } })).status,
    ).toBe(ServiceRequestStatus.REJECTED);
  });

  it('pages the open queue by request, oldest first report first', async () => {
    const category = await createCategory(ctx.prisma);
    const a = await approvedProvider(category.id);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
      await report(a, req.id, { reason: 'SPAM' });
      ids.push(req.id);
    }
    const { cookie } = await adminSession();

    const first = await request(ctx.server)
      .get('/service-requests/reports?state=open&limit=2')
      .set('Cookie', cookie)
      .expect(200);
    expect(first.body.items.map((i: { request: { id: string } }) => i.request.id)).toEqual(ids.slice(0, 2));
    expect(first.body.nextCursor).toBe(ids[1]);

    const second = await request(ctx.server)
      .get(`/service-requests/reports?state=open&limit=2&cursor=${first.body.nextCursor}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(second.body.items.map((i: { request: { id: string } }) => i.request.id)).toEqual([ids[2]]);
    expect(second.body.nextCursor).toBeNull();
  });

  it('a provider cannot reach the admin endpoints', async () => {
    const category = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
    const { cookie } = await approvedProvider(category.id);
    await request(ctx.server).get('/service-requests/reports').set('Cookie', cookie).expect(403);
    await request(ctx.server).get(`/service-requests/${req.id}/reports`).set('Cookie', cookie).expect(403);
    await request(ctx.server)
      .post(`/service-requests/${req.id}/reports/resolve`)
      .set('Cookie', cookie)
      .send({ resolution: 'DISMISSED' })
      .expect(403);
    await request(ctx.server)
      .post(`/service-requests/${req.id}/reopen`)
      .set('Cookie', cookie)
      .send({})
      .expect(403);
  });
});
