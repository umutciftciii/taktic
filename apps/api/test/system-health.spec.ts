import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AdminPermission, Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPERATIONS_SETTINGS_ID } from '../src/modules/operations-settings/operations-settings.service';
import {
  SystemHealthService,
  schedulerErrorType,
} from '../src/modules/system-health/system-health.service';
import {
  EMAIL_STUCK_PENDING_MS,
  PROBE_SLOW_MS,
  PROBE_TIMEOUT_MS,
  SCHEDULER_TICK_GRACE_MS,
  countMissedTicks,
  evaluateDatabase,
  evaluateEmail,
  evaluateProbe,
  evaluateSchedulerJob,
  HEALTH_STATUSES,
  type HealthStatus,
  capBackgroundStatus,
  overallStatus,
  resolveProbeTarget,
  worstStatus,
} from '../src/modules/system-health/system-health.rules';
import { DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS } from '../src/modules/offers/refund-policy';
import { createAdminWithPermissions, createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';

/**
 * ADMIN-SYSTEM-HEALTH-001 — the "Sistem sağlığı" report.
 *
 * Three claims. **HEALTHY is measured, never assumed**: an unconfigured probe,
 * a job with no run and a channel with no mail are UNKNOWN, and UNKNOWN keeps a
 * section from reading healthy. **It only looks**: one GET, fixed probe paths
 * from the deployment's environment, short timeouts and a short cache. **It
 * leaks nothing**: no address, connection detail, error class or recipient,
 * and the e-mail block exists only for a NOTIFICATION_LOGS_READ holder.
 */

const ago = (ms: number) => new Date(Date.now() - ms);
const HOUR = 60 * 60_000;

// ---------------------------------------------------------------------------
// The rules, without a database
// ---------------------------------------------------------------------------

describe('rules', () => {
  it('combines states worst-first, and an empty list is UNKNOWN', () => {
    expect(worstStatus([])).toBe('UNKNOWN');
    expect(worstStatus(['HEALTHY', 'HEALTHY'])).toBe('HEALTHY');
    expect(worstStatus(['HEALTHY', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(worstStatus(['UNKNOWN', 'DEGRADED', 'HEALTHY'])).toBe('DEGRADED');
    expect(worstStatus(['DEGRADED', 'DOWN', 'UNKNOWN'])).toBe('DOWN');
  });

  describe('overall state (ADMIN-SYSTEM-HEALTH-002)', () => {
    it('lets only a core service make the system DOWN; background counts as DEGRADED at most', () => {
      expect(capBackgroundStatus('DOWN')).toBe('DEGRADED');
      expect(capBackgroundStatus('DEGRADED')).toBe('DEGRADED');
      expect(capBackgroundStatus('UNKNOWN')).toBe('UNKNOWN');
      expect(capBackgroundStatus('HEALTHY')).toBe('HEALTHY');

      // A late or failing job beside healthy services: a problem, not an outage.
      expect(overallStatus(['HEALTHY', 'HEALTHY', 'HEALTHY'], ['DOWN'])).toBe('DEGRADED');
      expect(overallStatus(['HEALTHY', 'HEALTHY', 'HEALTHY'], ['DOWN', 'DOWN'])).toBe('DEGRADED');
      // A core service down is DOWN, whatever the background says.
      expect(overallStatus(['DOWN', 'HEALTHY', 'HEALTHY'], ['HEALTHY'])).toBe('DOWN');
      expect(overallStatus(['HEALTHY', 'DOWN', 'HEALTHY'], ['DOWN'])).toBe('DOWN');
      // UNKNOWN keeps its place: an unmeasured part is never read as health…
      expect(overallStatus(['HEALTHY', 'HEALTHY', 'HEALTHY'], ['UNKNOWN'])).toBe('UNKNOWN');
      expect(overallStatus(['HEALTHY', 'UNKNOWN', 'HEALTHY'], ['HEALTHY'])).toBe('UNKNOWN');
      // …and never hides a real problem beside it.
      expect(overallStatus(['HEALTHY', 'UNKNOWN', 'HEALTHY'], ['DOWN'])).toBe('DEGRADED');
      expect(overallStatus(['DEGRADED', 'HEALTHY', 'HEALTHY'], ['UNKNOWN'])).toBe('DEGRADED');
      expect(overallStatus(['DOWN', 'UNKNOWN', 'HEALTHY'], ['UNKNOWN'])).toBe('DOWN');
      expect(overallStatus(['HEALTHY', 'HEALTHY', 'HEALTHY'], [])).toBe('HEALTHY');
      expect(overallStatus([], [])).toBe('UNKNOWN');
    });

    it('holds for every combination of one core and one background state', () => {
      const severity = (status: HealthStatus) => ['HEALTHY', 'UNKNOWN', 'DEGRADED', 'DOWN'].indexOf(status);
      for (const core of HEALTH_STATUSES) {
        for (const background of HEALTH_STATUSES) {
          const overall = overallStatus([core], [background]);
          // DOWN comes from the core and only from the core.
          expect(overall === 'DOWN').toBe(core === 'DOWN');
          // Nothing reads better than the core it contains, and HEALTHY needs both.
          expect(severity(overall)).toBeGreaterThanOrEqual(severity(core));
          expect(overall === 'HEALTHY').toBe(core === 'HEALTHY' && background === 'HEALTHY');
          // A background problem always shows: never masked by UNKNOWN or HEALTHY.
          if (background === 'DOWN' || background === 'DEGRADED') expect(severity(overall)).toBeGreaterThanOrEqual(severity('DEGRADED'));
          if (background === 'UNKNOWN' && core === 'HEALTHY') expect(overall).toBe('UNKNOWN');
        }
      }
    });
  });

  describe('probe targets', () => {
    it('is NOT_CONFIGURED when the variable is unset or blank', () => {
      expect(resolveProbeTarget('web', {})).toEqual({ configured: false, reason: 'NOT_CONFIGURED' });
      expect(resolveProbeTarget('admin', { ADMIN_INTERNAL_URL: '   ' })).toEqual({ configured: false, reason: 'NOT_CONFIGURED' });
    });

    it.each([
      'not a url',
      'ftp://web:3000',
      'http://user:secret@web:3000',
      'http://web:3000/some/path',
      'http://web:3000/?x=1',
      'http://web:3000/#frag',
    ])('refuses %s as MISCONFIGURED', (value) => {
      expect(resolveProbeTarget('web', { WEB_INTERNAL_URL: value })).toEqual({ configured: false, reason: 'MISCONFIGURED' });
    });

    it('appends the fixed path to the configured origin', () => {
      const web = resolveProbeTarget('web', { WEB_INTERNAL_URL: 'http://web:3000/' });
      const admin = resolveProbeTarget('admin', { ADMIN_INTERNAL_URL: 'http://admin:3002' });
      expect(web.configured && web.url.toString()).toBe('http://web:3000/robots.txt');
      expect(admin.configured && admin.url.toString()).toBe('http://admin:3002/login');
    });
  });

  it('reads a probe answer: only the expected status is up', () => {
    const answer = (status: number, latencyMs = 20) => evaluateProbe({ kind: 'response', status, latencyMs }, 200);
    expect(answer(200)).toEqual({ status: 'HEALTHY', reason: 'OK' });
    expect(answer(200, PROBE_SLOW_MS + 1)).toEqual({ status: 'DEGRADED', reason: 'SLOW' });
    expect(answer(307)).toEqual({ status: 'DEGRADED', reason: 'UNEXPECTED_REDIRECT' });
    expect(answer(204)).toEqual({ status: 'DEGRADED', reason: 'UNEXPECTED_STATUS' });
    expect(answer(404)).toEqual({ status: 'DEGRADED', reason: 'UNEXPECTED_STATUS' });
    expect(answer(503)).toEqual({ status: 'DOWN', reason: 'SERVER_ERROR' });
    expect(evaluateProbe({ kind: 'timeout', latencyMs: PROBE_TIMEOUT_MS }, 200)).toEqual({ status: 'DOWN', reason: 'TIMEOUT' });
    expect(evaluateProbe({ kind: 'error', latencyMs: 3 }, 200)).toEqual({ status: 'DOWN', reason: 'UNREACHABLE' });
  });

  it('reads the database probe', () => {
    expect(evaluateDatabase('ok', 5)).toEqual({ status: 'HEALTHY', reason: 'OK' });
    expect(evaluateDatabase('ok', PROBE_SLOW_MS + 1)).toEqual({ status: 'DEGRADED', reason: 'SLOW' });
    expect(evaluateDatabase('timeout', 2000)).toEqual({ status: 'DOWN', reason: 'TIMEOUT' });
    expect(evaluateDatabase('unreachable', 3)).toEqual({ status: 'DOWN', reason: 'UNREACHABLE' });
  });

  describe('scheduler jobs', () => {
    const now = new Date('2026-10-30T12:00:00.000Z');
    const at = (iso: string) => new Date(iso);
    const job = (overrides: Partial<Parameters<typeof evaluateSchedulerJob>[0]> = {}) => ({
      enabled: true,
      cron: '*/5 * * * *',
      lastRun: { status: 'SUCCESS' as const, startedAt: at('2026-10-30T11:55:00.020Z'), errorCode: null },
      enabledSince: null,
      failuresSinceLastSuccess: 0,
      ...overrides,
    });

    it('counts only ticks past their grace, capped at three', () => {
      // 11:55 started; 12:00 is the next tick, still inside its grace at 12:00.
      expect(countMissedTicks('*/5 * * * *', at('2026-10-30T11:55:00.020Z'), now)).toBe(0);
      // 11:45 started; 11:50 is past its grace (11:55), 11:55 is not.
      expect(countMissedTicks('*/5 * * * *', at('2026-10-30T11:45:00.020Z'), now)).toBe(1);
      expect(countMissedTicks('*/5 * * * *', at('2026-10-29T00:00:00.000Z'), now)).toBe(3);
      expect(SCHEDULER_TICK_GRACE_MS).toBe(5 * 60_000);
    });

    it('does not measure a switched-off job, nor one that never ran', () => {
      expect(evaluateSchedulerJob(job({ enabled: false }), now)).toMatchObject({ status: 'UNKNOWN', reason: 'DISABLED' });
      expect(evaluateSchedulerJob(job({ lastRun: null }), now)).toMatchObject({ status: 'UNKNOWN', reason: 'NO_RECORDED_RUN' });
      // Switched on a moment ago: no tick is due yet.
      expect(
        evaluateSchedulerJob(job({ lastRun: null, enabledSince: at('2026-10-30T11:58:00Z') }), now),
      ).toMatchObject({ status: 'UNKNOWN', reason: 'NO_RECORDED_RUN' });
    });

    it('calls a switched-on job that never ran overdue once its ticks pass', () => {
      expect(
        evaluateSchedulerJob(job({ lastRun: null, enabledSince: at('2026-10-30T11:45:00.020Z') }), now),
      ).toMatchObject({ status: 'DEGRADED', reason: 'OVERDUE', missedTicks: 1 });
      expect(
        evaluateSchedulerJob(job({ lastRun: null, enabledSince: at('2026-10-29T00:00:00Z') }), now),
      ).toMatchObject({ status: 'DOWN', reason: 'OVERDUE', missedTicks: 3 });
    });

    it('is HEALTHY on a recent success and while a run is open', () => {
      expect(evaluateSchedulerJob(job(), now)).toMatchObject({ status: 'HEALTHY', reason: 'LAST_RUN_SUCCEEDED' });
      expect(
        evaluateSchedulerJob(job({ lastRun: { status: 'RUNNING', startedAt: at('2026-10-30T09:00:00Z'), errorCode: null } }), now),
      ).toMatchObject({ status: 'HEALTHY', reason: 'RUNNING' });
    });

    it('is overdue when scheduled ticks passed without a run', () => {
      const late = (startedAt: string) =>
        evaluateSchedulerJob(job({ lastRun: { status: 'SUCCESS', startedAt: at(startedAt), errorCode: null } }), now);
      expect(late('2026-10-30T11:45:00.020Z')).toMatchObject({ status: 'DEGRADED', reason: 'OVERDUE', missedTicks: 1 });
      expect(late('2026-10-30T10:00:00.020Z')).toMatchObject({ status: 'DOWN', reason: 'OVERDUE', missedTicks: 3 });
    });

    it('counts from the moment a job was switched back on', () => {
      const stale = { status: 'SUCCESS' as const, startedAt: at('2026-10-01T00:00:00Z'), errorCode: null };
      expect(evaluateSchedulerJob(job({ lastRun: stale, enabledSince: at('2026-10-30T11:58:00Z') }), now)).toMatchObject({
        status: 'HEALTHY',
        missedTicks: 0,
      });
    });

    it('reads failures: one is DEGRADED, three in a row is DOWN', () => {
      const failed = (errorCode: string, failuresSinceLastSuccess: number) =>
        evaluateSchedulerJob(
          job({ lastRun: { status: 'FAILED', startedAt: at('2026-10-30T11:55:00.020Z'), errorCode }, failuresSinceLastSuccess }),
          now,
        );
      expect(failed('TypeError', 1)).toMatchObject({ status: 'DEGRADED', reason: 'LAST_RUN_FAILED' });
      expect(failed('PROCESS_INTERRUPTED', 1)).toMatchObject({ status: 'DEGRADED', reason: 'LAST_RUN_INTERRUPTED' });
      expect(failed('TypeError', 3)).toMatchObject({ status: 'DOWN', reason: 'REPEATED_FAILURES' });
    });

    it('reports an error as a coarse type, never its class name', () => {
      expect(schedulerErrorType('PROCESS_INTERRUPTED')).toBe('PROCESS_INTERRUPTED');
      expect(schedulerErrorType('PrismaClientKnownRequestError')).toBe('DATABASE_ERROR');
      expect(schedulerErrorType('TypeError')).toBe('APPLICATION_ERROR');
      expect(schedulerErrorType(null)).toBe('APPLICATION_ERROR');
    });
  });

  it('reads the e-mail channel', () => {
    const email = (sent: number, failed: number, stuckPending = 0, pending = 0) =>
      evaluateEmail({ sent, failed, pending, stuckPending });
    expect(email(0, 0)).toEqual({ status: 'UNKNOWN', reason: 'NO_TRAFFIC' });
    expect(email(0, 0, 0, 2)).toEqual({ status: 'UNKNOWN', reason: 'NO_TRAFFIC' });
    expect(email(50, 0)).toEqual({ status: 'HEALTHY', reason: 'OK' });
    expect(email(95, 4)).toEqual({ status: 'HEALTHY', reason: 'OK' });
    expect(email(9, 1)).toEqual({ status: 'DEGRADED', reason: 'FAILURES' });
    expect(email(50, 0, 1)).toEqual({ status: 'DEGRADED', reason: 'STUCK_PENDING' });
    expect(email(2, 2)).toEqual({ status: 'DEGRADED', reason: 'FAILURES' });
    expect(email(3, 3)).toEqual({ status: 'DOWN', reason: 'MOSTLY_FAILING' });
    expect(email(0, 5)).toEqual({ status: 'DOWN', reason: 'MOSTLY_FAILING' });
  });
});

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

type Stub = {
  server: Server;
  origin: string;
  paths: string[];
  respond: (req: IncomingMessage, res: ServerResponse) => void;
};

async function startStub(): Promise<Stub> {
  const stub = {
    paths: [] as string[],
    respond: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    },
  } as Stub;
  stub.server = createServer((req, res) => {
    stub.paths.push(req.url ?? '');
    stub.respond(req, res);
  });
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve));
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
  return stub;
}

describe('GET /system-health', () => {
  let ctx: TestContext;
  let web: Stub;
  let admin: Stub;
  const savedEnv = { web: process.env.WEB_INTERNAL_URL, admin: process.env.ADMIN_INTERNAL_URL };

  const service = () => ctx.app.get(SystemHealthService);
  const fetchReport = (cookie?: string) => {
    const call = request(ctx.server).get('/system-health');
    return cookie ? call.set('Cookie', cookie) : call;
  };

  async function sessionWith(permissions: AdminPermission[]) {
    const { admin: user } = await createAdminWithPermissions(ctx.prisma, permissions);
    return loginAs(ctx.prisma, user.id);
  }

  async function superAdminSession() {
    const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    return loginAs(ctx.prisma, user.id);
  }

  async function switchOn(...settings: Array<'requestExpirySchedulerEnabled' | 'requestReminderSchedulerEnabled'>) {
    await ctx.prisma.operationsSettings.upsert({
      where: { id: OPERATIONS_SETTINGS_ID },
      create: {
        id: OPERATIONS_SETTINGS_ID,
        unviewedOfferRefundWindowHours: DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
        ...Object.fromEntries(settings.map((setting) => [setting, true])),
      },
      update: Object.fromEntries(settings.map((setting) => [setting, true])),
    });
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    [web, admin] = await Promise.all([startStub(), startStub()]);
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.prisma.operationsSettingsChange.deleteMany();
    await ctx.prisma.operationsSettings.deleteMany();
    process.env.WEB_INTERNAL_URL = web.origin;
    process.env.ADMIN_INTERNAL_URL = admin.origin;
    web.paths.length = 0;
    admin.paths.length = 0;
    web.respond = admin.respond = (_req, res) => {
      res.writeHead(200);
      res.end('ok');
    };
    service().clearCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    process.env.WEB_INTERNAL_URL = savedEnv.web;
    process.env.ADMIN_INTERNAL_URL = savedEnv.admin;
    if (savedEnv.web === undefined) delete process.env.WEB_INTERNAL_URL;
    if (savedEnv.admin === undefined) delete process.env.ADMIN_INTERNAL_URL;
    await Promise.all([web, admin].map((stub) => new Promise((resolve) => stub.server.close(resolve))));
    await ctx.app.close();
  });

  describe('access', () => {
    it('refuses an anonymous caller, a customer and a provider', async () => {
      await fetchReport().expect(401);
      for (const role of [UserRole.CUSTOMER, UserRole.PROVIDER]) {
        const user = await createUser(ctx.prisma, { role });
        await fetchReport(await loginAs(ctx.prisma, user.id)).expect(403);
      }
    });

    it('refuses staff without OPERATIONS_SETTINGS_READ — NOTIFICATION_LOGS_READ alone opens nothing', async () => {
      await fetchReport(await sessionWith([AdminPermission.NOTIFICATION_LOGS_READ])).expect(403);
      await fetchReport(await sessionWith([AdminPermission.DASHBOARD_READ])).expect(403);
    });

    it('omits the e-mail block without NOTIFICATION_LOGS_READ (absent, not empty)', async () => {
      const response = await fetchReport(await sessionWith([AdminPermission.OPERATIONS_SETTINGS_READ])).expect(200);
      expect(response.body).not.toHaveProperty('email');
      expect(JSON.stringify(response.body)).not.toMatch(/template|maskedRecipient/);
    });

    it('carries the e-mail block with both permissions, and for a SUPER_ADMIN', async () => {
      const both = await fetchReport(
        await sessionWith([AdminPermission.OPERATIONS_SETTINGS_READ, AdminPermission.NOTIFICATION_LOGS_READ]),
      ).expect(200);
      expect(both.body).toHaveProperty('email');
      const root = await fetchReport(await superAdminSession()).expect(200);
      expect(root.body).toHaveProperty('email');
    });

    it('offers no write verb', async () => {
      const cookie = await superAdminSession();
      for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
        await request(ctx.server)[verb]('/system-health').set('Cookie', cookie).expect(404);
      }
    });
  });

  describe('probes', () => {
    it('reports web and admin HEALTHY on their expected answers, at their fixed paths', async () => {
      const response = await fetchReport(`${await superAdminSession()}`).query({ target: 'http://evil.test' }).expect(200);
      expect(response.body.web).toMatchObject({ status: 'HEALTHY', reason: 'OK', httpStatus: 200 });
      expect(response.body.admin).toMatchObject({ status: 'HEALTHY', reason: 'OK', httpStatus: 200 });
      expect(web.paths).toEqual(['/robots.txt']);
      expect(admin.paths).toEqual(['/login']);
      expect(typeof response.body.web.checkedAt).toBe('string');
    });

    it('does not follow a redirect from the sign-in page, and calls it DEGRADED', async () => {
      admin.respond = (_req, res) => {
        res.writeHead(307, { location: '/login?next=%2F' });
        res.end();
      };
      const response = await fetchReport(await superAdminSession()).expect(200);
      expect(response.body.admin).toMatchObject({ status: 'DEGRADED', reason: 'UNEXPECTED_REDIRECT', httpStatus: 307 });
      expect(admin.paths).toEqual(['/login']);
    });

    it('is DOWN on a 5xx and on no answer within the timeout', async () => {
      web.respond = (_req, res) => {
        res.writeHead(502);
        res.end();
      };
      admin.respond = () => undefined; // never answers
      const started = Date.now();
      const response = await fetchReport(await superAdminSession()).expect(200);
      expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS + 2_000);
      expect(response.body.web).toMatchObject({ status: 'DOWN', reason: 'SERVER_ERROR' });
      expect(response.body.admin).toMatchObject({ status: 'DOWN', reason: 'TIMEOUT', httpStatus: null });
      expect(response.body.overall).toBe('DOWN');
    });

    it('is UNKNOWN, never HEALTHY, when the address is unset or unusable — and never echoes it', async () => {
      delete process.env.WEB_INTERNAL_URL;
      process.env.ADMIN_INTERNAL_URL = 'http://probe-user:probe-secret@admin.internal:3002';
      const response = await fetchReport(await superAdminSession()).expect(200);
      expect(response.body.web).toMatchObject({ status: 'UNKNOWN', reason: 'NOT_CONFIGURED', latencyMs: null });
      expect(response.body.admin).toMatchObject({ status: 'UNKNOWN', reason: 'MISCONFIGURED' });
      expect(response.body.overall).not.toBe('HEALTHY');
      expect(JSON.stringify(response.body)).not.toMatch(/probe-secret|probe-user|admin\.internal|127\.0\.0\.1/);
    });

    it('holds each measurement briefly, so refreshing does not re-probe', async () => {
      const cookie = await superAdminSession();
      await fetchReport(cookie).expect(200);
      await fetchReport(cookie).expect(200);
      await fetchReport(cookie).expect(200);
      expect(web.paths).toHaveLength(1);
      expect(admin.paths).toHaveLength(1);
    });

    it('reports the database from the readiness probe, with nothing about the connection', async () => {
      const ok = await fetchReport(await superAdminSession()).expect(200);
      expect(ok.body.database).toMatchObject({ status: 'HEALTHY', reason: 'OK' });
      expect(ok.body.database.appliedMigrations).toBeGreaterThan(0);

      service().clearCache();
      vi.spyOn(ctx.prisma, '$queryRaw').mockRejectedValue(
        new Prisma.PrismaClientInitializationError("Can't reach database server at `db-secret-host.internal:5432`", '6.0.0', 'P1001'),
      );
      const down = await fetchReport(await superAdminSession()).expect(200);
      expect(down.body.database).toMatchObject({ status: 'DOWN', reason: 'UNREACHABLE', appliedMigrations: null });
      expect(down.body.overall).toBe('DOWN');
      const url = new URL(process.env.DATABASE_URL!);
      const text = JSON.stringify(down.body);
      expect(text).not.toContain('db-secret-host');
      expect(text).not.toContain(decodeURIComponent(url.password));
    });

    it('lists what this phase does not measure instead of claiming it', async () => {
      const response = await fetchReport(await superAdminSession()).expect(200);
      expect(response.body.notMeasured).toEqual(['EXTERNAL_UPTIME', 'BACKUPS', 'HOST_RESOURCES', 'CAMPAIGN_EVALUATION_WORKER']);
      expect(response.body).not.toHaveProperty('api');
    });
  });

  describe('schedulers', () => {
    it('leaves switched-off jobs out of the state, and measures the always-on one', async () => {
      const response = await fetchReport(await superAdminSession()).expect(200);
      expect(response.body.schedulers).toMatchObject({ status: 'UNKNOWN', reason: 'OK' });
      const expiry = response.body.schedulers.jobs.find((job: { key: string }) => job.key === 'request-expiry');
      expect(expiry).toMatchObject({ enabled: false, switchable: true, status: 'UNKNOWN', reason: 'DISABLED' });
      // The always-on housekeeping job is measured even with every switch off.
      const seo = response.body.schedulers.jobs.find((job: { key: string }) => job.key === 'seo-not-found-retention');
      expect(seo).toMatchObject({ enabled: true, switchable: false, status: 'UNKNOWN', reason: 'NO_RECORDED_RUN' });
    });

    it('reads last runs, failures and overdue jobs — by error type, never class name', async () => {
      // The suite pins every cron to once a year; this case needs the shipped hourly one.
      vi.stubEnv('REQUEST_REMINDER_SCHEDULER_CRON', '45 * * * *');
      await switchOn('requestExpirySchedulerEnabled', 'requestReminderSchedulerEnabled');
      // request-expiry: its last run failed on a database error, a minute ago.
      await ctx.prisma.schedulerRun.create({
        data: { jobKey: 'request-expiry', status: 'SUCCESS', startedAt: ago(2 * HOUR), finishedAt: ago(2 * HOUR), summary: 'processed=1' },
      });
      await ctx.prisma.schedulerRun.create({
        data: {
          jobKey: 'request-expiry',
          status: 'FAILED',
          startedAt: ago(60_000),
          finishedAt: ago(50_000),
          errorCode: 'PrismaClientKnownRequestError',
        },
      });
      // request-reminder (hourly): last started six hours ago, so overdue.
      await ctx.prisma.schedulerRun.create({
        data: { jobKey: 'request-reminder', status: 'SUCCESS', startedAt: ago(6 * HOUR), finishedAt: ago(6 * HOUR) },
      });

      const response = await fetchReport(await superAdminSession()).expect(200);
      const jobs = Object.fromEntries(
        response.body.schedulers.jobs.map((job: { key: string }) => [job.key, job]),
      );
      expect(jobs['request-expiry']).toMatchObject({
        enabled: true,
        status: 'DEGRADED',
        reason: 'LAST_RUN_FAILED',
        lastRun: { status: 'FAILED', errorType: 'DATABASE_ERROR' },
      });
      expect(jobs['request-expiry'].lastSuccessAt).not.toBeNull();
      expect(jobs['request-expiry'].last24h).toEqual({ succeeded: 1, failed: 1 });
      expect(jobs['request-reminder']).toMatchObject({ status: 'DOWN', reason: 'OVERDUE', missedTicks: 3 });
      expect(response.body.schedulers.status).toBe('DOWN');
      expect(response.body.schedulers.recentFailures).toEqual([
        expect.objectContaining({ jobKey: 'request-expiry', errorType: 'DATABASE_ERROR' }),
      ]);
      expect(JSON.stringify(response.body)).not.toContain('PrismaClient');
      expect(JSON.stringify(response.body)).not.toContain('processed=1');
    });

    it('is HEALTHY for an on-time successful job', async () => {
      await switchOn('requestExpirySchedulerEnabled');
      await ctx.prisma.schedulerRun.create({
        data: { jobKey: 'request-expiry', status: 'SUCCESS', startedAt: ago(30_000), finishedAt: ago(20_000) },
      });
      const response = await fetchReport(await superAdminSession()).expect(200);
      const expiry = response.body.schedulers.jobs.find((job: { key: string }) => job.key === 'request-expiry');
      expect(expiry).toMatchObject({ status: 'HEALTHY', reason: 'LAST_RUN_SUCCEEDED', missedTicks: 0 });
    });
  });

  describe('e-mail', () => {
    async function log(status: 'SENT' | 'FAILED' | 'PENDING', overrides: Record<string, unknown> = {}) {
      await ctx.prisma.notificationLog.create({
        data: {
          channel: 'EMAIL',
          template: 'offer-received',
          maskedRecipient: 'c***@example.test',
          status,
          ...(status === 'SENT' ? { sentAt: new Date() } : {}),
          ...(status === 'FAILED' ? { failedAt: new Date(), errorCode: 'TRANSPORT_REJECTED' } : {}),
          ...overrides,
        },
      });
    }

    it('counts SENT, FAILED and PENDING over 24 hours and lists failures without recipients', async () => {
      for (let i = 0; i < 6; i += 1) await log('SENT');
      await log('FAILED');
      await log('PENDING');
      await log('PENDING', { createdAt: ago(EMAIL_STUCK_PENDING_MS * 2), lastAttemptAt: ago(EMAIL_STUCK_PENDING_MS * 2) });
      // Outside the window: not counted.
      await log('SENT', { createdAt: ago(30 * HOUR), sentAt: ago(30 * HOUR) });
      // SMS is not this section's channel.
      await ctx.prisma.notificationLog.create({
        data: { channel: 'SMS', template: 'phone-code', maskedRecipient: '+90 *** *** ** 34', status: 'FAILED', failedAt: new Date() },
      });

      const cookie = await sessionWith([AdminPermission.OPERATIONS_SETTINGS_READ, AdminPermission.NOTIFICATION_LOGS_READ]);
      const response = await fetchReport(cookie).expect(200);
      expect(response.body.email).toMatchObject({
        status: 'DEGRADED',
        reason: 'FAILURES',
        windowHours: 24,
        counts: { sent: 6, failed: 1, pending: 2, stuckPending: 1 },
      });
      expect(response.body.email.lastSentAt).not.toBeNull();
      expect(response.body.email.recentFailures).toHaveLength(1);
      expect(response.body.email.recentFailures[0]).toEqual({
        id: expect.any(String),
        template: 'offer-received',
        errorCode: expect.any(String),
        errorLabel: expect.any(String),
        at: expect.any(String),
      });
      expect(JSON.stringify(response.body)).not.toMatch(/example\.test|\*\*\*/);
    });

    it('is UNKNOWN with no mail in the window', async () => {
      const response = await fetchReport(await superAdminSession()).expect(200);
      expect(response.body.email).toMatchObject({ status: 'UNKNOWN', reason: 'NO_TRAFFIC' });
    });
  });

  describe('overall', () => {
    async function seoRanJustNow() {
      await ctx.prisma.schedulerRun.create({
        data: { jobKey: 'seo-not-found-retention', status: 'SUCCESS', startedAt: ago(30_000), finishedAt: ago(20_000) },
      });
    }

    it('is HEALTHY when every measured source is — switched-off jobs, a quiet mail day and Faz 2 items do not hold it at UNKNOWN', async () => {
      await seoRanJustNow();
      const response = await fetchReport(await superAdminSession()).expect(200);
      expect(response.body.notMeasured.length).toBeGreaterThan(0);
      expect(response.body.schedulers.jobs.filter((job: { enabled: boolean }) => !job.enabled).length).toBeGreaterThan(0);
      expect(response.body.email).toMatchObject({ status: 'UNKNOWN', reason: 'NO_TRAFFIC' });
      expect(response.body.overall).toBe('HEALTHY');
    });

    it('keeps a failed measurement UNKNOWN and lets DOWN or DEGRADED through', async () => {
      await seoRanJustNow();
      const cookie = await superAdminSession();

      // An unmeasurable probe holds the overall state at UNKNOWN, not HEALTHY.
      delete process.env.ADMIN_INTERNAL_URL;
      expect((await fetchReport(cookie).expect(200)).body.overall).toBe('UNKNOWN');

      // A real fault beside it is not masked by that UNKNOWN.
      service().clearCache();
      web.respond = (_req, res) => {
        res.writeHead(307, { location: '/elsewhere' });
        res.end();
      };
      expect((await fetchReport(cookie).expect(200)).body.overall).toBe('DEGRADED');

      service().clearCache();
      web.respond = (_req, res) => {
        res.writeHead(502);
        res.end();
      };
      expect((await fetchReport(cookie).expect(200)).body.overall).toBe('DOWN');
    });

    it('still counts e-mail once there is traffic to judge', async () => {
      await seoRanJustNow();
      for (let i = 0; i < 3; i += 1) {
        await ctx.prisma.notificationLog.create({
          data: { channel: 'EMAIL', template: 'offer-received', maskedRecipient: 'c***@example.test', status: 'FAILED', failedAt: new Date() },
        });
      }
      const response = await fetchReport(await superAdminSession()).expect(200);
      // The channel reads DOWN on its own; the system serving people is DEGRADED.
      expect(response.body.email).toMatchObject({ status: 'DOWN', reason: 'MOSTLY_FAILING' });
      expect(response.body.overall).toBe('DEGRADED');
    });

    it('reads a job three ticks late as DEGRADED overall, while the job keeps its DOWN, its reason and its count', async () => {
      await seoRanJustNow();
      vi.stubEnv('REQUEST_REMINDER_SCHEDULER_CRON', '45 * * * *');
      await switchOn('requestReminderSchedulerEnabled');
      await ctx.prisma.schedulerRun.create({
        data: { jobKey: 'request-reminder', status: 'SUCCESS', startedAt: ago(6 * HOUR), finishedAt: ago(6 * HOUR) },
      });
      const response = await fetchReport(await superAdminSession()).expect(200);
      const reminder = response.body.schedulers.jobs.find((job: { key: string }) => job.key === 'request-reminder');
      expect(reminder).toMatchObject({ enabled: true, status: 'DOWN', reason: 'OVERDUE', missedTicks: 3 });
      expect(response.body.schedulers.status).toBe('DOWN');
      expect(response.body.overall).toBe('DEGRADED');
    });

    it('reads a job that keeps failing as DEGRADED overall, and a core service down as DOWN beside it', async () => {
      await switchOn('requestExpirySchedulerEnabled');
      await seoRanJustNow();
      for (const minutes of [3, 2, 1]) {
        await ctx.prisma.schedulerRun.create({
          data: { jobKey: 'request-expiry', status: 'FAILED', startedAt: ago(minutes * 60_000), finishedAt: ago(minutes * 60_000), errorCode: 'Error' },
        });
      }
      const cookie = await superAdminSession();
      const failing = await fetchReport(cookie).expect(200);
      const expiry = failing.body.schedulers.jobs.find((job: { key: string }) => job.key === 'request-expiry');
      expect(expiry).toMatchObject({ status: 'DOWN', reason: 'REPEATED_FAILURES' });
      expect(failing.body.overall).toBe('DEGRADED');

      service().clearCache();
      web.respond = (_req, res) => {
        res.writeHead(502);
        res.end();
      };
      expect((await fetchReport(cookie).expect(200)).body.overall).toBe('DOWN');
    });

    it('keeps a switched-off job out of the state entirely', async () => {
      await seoRanJustNow();
      // Off, with a stale run that would be badly overdue were it on.
      await ctx.prisma.schedulerRun.create({
        data: { jobKey: 'request-reminder', status: 'FAILED', startedAt: ago(48 * HOUR), finishedAt: ago(48 * HOUR), errorCode: 'Error' },
      });
      const response = await fetchReport(await superAdminSession()).expect(200);
      const reminder = response.body.schedulers.jobs.find((job: { key: string }) => job.key === 'request-reminder');
      expect(reminder).toMatchObject({ enabled: false, status: 'UNKNOWN', reason: 'DISABLED' });
      expect(response.body.overall).toBe('HEALTHY');
    });
  });

  describe('environment', () => {
    it('says which deployment answered, from APP_ENVIRONMENT, and unknown when it is unset or misspelt', async () => {
      const cookie = await superAdminSession();
      for (const [value, expected] of [
        ['local', 'local'],
        ['staging', 'staging'],
        ['production', 'production'],
        ['', null],
        ['prod', null],
      ] as const) {
        vi.stubEnv('APP_ENVIRONMENT', value);
        const response = await fetchReport(cookie).expect(200);
        expect(response.body.environment).toBe(expected);
      }
    });
  });
});
