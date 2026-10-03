import { AdminPermission, CampaignTriggerEventStatus, ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROCESS_INTERRUPTED,
  SCHEDULER_RUN_LEASE_MS,
  SchedulerRunRegistry,
} from '../src/modules/operations-settings/scheduler-run-registry.service';
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';
import { createCampaignFixture } from './campaign-fixtures';
import {
  createAdminWithPermissions,
  createCategory,
  createDiscoverableProvider,
  createProviderProfile,
  createShowcaseEntitlement,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * ADMIN-BACKEND-TRUTH-002: the admin lists that stopped at a fixed size or
 * read everything now page on the server with a real total, and scheduler
 * runs are complete — a hand-run leaves a record, and a run whose process died
 * is closed once its lease runs out, never while it is alive.
 *
 * A — `/package-purchases` page + summary (`manualReview`) over the filters.
 * B — `/admin/promotion-eligibility/holds` page/pageSize/total.
 * C — `/admin/campaigns` cursor list: `total`, `previousCursor`, `?before=`.
 * D — the manual refund scan writes a MANUAL SchedulerRun with its operator.
 * E — stale RUNNING recovery on a lease, safe for a live run elsewhere.
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function superAdmin() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { admin, cookie: await loginAs(ctx.prisma, admin.id) };
}

async function sessionWith(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return loginAs(ctx.prisma, admin.id);
}

function get(cookie: string, path: string) {
  return request(ctx.server).get(path).set('Cookie', cookie);
}

type Row = { id: string };

/** Walks every page of `path` (which carries its own query) and returns the ids in order. */
async function walk(cookie: string, path: string, pageSize: number, idOf: (row: never) => string = (row: Row) => row.id) {
  const ids: string[] = [];
  let total = -1;
  for (let page = 1; page < 100; page += 1) {
    const body = (await get(cookie, `${path}&page=${page}&pageSize=${pageSize}`).expect(200)).body;
    if (total === -1) total = body.total;
    expect(body.total).toBe(total);
    ids.push(...(body.items as never[]).map(idOf));
    if (!body.hasNextPage) break;
  }
  return { ids, total };
}

/* ------------------------------------------------------------------------ */

describe('A — the package purchase list pages on the server', () => {
  async function purchases(count: number) {
    const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: user.id,
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: null }],
    });
    const pkg = await createShowcasePackage(ctx.prisma, { priceAmount: 10_000 });
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push((await createShowcaseEntitlement(ctx, { providerId: provider.id, userId: user.id, packageId: pkg.id })).purchase.id);
    }
    return { provider, pkg, ids };
  }

  it('walks more than one page with no duplicate and no gap, in the list’s own order', async () => {
    const { ids } = await purchases(7);
    const { cookie } = await superAdmin();
    const walked = await walk(cookie, '/package-purchases?status=PAID', 3);
    expect(walked.total).toBe(7);
    expect(new Set(walked.ids).size).toBe(7);
    const ordered = await ctx.prisma.packagePurchase.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    expect(walked.ids).toEqual(ordered.map((row) => row.id));
    expect([...walked.ids].sort()).toEqual([...ids].sort());
  });

  it('totals the filtered set, and the summary counts manual review on the same filter', async () => {
    const { provider, ids } = await purchases(4);
    const other = await purchases(2);
    await ctx.prisma.packagePurchase.update({
      where: { id: ids[0]! },
      data: { manualReviewAt: new Date(), manualReviewReason: 'PAYMENT_REVERSAL_REPORTED' },
    });
    await ctx.prisma.packagePurchase.update({
      where: { id: other.ids[0]! },
      data: { manualReviewAt: new Date(), manualReviewReason: 'PAYMENT_REVERSAL_REPORTED' },
    });
    const { cookie } = await superAdmin();

    const page = (await get(cookie, `/package-purchases?providerId=${provider.id}&page=1&pageSize=2`).expect(200)).body;
    expect(page).toMatchObject({ total: 4, page: 1, pageSize: 2, hasNextPage: true });
    const summary = (await get(cookie, `/package-purchases/summary?providerId=${provider.id}`).expect(200)).body;
    expect(summary).toMatchObject({ total: 4, manualReview: 1, byStatus: { PAID: 4 } });
    const everything = (await get(cookie, '/package-purchases/summary').expect(200)).body;
    expect(everything).toMatchObject({ total: 6, manualReview: 2 });
  });

  it('stays behind PACKAGE_PURCHASES_READ', async () => {
    const cookie = await sessionWith([AdminPermission.SHOWCASE_PACKAGES_READ]);
    await get(cookie, '/package-purchases?page=1&pageSize=25').expect(403);
    const reader = await sessionWith([AdminPermission.PACKAGE_PURCHASES_READ]);
    await get(reader, '/package-purchases?page=1&pageSize=25').expect(200);
    await get(reader, '/package-purchases/summary').expect(200);
  });
});

/* ------------------------------------------------------------------------ */

describe('B — the promotion eligibility queue is paged with its total', () => {
  const HOLDS = 130;
  const REASON = 'Belgeler incelendi, karar verildi.';

  /** `count` held events, a second apart, spread over three providers. */
  async function holds(count: number) {
    const providers = [];
    for (let i = 0; i < 3; i += 1) providers.push(await createProviderProfile(ctx.prisma, {}));
    const base = Date.now() - count * 1000;
    const events: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const provider = providers[i % 3]!;
      const event = await ctx.prisma.campaignTriggerEvent.create({
        data: {
          triggerEventKey: `PROVIDER_APPROVED:b2-${i}-${uniqueSuffix()}`,
          trigger: 'PROVIDER_APPROVED',
          providerId: provider.id,
          status: CampaignTriggerEventStatus.HELD_FOR_REVIEW,
        },
      });
      // Pairs share an instant, so the id has to break the tie.
      await ctx.prisma.promotionEligibilityHold.create({
        data: {
          triggerEventId: event.id,
          providerId: provider.id,
          signals: { outcome: 'REVIEW', signals: [{ code: 'SHARED_IP' }] },
          snapshotVersion: 1,
          heldAt: new Date(base + Math.floor(i / 2) * 1000),
        },
      });
      events.push(event.id);
    }
    return { providers, events };
  }

  const eventId = (row: { eventId: string }) => row.eventId;

  it('reaches every one of more than 100 open holds, oldest first, no duplicate and no gap', async () => {
    const { events } = await holds(HOLDS);
    const { cookie } = await superAdmin();
    const walked = await walk(cookie, '/admin/promotion-eligibility/holds?filter=open', 50, eventId as never);
    expect(walked.total).toBe(HOLDS);
    expect(walked.ids).toHaveLength(HOLDS);
    expect(new Set(walked.ids).size).toBe(HOLDS);
    const ordered = await ctx.prisma.promotionEligibilityHold.findMany({
      orderBy: [{ heldAt: 'asc' }, { id: 'asc' }],
      select: { triggerEventId: true },
    });
    expect(walked.ids).toEqual(ordered.map((row) => row.triggerEventId));
    expect([...walked.ids].sort()).toEqual([...events].sort());
  });

  it('keeps an old caller’s first 100 and now says how many exist', async () => {
    await holds(HOLDS);
    const { cookie } = await superAdmin();
    const body = (await get(cookie, '/admin/promotion-eligibility/holds?filter=open').expect(200)).body;
    expect(body.items).toHaveLength(100);
    expect(body).toMatchObject({ total: HOLDS, page: 1, pageSize: 100, hasNextPage: true });
    await get(cookie, '/admin/promotion-eligibility/holds?pageSize=101').expect(400);
    await get(cookie, '/admin/promotion-eligibility/holds?page=0').expect(400);
    await get(cookie, '/admin/promotion-eligibility/holds?page=x').expect(400);
  });

  it('totals a provider’s holds within the filter', async () => {
    const { providers } = await holds(30);
    const { cookie } = await superAdmin();
    const body = (
      await get(cookie, `/admin/promotion-eligibility/holds?filter=all&providerId=${providers[1]!.id}&pageSize=4`).expect(200)
    ).body;
    expect(body).toMatchObject({ total: 10, hasNextPage: true });
    expect(body.items.every((item: { provider: { id: string } }) => item.provider.id === providers[1]!.id)).toBe(true);
  });

  it('moves a decided hold from the open total to the decided total', async () => {
    const { events } = await holds(HOLDS);
    const { cookie } = await superAdmin();
    for (const id of events.slice(0, 3)) {
      await request(ctx.server)
        .post(`/admin/promotion-eligibility/holds/${id}/decision`)
        .set('Cookie', cookie)
        .send({ decision: 'INELIGIBLE', reason: REASON })
        .expect(201);
    }
    const open = (await get(cookie, '/admin/promotion-eligibility/holds?filter=open&pageSize=50').expect(200)).body;
    const decided = (await get(cookie, '/admin/promotion-eligibility/holds?filter=decided&pageSize=50').expect(200)).body;
    expect(open.total).toBe(HOLDS - 3);
    expect(decided.total).toBe(3);
    expect(open.items.map(eventId)).not.toContain(events[0]);
    expect(decided.items.map(eventId).sort()).toEqual(events.slice(0, 3).sort());
    const walked = await walk(cookie, '/admin/promotion-eligibility/holds?filter=open', 50, eventId as never);
    expect(walked.ids.sort()).toEqual(events.slice(3).sort());
  });

  it('stays behind PROMOTION_ELIGIBILITY_REVIEW', async () => {
    await holds(2);
    const cookie = await sessionWith([AdminPermission.CAMPAIGNS_READ]);
    await get(cookie, '/admin/promotion-eligibility/holds?page=1&pageSize=50').expect(403);
  });
});

/* ------------------------------------------------------------------------ */

describe('C — the campaign list keeps its cursor and gains a total and a way back', () => {
  async function campaigns(count: number) {
    const { admin } = await superAdmin();
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push((await createCampaignFixture(ctx.prisma, { createdById: admin.id })).campaign.id);
    }
    return ids;
  }

  async function list(cookie: string, query: string) {
    return (await get(cookie, `/admin/campaigns?${query}`).expect(200)).body as {
      items: Row[];
      total: number;
      previousCursor: string | null;
      nextCursor: string | null;
    };
  }

  it('walks forward and back over the same pages with an exact total', async () => {
    const ids = await campaigns(7);
    const { cookie } = await superAdmin();
    const ordered = (
      await ctx.prisma.campaign.findMany({ orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], select: { id: true } })
    ).map((row) => row.id);
    expect([...ordered].sort()).toEqual([...ids].sort());

    const first = await list(cookie, 'limit=3');
    expect(first.total).toBe(7);
    expect(first.previousCursor).toBeNull();
    const second = await list(cookie, `limit=3&cursor=${first.nextCursor}`);
    const third = await list(cookie, `limit=3&cursor=${second.nextCursor}`);
    expect(third.nextCursor).toBeNull();
    const forward = [first, second, third].flatMap((page) => page.items.map((item) => item.id));
    expect(forward).toEqual(ordered);
    expect([second.total, third.total]).toEqual([7, 7]);

    // Back from the last page: exactly the pages the walk forward met.
    expect(third.previousCursor).toBe(third.items[0]!.id);
    const back = await list(cookie, `limit=3&before=${third.previousCursor}`);
    expect(back.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id));
    expect(back.nextCursor).toBe(back.items[back.items.length - 1]!.id);
    const start = await list(cookie, `limit=3&before=${back.previousCursor}`);
    expect(start.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    expect(start.previousCursor).toBeNull();
    expect(start.total).toBe(7);
  });

  it('keeps the old contract: items and nextCursor read as before', async () => {
    await campaigns(3);
    const { cookie } = await superAdmin();
    const page = await list(cookie, 'limit=2');
    expect(page.items).toHaveLength(2);
    expect(typeof page.nextCursor).toBe('string');
    const rest = await list(cookie, `limit=2&cursor=${page.nextCursor}`);
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
  });

  it('refuses a cursor and a before together', async () => {
    const ids = await campaigns(2);
    const { cookie } = await superAdmin();
    await get(cookie, `/admin/campaigns?cursor=${ids[0]}&before=${ids[1]}`).expect(400);
  });

  it('counts zero on an empty list', async () => {
    const { cookie } = await superAdmin();
    expect(await list(cookie, 'limit=25')).toMatchObject({ items: [], total: 0, previousCursor: null, nextCursor: null });
  });
});

/* ------------------------------------------------------------------------ */

describe('D — a hand-run refund scan leaves a MANUAL run record', () => {
  function execute(cookie: string, limit = 50) {
    return request(ctx.server).post('/offers/refund-scan/execute').set('Cookie', cookie).send({ limit });
  }

  it('records a MANUAL run with its operator and the scan’s real counts', async () => {
    const { admin, cookie } = await superAdmin();
    const result = (await execute(cookie).expect(201)).body;

    const runs = await ctx.prisma.schedulerRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      jobKey: 'unviewed-offer-refund',
      trigger: 'MANUAL',
      status: 'SUCCESS',
      actorId: admin.id,
      errorCode: null,
      summary: `processed=${result.processed} refunded=${result.refunded} skipped=${result.skipped} failed=0`,
    });
    expect(runs[0]!.finishedAt).not.toBeNull();
  });

  it('is shown as the job’s last hand-run, never as its last scheduled run', async () => {
    const { cookie } = await superAdmin();
    await execute(cookie).expect(201);
    const body = (await get(cookie, '/operations-settings/schedulers').expect(200)).body as {
      jobs: Array<{ key: string; lastRun: unknown; lastManualRun?: Record<string, unknown> | null }>;
    };
    const refund = body.jobs.find((job) => job.key === 'unviewed-offer-refund')!;
    expect(refund.lastRun).toBeNull();
    expect(refund.lastManualRun).toMatchObject({ trigger: 'MANUAL', status: 'SUCCESS', actor: { name: expect.any(String) } });
    // Only the job that can be run by hand carries the key.
    expect(body.jobs.find((job) => job.key === 'request-expiry')).not.toHaveProperty('lastManualRun');
  });

  it('records a failed hand-run by error class and still answers the error', async () => {
    const { cookie } = await superAdmin();
    vi.spyOn(ctx.app.get(UnviewedOfferRefundService), 'execute').mockRejectedValueOnce(
      new TypeError('connection to postgres://user:secret@db/taktic refused'),
    );
    await execute(cookie).expect(500);
    const run = await ctx.prisma.schedulerRun.findFirstOrThrow();
    expect(run).toMatchObject({ trigger: 'MANUAL', status: 'FAILED', errorCode: 'TypeError', summary: null });
  });

  it('writes no run for a refused request', async () => {
    const reader = await sessionWith([AdminPermission.OFFER_REFUND_SCAN_READ]);
    await execute(reader).expect(403);
    const { cookie } = await superAdmin();
    await execute(cookie, 501).expect(400);
    expect(await ctx.prisma.schedulerRun.count()).toBe(0);
  });

  it('holds the actor and the trigger together in the database', async () => {
    const { admin } = await superAdmin();
    await expect(
      ctx.prisma.schedulerRun.create({ data: { jobKey: 'unviewed-offer-refund', trigger: 'MANUAL', startedAt: new Date() } }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.schedulerRun.create({
        data: { jobKey: 'unviewed-offer-refund', trigger: 'SCHEDULER', startedAt: new Date(), actorId: admin.id },
      }),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------------ */

describe('E — a RUNNING run whose lease ran out is closed as interrupted', () => {
  const registry = () => ctx.app.get(SchedulerRunRegistry);
  const ago = (ms: number) => new Date(Date.now() - ms);

  it('closes a dead run FAILED with PROCESS_INTERRUPTED, and keeps its start', async () => {
    const startedAt = ago(SCHEDULER_RUN_LEASE_MS * 3);
    const dead = await ctx.prisma.schedulerRun.create({
      data: { jobKey: 'request-expiry', status: 'RUNNING', startedAt, heartbeatAt: ago(SCHEDULER_RUN_LEASE_MS * 2) },
    });
    expect(await registry().recoverStale()).toBe(1);
    const row = await ctx.prisma.schedulerRun.findUniqueOrThrow({ where: { id: dead.id } });
    expect(row).toMatchObject({ status: 'FAILED', errorCode: PROCESS_INTERRUPTED, summary: null, startedAt });
    expect(row.finishedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('closes a pre-heartbeat row by its start, and leaves a fresh one', async () => {
    await ctx.prisma.schedulerRun.create({ data: { jobKey: 'request-reminder', status: 'RUNNING', startedAt: ago(SCHEDULER_RUN_LEASE_MS * 2) } });
    const fresh = await ctx.prisma.schedulerRun.create({ data: { jobKey: 'request-reminder', status: 'RUNNING', startedAt: ago(10_000) } });
    expect(await registry().recoverStale()).toBe(1);
    expect((await ctx.prisma.schedulerRun.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('RUNNING');
  });

  it('never closes a long run that is still renewing its lease on another instance', async () => {
    // Started long ago, but its process heartbeated seconds ago: alive.
    const live = await ctx.prisma.schedulerRun.create({
      data: { jobKey: 'unviewed-offer-refund', status: 'RUNNING', startedAt: ago(SCHEDULER_RUN_LEASE_MS * 10), heartbeatAt: ago(20_000) },
    });
    expect(await registry().recoverStale()).toBe(0);
    expect((await ctx.prisma.schedulerRun.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('RUNNING');
  });

  it('renews the lease of an open run forward and lets it close normally', async () => {
    const run = await registry().start('request-expiry');
    const opened = await ctx.prisma.schedulerRun.findUniqueOrThrow({ where: { id: run.id! } });
    expect(opened.heartbeatAt).not.toBeNull();
    await run.heartbeat();
    const renewed = await ctx.prisma.schedulerRun.findUniqueOrThrow({ where: { id: run.id! } });
    expect(renewed.status).toBe('RUNNING');
    expect(renewed.heartbeatAt!.getTime()).toBeGreaterThanOrEqual(opened.heartbeatAt!.getTime());
    await run.succeed('expired=0');
    expect(await ctx.prisma.schedulerRun.findUniqueOrThrow({ where: { id: run.id! } })).toMatchObject({ status: 'SUCCESS' });
  });

  it('recovers only the starting job before a new run, and every job on the sweep', async () => {
    await ctx.prisma.schedulerRun.create({ data: { jobKey: 'request-expiry', status: 'RUNNING', startedAt: ago(SCHEDULER_RUN_LEASE_MS * 2) } });
    const other = await ctx.prisma.schedulerRun.create({
      data: { jobKey: 'showcase-lead-sla', status: 'RUNNING', startedAt: ago(SCHEDULER_RUN_LEASE_MS * 2) },
    });
    const run = await registry().start('request-expiry');
    await run.succeed(null);
    const history = await ctx.prisma.schedulerRun.findMany({ where: { jobKey: 'request-expiry' }, orderBy: { startedAt: 'asc' } });
    expect(history.map((row) => [row.status, row.errorCode])).toEqual([
      ['FAILED', PROCESS_INTERRUPTED],
      ['SUCCESS', null],
    ]);
    expect((await ctx.prisma.schedulerRun.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('RUNNING');

    await registry().sweepStaleRuns();
    expect(await ctx.prisma.schedulerRun.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({
      status: 'FAILED',
      errorCode: PROCESS_INTERRUPTED,
    });
  });

  it('keeps the recovered record when the interrupted process later tries to close it', async () => {
    const run = await registry().start('request-reminder');
    // Its lease runs out (simulated by a recovery with the row backdated past it).
    await ctx.prisma.$executeRaw`UPDATE "SchedulerRun" SET "status" = 'FAILED', "finishedAt" = now() AT TIME ZONE 'UTC', "errorCode" = ${PROCESS_INTERRUPTED} WHERE "id" = ${run.id}`;
    await run.succeed('reminded=1');
    expect(await ctx.prisma.schedulerRun.findUniqueOrThrow({ where: { id: run.id! } })).toMatchObject({
      status: 'FAILED',
      errorCode: PROCESS_INTERRUPTED,
      summary: null,
    });
  });

  it('lets an open run move only its heartbeat, and only forward', async () => {
    const open = await ctx.prisma.schedulerRun.create({
      data: { jobKey: 'request-expiry', status: 'RUNNING', startedAt: ago(5000), heartbeatAt: ago(1000) },
    });
    await expect(
      ctx.prisma.schedulerRun.update({ where: { id: open.id }, data: { heartbeatAt: ago(4000) } }),
    ).rejects.toThrow();
    await expect(ctx.prisma.schedulerRun.update({ where: { id: open.id }, data: { summary: 'x' } })).rejects.toThrow();
    await ctx.prisma.schedulerRun.update({ where: { id: open.id }, data: { heartbeatAt: new Date() } });
    const closed = await ctx.prisma.schedulerRun.update({
      where: { id: open.id },
      data: { status: 'SUCCESS', finishedAt: new Date() },
    });
    await expect(
      ctx.prisma.schedulerRun.update({ where: { id: closed.id }, data: { heartbeatAt: new Date(Date.now() + 1000) } }),
    ).rejects.toThrow();
  });

  it('shows the recovered run as its terminal status on the operations screen', async () => {
    const { cookie } = await superAdmin();
    await ctx.prisma.schedulerRun.create({ data: { jobKey: 'request-reminder', status: 'RUNNING', startedAt: ago(SCHEDULER_RUN_LEASE_MS * 2) } });
    await registry().recoverStale();
    const body = (await get(cookie, '/operations-settings/schedulers').expect(200)).body as {
      jobs: Array<{ key: string; lastRun: Record<string, unknown> | null }>;
    };
    expect(body.jobs.find((job) => job.key === 'request-reminder')!.lastRun).toMatchObject({
      status: 'FAILED',
      errorCode: PROCESS_INTERRUPTED,
    });
    // A job that never ran still has no recorded run.
    expect(body.jobs.find((job) => job.key === 'request-expiry')!.lastRun).toBeNull();
  });
});
