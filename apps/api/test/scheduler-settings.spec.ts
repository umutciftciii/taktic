import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntitlementRenewalScheduler } from '../src/modules/entitlements/entitlement-renewal.scheduler';
import {
  SCHEDULER_JOB_KEYS,
  SCHEDULER_JOB_SETTINGS,
  type SchedulerJobKey,
} from '../src/modules/operations-settings/scheduler-jobs';
import { SchedulerRunRegistry } from '../src/modules/operations-settings/scheduler-run-registry.service';
import { SchedulerSettingsService } from '../src/modules/operations-settings/scheduler-settings.service';
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RequestLifecycleSchedulerService } from '../src/modules/request-lifecycle/request-lifecycle-scheduler.service';
import { ShowcaseSchedulerService } from '../src/modules/showcase/showcase-scheduler.service';
import { UnviewedOfferRefundSchedulerService } from '../src/modules/unviewed-offer-refund/unviewed-offer-refund.scheduler';
import {
  createApprovedRequest,
  createCategory,
  createTestApp,
  createUser,
  daysAgo,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * Whether a background job runs, as one persistent answer a super admin owns.
 *
 * Three properties are under test, and the third is the one that matters.
 *
 * 1. **Off by default, and off after a deploy.** No settings row means no job
 *    acts, so a fresh database and an upgraded one behave identically: nothing
 *    starts moving money because a migration ran.
 * 2. **Only a super admin can move it, and every move is recorded.** The trail
 *    has to answer "who turned the refund worker on, and when" — and it must
 *    not fill up with re-posted forms that changed nothing.
 * 3. **The switch actually reaches the tick.** Each scheduler's real cron
 *    handler is invoked directly here — the same method `@Cron` calls — so what
 *    is asserted is the wiring a deployment gets, not a mirror of it. Nothing
 *    waits for a real cron, and no test-only "run now" entry point exists.
 */

let ctx: TestContext;
let schedulers: SchedulerSettingsService;
let lifecycle: RequestLifecycleSchedulerService;
let showcase: ShowcaseSchedulerService;
let renewal: EntitlementRenewalScheduler;
let refund: UnviewedOfferRefundSchedulerService;

beforeAll(async () => {
  ctx = await createTestApp();
  schedulers = ctx.app.get(SchedulerSettingsService);
  lifecycle = ctx.app.get(RequestLifecycleSchedulerService);
  showcase = ctx.app.get(ShowcaseSchedulerService);
  renewal = ctx.app.get(EntitlementRenewalScheduler);
  refund = ctx.app.get(UnviewedOfferRefundSchedulerService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

async function superAdminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { cookie: await loginAs(ctx.prisma, admin.id), admin };
}

function toggle(cookie: string, job: string, enabled: unknown) {
  return request(ctx.server)
    .put(`/operations-settings/schedulers/${job}`)
    .set('Cookie', cookie)
    .send({ enabled });
}

function list(cookie: string) {
  return request(ctx.server).get('/operations-settings/schedulers').set('Cookie', cookie);
}

function changeRows(setting?: string) {
  return ctx.prisma.operationsSettingsChange.findMany({
    where: setting ? { setting } : undefined,
    orderBy: { createdAt: 'asc' },
  });
}

describe('the shipped default', () => {
  it('reports all four jobs off with no settings row at all', async () => {
    const { cookie } = await superAdminCookie();

    const response = await list(cookie).expect(200);

    expect(response.body.jobs.map((job: { key: string }) => job.key)).toEqual([
      ...SCHEDULER_JOB_KEYS,
    ]);
    for (const job of response.body.jobs) {
      expect(job.enabled).toBe(false);
    }
    expect(await ctx.prisma.operationsSettings.count()).toBe(0);
  });

  it('answers every job disabled at the service, row or no row', async () => {
    for (const job of SCHEDULER_JOB_KEYS) {
      expect(await schedulers.isJobEnabled(job)).toBe(false);
    }

    // A row created for the *other* reason it exists — an operator saving the
    // refund window — still leaves every job off, because the columns default
    // to false rather than to "whatever the deployment used to set".
    const { cookie } = await superAdminCookie();
    await request(ctx.server)
      .put('/operations-settings')
      .set('Cookie', cookie)
      .send({ unviewedOfferRefundWindowHours: 72 })
      .expect(200);

    for (const job of SCHEDULER_JOB_KEYS) {
      expect(await schedulers.isJobEnabled(job)).toBe(false);
    }
  });

  it('ignores the environment flags that used to decide this', async () => {
    const keys = [
      'ENTITLEMENT_RENEWAL_SCHEDULER_ENABLED',
      'UNVIEWED_OFFER_REFUND_ENABLED',
      'REQUEST_EXPIRY_SCHEDULER_ENABLED',
      'REQUEST_REMINDER_SCHEDULER_ENABLED',
    ] as const;
    const original = keys.map((key) => [key, process.env[key]] as const);

    try {
      for (const key of keys) {
        process.env[key] = 'true';
      }

      for (const job of SCHEDULER_JOB_KEYS) {
        expect(await schedulers.isJobEnabled(job)).toBe(false);
      }
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

describe('the super admin switch', () => {
  it('turns a job on, records who did it, and turns it back off', async () => {
    const { cookie, admin } = await superAdminCookie();

    const on = await toggle(cookie, 'request-expiry', true).expect(200);
    expect(
      on.body.jobs.find((job: { key: string }) => job.key === 'request-expiry').enabled,
    ).toBe(true);
    expect(await schedulers.isJobEnabled('request-expiry')).toBe(true);

    await toggle(cookie, 'request-expiry', false).expect(200);
    expect(await schedulers.isJobEnabled('request-expiry')).toBe(false);

    const rows = await changeRows(SCHEDULER_JOB_SETTINGS['request-expiry']);
    expect(rows).toHaveLength(2);
    // NULL exactly once, on the change that first created the row: before it,
    // the effective value was the shipped default rather than a choice.
    expect(rows[0]).toMatchObject({ previousValue: null, newValue: 'true', changedById: admin.id });
    expect(rows[1]).toMatchObject({
      previousValue: 'true',
      newValue: 'false',
      changedById: admin.id,
    });
  });

  it('keeps the four switches independent', async () => {
    const { cookie } = await superAdminCookie();

    await toggle(cookie, 'unviewed-offer-refund', true).expect(200);

    expect(await schedulers.isJobEnabled('unviewed-offer-refund')).toBe(true);
    for (const job of SCHEDULER_JOB_KEYS.filter((key) => key !== 'unviewed-offer-refund')) {
      expect(await schedulers.isJobEnabled(job)).toBe(false);
    }
  });

  it('writes no audit row when the value does not move', async () => {
    const { cookie } = await superAdminCookie();

    // Off is already the answer, so this changes nothing and records nothing.
    await toggle(cookie, 'entitlement-renewal', false).expect(200);
    expect(await changeRows()).toHaveLength(0);
    expect(await ctx.prisma.operationsSettings.count()).toBe(0);

    await toggle(cookie, 'entitlement-renewal', true).expect(200);
    expect(await changeRows()).toHaveLength(1);

    // …and a re-posted form does not turn a refresh into a decision.
    await toggle(cookie, 'entitlement-renewal', true).expect(200);
    await toggle(cookie, 'entitlement-renewal', true).expect(200);
    expect(await changeRows()).toHaveLength(1);
  });

  it('leaves the refund window alone when a scheduler creates the row', async () => {
    const { cookie } = await superAdminCookie();

    await toggle(cookie, 'request-reminder', true).expect(200);

    const settings = await request(ctx.server)
      .get('/operations-settings')
      .set('Cookie', cookie)
      .expect(200);

    // The row exists now, but nobody has chosen a window — so the screen still
    // says "default", and its own audit panel is still empty.
    expect(settings.body.configured).toBe(false);
    expect(settings.body.unviewedOfferRefundWindowHours).toBe(
      settings.body.defaultUnviewedOfferRefundWindowHours,
    );
    expect(settings.body.recentChanges).toHaveLength(0);
    expect(settings.body.updatedBy).toBeNull();
  });

  it('keeps the two audit panels apart', async () => {
    const { cookie } = await superAdminCookie();

    await toggle(cookie, 'request-expiry', true).expect(200);
    await request(ctx.server)
      .put('/operations-settings')
      .set('Cookie', cookie)
      .send({ unviewedOfferRefundWindowHours: 72 })
      .expect(200);

    const windowChanges = (
      await request(ctx.server).get('/operations-settings').set('Cookie', cookie).expect(200)
    ).body.recentChanges;
    expect(windowChanges).toHaveLength(1);
    expect(windowChanges[0].setting).toBe('unviewedOfferRefundWindowHours');

    const schedulerChanges = (await list(cookie).expect(200)).body.recentChanges;
    expect(schedulerChanges).toHaveLength(1);
    expect(schedulerChanges[0].setting).toBe(SCHEDULER_JOB_SETTINGS['request-expiry']);
  });
});

describe('what the response does and does not carry', () => {
  it('shows the deployment schedule read-only and no other configuration', async () => {
    const { cookie } = await superAdminCookie();

    const response = await list(cookie).expect(200);

    const serialized = JSON.stringify(response.body);
    for (const job of response.body.jobs) {
      // A cron expression is a schedule, not a secret, and an operator has to
      // see the one they cannot change.
      expect(typeof job.cron).toBe('string');
      expect(job.cron.length).toBeGreaterThan(0);
    }

    // Nothing else from the environment reaches this response.
    expect(serialized).not.toContain(process.env.DATABASE_URL ?? '@@unset@@');
    expect(serialized).not.toContain('DATABASE_URL');
    expect(serialized).not.toContain('SCHEDULER_ENABLED');
    expect(serialized).not.toContain('postgres');
  });

  it('marks the two money jobs as such', async () => {
    const { cookie } = await superAdminCookie();

    const jobs: { key: SchedulerJobKey; movesMoney: boolean }[] = (await list(cookie).expect(200))
      .body.jobs;

    expect(jobs.filter((job) => job.movesMoney).map((job) => job.key).sort()).toEqual([
      'entitlement-renewal',
      'unviewed-offer-refund',
    ]);
  });
});

describe('who may reach it', () => {
  const OTHER_ROLES = [UserRole.CUSTOMER, UserRole.PROVIDER] as const;

  for (const role of OTHER_ROLES) {
    it(`refuses a ${role} both ways`, async () => {
      const user = await createUser(ctx.prisma, { role });
      const cookie = await loginAs(ctx.prisma, user.id);

      await list(cookie).expect(403);
      await toggle(cookie, 'request-expiry', true).expect(403);

      expect(await schedulers.isJobEnabled('request-expiry')).toBe(false);
      expect(await changeRows()).toHaveLength(0);
    });
  }

  it('refuses a signed-out caller', async () => {
    await request(ctx.server).get('/operations-settings/schedulers').expect(401);
    await request(ctx.server)
      .put('/operations-settings/schedulers/request-expiry')
      .send({ enabled: true })
      .expect(401);
  });
});

describe('what a bad request gets', () => {
  it('answers 404 for a job key that does not exist', async () => {
    const { cookie } = await superAdminCookie();

    for (const key of ['nope', 'requestExpiry', 'request-expiry-scheduler', '../..']) {
      await toggle(cookie, encodeURIComponent(key), true).expect(404);
    }

    expect(await changeRows()).toHaveLength(0);
  });

  it('answers 400 for a payload that is not a decision', async () => {
    const { cookie } = await superAdminCookie();

    for (const value of ['on', '1', 1, null, '', 'evet']) {
      await toggle(cookie, 'request-expiry', value).expect(400);
    }

    await request(ctx.server)
      .put('/operations-settings/schedulers/request-expiry')
      .set('Cookie', cookie)
      .send({ enabled: true, job: 'unviewed-offer-refund' })
      .expect(400);

    expect(await schedulers.isJobEnabled('request-expiry')).toBe(false);
    expect(await changeRows()).toHaveLength(0);
  });

  it('accepts the two strings a form sends', async () => {
    const { cookie } = await superAdminCookie();

    await toggle(cookie, 'request-expiry', 'true').expect(200);
    expect(await schedulers.isJobEnabled('request-expiry')).toBe(true);

    await toggle(cookie, 'request-expiry', 'false').expect(200);
    expect(await schedulers.isJobEnabled('request-expiry')).toBe(false);
  });
});

describe('fail-closed', () => {
  it('treats an unreadable setting as off, however the row actually reads', async () => {
    const { cookie } = await superAdminCookie();
    await toggle(cookie, 'request-expiry', true).expect(200);
    // The stored answer really is "on" — so anything the failing reader says
    // below is the failure mode and not the data.
    expect(await schedulers.isJobEnabled('request-expiry')).toBe(true);

    const unreadable = new SchedulerSettingsService(
      {
        operationsSettings: {
          findUnique: async () => {
            throw new Error('connection to postgres://user:secret@db/taktic refused');
          },
        },
      } as unknown as PrismaService,
      new SchedulerRunRegistry({} as PrismaService),
    );

    for (const job of SCHEDULER_JOB_KEYS) {
      expect(await unreadable.isJobEnabled(job)).toBe(false);
    }
  });
});

/**
 * The tick, as the deployment actually has it.
 *
 * Each case invokes the very method the job's `@Cron` decorator is attached to.
 * That is the seam: no timer is started, nothing sleeps, and nothing calls the
 * underlying service directly — so a scheduler that stopped consulting its
 * switch would fail here.
 */
describe('the natural tick', () => {
  const TICKS: Record<SchedulerJobKey, () => Promise<void>> = {
    'entitlement-renewal': () => renewal.runScheduledRenewals(),
    'unviewed-offer-refund': () => refund.runScheduledRefund(),
    'request-expiry': () => lifecycle.runScheduledExpiry(),
    'request-reminder': () => lifecycle.runScheduledReminder(),
    'showcase-lead-sla': () => showcase.runScheduledSla(),
    'showcase-placement-expiry': () => showcase.runScheduledExpiry(),
  };

  /** One approved request old enough for both lifecycle jobs to want it. */
  async function overdueRequest() {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    return createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      approvedAt: daysAgo(20),
    });
  }

  for (const job of SCHEDULER_JOB_KEYS) {
    it(`does nothing on a tick while ${job} is off`, async () => {
      const serviceRequest = await overdueRequest();

      await TICKS[job]();

      const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
        where: { id: serviceRequest.id },
      });
      expect(stored.status).toBe('APPROVED');
      expect(stored.reminderSentAt).toBeNull();
      expect(ctx.notifications.sent).toHaveLength(0);
      // A tick that did nothing writes nothing, including no audit noise.
      expect(await changeRows()).toHaveLength(0);
    });
  }

  it('expires on the next tick once the switch is on, with no restart', async () => {
    const serviceRequest = await overdueRequest();
    const { cookie } = await superAdminCookie();

    // The same long-lived scheduler instance the process booted with: nothing
    // is re-created between these two ticks.
    await lifecycle.runScheduledExpiry();
    expect(
      (await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: serviceRequest.id } }))
        .status,
    ).toBe('APPROVED');

    await toggle(cookie, 'request-expiry', true).expect(200);
    await lifecycle.runScheduledExpiry();

    expect(
      (await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: serviceRequest.id } }))
        .status,
    ).toBe('EXPIRED');
  });

  it('stops on the next tick once the switch is off again', async () => {
    const { cookie } = await superAdminCookie();
    await toggle(cookie, 'request-reminder', true).expect(200);

    const first = await overdueRequest();
    await lifecycle.runScheduledReminder();
    expect(
      (await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: first.id } }))
        .reminderSentAt,
    ).not.toBeNull();

    await toggle(cookie, 'request-reminder', false).expect(200);
    const second = await overdueRequest();
    await lifecycle.runScheduledReminder();

    expect(
      (await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: second.id } }))
        .reminderSentAt,
    ).toBeNull();
  });

  for (const job of SCHEDULER_JOB_KEYS) {
    it(`runs its pass on a tick once ${job} is on`, async () => {
      const { cookie } = await superAdminCookie();
      await toggle(cookie, job, true).expect(200);

      await TICKS[job]();

      // Every job records the pass it completed, which is the observable a
      // scheduler that skipped its work cannot produce — now as a row.
      const rows = await ctx.prisma.schedulerRun.findMany({ where: { jobKey: job } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'SUCCESS', trigger: 'SCHEDULER', errorCode: null });
      expect(rows[0]!.finishedAt).not.toBeNull();
    });
  }

  it('reports the last recorded run of a job', async () => {
    const { cookie } = await superAdminCookie();
    await toggle(cookie, 'request-expiry', true).expect(200);
    await overdueRequest();

    await lifecycle.runScheduledExpiry();

    const job = (await list(cookie).expect(200)).body.jobs.find(
      (entry: { key: string }) => entry.key === 'request-expiry',
    );
    expect(job.lastRun.status).toBe('SUCCESS');
    expect(job.lastRun.trigger).toBe('SCHEDULER');
    expect(job.lastRun.errorCode).toBeNull();
    expect(new Date(job.lastRun.finishedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(job.lastRun.startedAt).getTime(),
    );
    // Counts only — no request id, no address, no error text.
    expect(job.lastRun.summary).toContain('expired=1');
    expect(job.lastRun.summary).not.toMatch(/@|http|[a-z0-9]{20,}/);
  });
});

/**
 * OPS-SCHEDULER-RUN-PERSISTENCE-001: the run history is the database's, not a
 * process's. A fresh registry — what a restarted process has — reads exactly
 * what the previous one wrote, a FAILED run stays on record after the next
 * success, and a closed row can be neither rewritten nor deleted.
 */
describe('persisted run history', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function lastRun(cookie: string, key: string) {
    const body = (await list(cookie).expect(200)).body as {
      jobs: Array<{ key: string; lastRun: Record<string, unknown> | null }>;
    };
    return body.jobs.find((entry) => entry.key === key)!.lastRun;
  }

  it('answers "no recorded run" for every job that never ran — not a guessed date', async () => {
    const { cookie } = await superAdminCookie();
    for (const job of SCHEDULER_JOB_KEYS) {
      expect(await lastRun(cookie, job)).toBeNull();
    }
    expect(await ctx.prisma.schedulerRun.count()).toBe(0);
  });

  it('writes nothing on a tick of a switched-off job', async () => {
    await refund.runScheduledRefund();
    await lifecycle.runScheduledExpiry();
    expect(await ctx.prisma.schedulerRun.count()).toBe(0);
  });

  it('survives a restart: a fresh registry reads the run the old one wrote', async () => {
    const { cookie } = await superAdminCookie();
    await toggle(cookie, 'request-expiry', true).expect(200);
    await lifecycle.runScheduledExpiry();

    const restarted = new SchedulerRunRegistry(ctx.prisma);
    const runs = await restarted.lastRuns();
    expect(runs['request-expiry']).toMatchObject({ status: 'SUCCESS', trigger: 'SCHEDULER' });
    expect(runs['request-reminder']).toBeNull();

    // The screen reads the same row.
    expect(await lastRun(cookie, 'request-expiry')).toMatchObject({
      id: runs['request-expiry']!.id,
      status: 'SUCCESS',
    });
  });

  it('records a failure by error class only and keeps it after the next success', async () => {
    const { cookie } = await superAdminCookie();
    await toggle(cookie, 'unviewed-offer-refund', true).expect(200);
    vi.spyOn(ctx.app.get(UnviewedOfferRefundService), 'execute').mockRejectedValueOnce(
      new TypeError('connection to postgres://user:secret@db/taktic refused'),
    );

    await refund.runScheduledRefund();
    const failed = await lastRun(cookie, 'unviewed-offer-refund');
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'TypeError', summary: null });
    expect(JSON.stringify(failed)).not.toMatch(/postgres|secret/);

    await refund.runScheduledRefund();
    expect(await lastRun(cookie, 'unviewed-offer-refund')).toMatchObject({ status: 'SUCCESS' });

    const history = await ctx.prisma.schedulerRun.findMany({
      where: { jobKey: 'unviewed-offer-refund' },
      orderBy: { startedAt: 'asc' },
    });
    expect(history.map((row) => row.status)).toEqual(['FAILED', 'SUCCESS']);
    expect(history[0]!.id).not.toBe(history[1]!.id);
  });

  it('shows a run whose end was never recorded as RUNNING with no finish time', async () => {
    const { cookie } = await superAdminCookie();
    // What a process killed mid-run leaves behind: the opening row only.
    await ctx.prisma.schedulerRun.create({
      data: { jobKey: 'request-reminder', status: 'RUNNING', startedAt: new Date() },
    });
    expect(await lastRun(cookie, 'request-reminder')).toMatchObject({
      status: 'RUNNING',
      finishedAt: null,
    });
  });

  it('refuses to rewrite a closed run, to reopen it, or to delete any run', async () => {
    const closed = await ctx.prisma.schedulerRun.create({
      data: {
        jobKey: 'request-expiry',
        status: 'FAILED',
        startedAt: new Date(Date.now() - 1000),
        finishedAt: new Date(),
        errorCode: 'Error',
      },
    });
    await expect(
      ctx.prisma.schedulerRun.update({ where: { id: closed.id }, data: { status: 'SUCCESS', errorCode: null } }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.schedulerRun.update({ where: { id: closed.id }, data: { status: 'RUNNING', finishedAt: null, errorCode: null } }),
    ).rejects.toThrow();
    await expect(ctx.prisma.schedulerRun.delete({ where: { id: closed.id } })).rejects.toThrow();

    const open = await ctx.prisma.schedulerRun.create({
      data: { jobKey: 'request-expiry', status: 'RUNNING', startedAt: new Date() },
    });
    await expect(
      ctx.prisma.schedulerRun.update({ where: { id: open.id }, data: { jobKey: 'request-reminder' } }),
    ).rejects.toThrow();
    // The one legal move: RUNNING → terminal, once.
    await ctx.prisma.schedulerRun.update({
      where: { id: open.id },
      data: { status: 'SUCCESS', finishedAt: new Date() },
    });
    await expect(ctx.prisma.schedulerRun.delete({ where: { id: open.id } })).rejects.toThrow();
    expect(await ctx.prisma.schedulerRun.count()).toBe(2);
  });

  it('refuses a row whose end does not match its status', async () => {
    await expect(
      ctx.prisma.schedulerRun.create({
        data: { jobKey: 'request-expiry', status: 'SUCCESS', startedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.schedulerRun.create({
        data: { jobKey: 'request-expiry', status: 'RUNNING', startedAt: new Date(), errorCode: 'Error' },
      }),
    ).rejects.toThrow();
  });
});
