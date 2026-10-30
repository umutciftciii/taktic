import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationStatus, SchedulerRunStatus, SchedulerRunTrigger } from '@prisma/client';
import { readSchedulerCron, readSeoNotFoundRetentionCron } from '../../common/scheduler-cron';
import { PrismaService } from '../../prisma/prisma.service';
import { ReadinessService } from '../health/readiness.service';
import {
  NotificationErrorCode,
  normalizeStoredErrorCode,
  notificationErrorLabel,
} from '../notifications/notification-errors';
import {
  RECORDED_ONLY_JOB_KEYS,
  RecordedJobKey,
  SCHEDULER_JOB_KEYS,
  SCHEDULER_JOB_SETTINGS,
} from '../operations-settings/scheduler-jobs';
import { SchedulerSettingsService } from '../operations-settings/scheduler-settings.service';
import {
  DatabaseReason,
  EMAIL_STUCK_PENDING_MS,
  EMAIL_WINDOW_MS,
  EmailReason,
  HealthStatus,
  INTERNAL_PROBES,
  PROBE_TIMEOUT_MS,
  ProbeOutcome,
  ProbeReason,
  ProbeTarget,
  SCHEDULER_FAILURES_DOWN,
  SchedulerReason,
  evaluateDatabase,
  evaluateEmail,
  evaluateProbe,
  evaluateSchedulerJob,
  resolveProbeTarget,
  worstStatus,
} from './system-health.rules';

/**
 * ADMIN-SYSTEM-HEALTH-001 — the "Sistem sağlığı" report.
 *
 * Read-only by construction: nothing here restarts, triggers, retries or
 * writes. Every source is measured with a short timeout, and each result is
 * held in this process for a few seconds, so a screen refreshing every minute
 * — or an operator pressing "Yenile" repeatedly — costs at most one round of
 * probes and queries per window, not one per request. Concurrent requests
 * inside a window share the same in-flight measurement.
 *
 * What the report never carries: an address, a host name, a connection
 * string, a raw error message or stack, a recipient, or anything about a
 * person. Failures are reported by a closed set of reason codes; a scheduler
 * failure by a coarse error type, not its class name.
 *
 * What it does not claim: the API is not asked whether the API is up — the
 * panel's server measures that by reaching it — and the web and admin probes
 * are the deployment's internal network, which says the process answers, not
 * that the public reaches it. External uptime, backups and host resources are
 * not measured at all in this phase, and the report says so instead of
 * filling them in.
 */

/** Probes (database, web, admin) are re-measured at most this often. */
export const PROBE_CACHE_MS = 15_000;
/** The scheduler and e-mail reads are re-run at most this often. */
export const QUERY_CACHE_MS = 30_000;
/** A section's reads get this long before the section is UNKNOWN. */
export const SECTION_QUERY_TIMEOUT_MS = 3_000;
/** Failed scheduler runs / e-mails looked back over, and how many are listed. */
export const RECENT_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const RECENT_FAILURE_LIMIT = 10;

export type ComponentReport<Reason extends string> = {
  status: HealthStatus;
  reason: Reason;
  checkedAt: string;
};

export type DatabaseReport = ComponentReport<DatabaseReason> & {
  latencyMs: number;
  appliedMigrations: number | null;
};

export type ProbeReport = ComponentReport<ProbeReason> & {
  /** Null when nothing was sent (not configured). */
  latencyMs: number | null;
  /** The HTTP status that came back, when one did. */
  httpStatus: number | null;
};

/** A coarse class of failure — never the error's class name or message. */
export type SchedulerErrorType = 'PROCESS_INTERRUPTED' | 'DATABASE_ERROR' | 'APPLICATION_ERROR';

export type SchedulerJobReport = {
  key: RecordedJobKey;
  /** False only for a job with an operations switch that is off. */
  enabled: boolean;
  /** Whether the job has an operations switch at all. */
  switchable: boolean;
  cron: string;
  status: HealthStatus;
  reason: SchedulerReason;
  missedTicks: number;
  lastRun: {
    status: SchedulerRunStatus;
    startedAt: string;
    finishedAt: string | null;
    errorType: SchedulerErrorType | null;
  } | null;
  lastSuccessAt: string | null;
  last24h: { succeeded: number; failed: number };
};

export type SchedulerFailure = {
  jobKey: RecordedJobKey;
  errorType: SchedulerErrorType;
  at: string;
};

export type SchedulersReport = {
  status: HealthStatus;
  reason: 'OK' | 'QUERY_FAILED';
  checkedAt: string;
  jobs: SchedulerJobReport[];
  recentFailures: SchedulerFailure[];
};

export type EmailFailure = {
  id: string;
  template: string;
  errorCode: NotificationErrorCode | null;
  errorLabel: string | null;
  at: string;
};

export type EmailReport = {
  status: HealthStatus;
  reason: EmailReason | 'QUERY_FAILED';
  checkedAt: string;
  windowHours: number;
  counts: { sent: number; failed: number; pending: number; stuckPending: number } | null;
  lastSentAt: string | null;
  recentFailures: EmailFailure[];
};

/** Sources this phase does not measure, listed so their absence is visible. */
export const NOT_MEASURED = [
  'EXTERNAL_UPTIME',
  'BACKUPS',
  'HOST_RESOURCES',
  'CAMPAIGN_EVALUATION_WORKER',
] as const;

export type SystemHealthReport = {
  generatedAt: string;
  /** Worst of the components below; the panel folds in its own API probe. */
  overall: HealthStatus;
  database: DatabaseReport;
  web: ProbeReport;
  admin: ProbeReport;
  schedulers: SchedulersReport;
  /** Present only for a caller holding NOTIFICATION_LOGS_READ. */
  email?: EmailReport;
  notMeasured: typeof NOT_MEASURED;
};

type Cached<T> = { expiresAt: number; value: Promise<T> };

class SectionTimeoutError extends Error {}

/** Settles with the work or a timeout; a late rejection is swallowed. */
function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SectionTimeoutError()), timeoutMs);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function schedulerErrorType(errorCode: string | null): SchedulerErrorType {
  if (errorCode === 'PROCESS_INTERRUPTED') return 'PROCESS_INTERRUPTED';
  if (errorCode?.startsWith('PrismaClient')) return 'DATABASE_ERROR';
  return 'APPLICATION_ERROR';
}

const RECORDED_JOBS: readonly RecordedJobKey[] = [...SCHEDULER_JOB_KEYS, ...RECORDED_ONLY_JOB_KEYS];

function cronOf(job: RecordedJobKey): string {
  return job === 'seo-not-found-retention' ? readSeoNotFoundRetentionCron() : readSchedulerCron(job);
}

@Injectable()
export class SystemHealthService {
  private readonly logger = new Logger(SystemHealthService.name);
  private readonly cache = new Map<string, Cached<unknown>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
    @Inject(SchedulerSettingsService) private readonly schedulerSettings: SchedulerSettingsService,
  ) {}

  async report(options: { includeEmail: boolean }): Promise<SystemHealthReport> {
    const [database, web, admin, schedulers, email] = await Promise.all([
      this.cached('database', PROBE_CACHE_MS, () => this.measureDatabase()),
      this.cached('web', PROBE_CACHE_MS, () => this.probe('web')),
      this.cached('admin', PROBE_CACHE_MS, () => this.probe('admin')),
      this.cached('schedulers', QUERY_CACHE_MS, () => this.measureSchedulers()),
      options.includeEmail ? this.cached('email', QUERY_CACHE_MS, () => this.measureEmail()) : undefined,
    ]);

    const counted: HealthStatus[] = [database.status, web.status, admin.status, schedulers.status];
    if (email) counted.push(email.status);

    return {
      generatedAt: new Date().toISOString(),
      overall: worstStatus(counted),
      database,
      web,
      admin,
      schedulers,
      ...(email ? { email } : {}),
      notMeasured: NOT_MEASURED,
    };
  }

  /** Drops every held measurement. Tests use it; nothing in the app does. */
  clearCache() {
    this.cache.clear();
  }

  private cached<T>(key: string, ttlMs: number, measure: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(key) as Cached<T> | undefined;
    if (hit && hit.expiresAt > now) return hit.value;
    const value = measure();
    this.cache.set(key, { expiresAt: now + ttlMs, value });
    return value;
  }

  private async measureDatabase(): Promise<DatabaseReport> {
    const started = performance.now();
    const answer = await this.readiness.check();
    const latencyMs = Math.round(performance.now() - started);
    const { status, reason } = evaluateDatabase(answer.database, latencyMs);
    return {
      status,
      reason,
      checkedAt: new Date().toISOString(),
      latencyMs,
      appliedMigrations: answer.ready ? answer.appliedMigrations : null,
    };
  }

  /**
   * One GET to the service's fixed path on its internal address. Redirects
   * are not followed (a redirect is itself the answer), the body is not
   * read, and nothing about the target appears in the report or the log.
   */
  private async probe(target: ProbeTarget): Promise<ProbeReport> {
    const checkedAt = () => new Date().toISOString();
    const resolved = resolveProbeTarget(target);
    if (!resolved.configured) {
      return { status: 'UNKNOWN', reason: resolved.reason, checkedAt: checkedAt(), latencyMs: null, httpStatus: null };
    }

    const started = performance.now();
    let outcome: ProbeOutcome;
    try {
      const response = await fetch(resolved.url, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { 'user-agent': 'taktic-system-health' },
      });
      await response.body?.cancel().catch(() => undefined);
      outcome = { kind: 'response', status: response.status, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      outcome = timedOut ? { kind: 'timeout', latencyMs } : { kind: 'error', latencyMs };
    }

    const { status, reason } = evaluateProbe(outcome, INTERNAL_PROBES[target].expectedStatus);
    if (status !== 'HEALTHY') this.logger.warn(`system health: ${target} probe ${reason}`);
    return {
      status,
      reason,
      checkedAt: checkedAt(),
      latencyMs: outcome.latencyMs,
      httpStatus: outcome.kind === 'response' ? outcome.status : null,
    };
  }

  private async measureSchedulers(): Promise<SchedulersReport> {
    const now = new Date();
    try {
      const facts = await withTimeout(this.readSchedulerFacts(now), SECTION_QUERY_TIMEOUT_MS);
      // A switched-off job is a configuration, not a fault: only the jobs that
      // run count. One always does (the SEO retention sweep has no switch).
      const running = facts.jobs.filter((job) => job.enabled);
      return {
        status: worstStatus(running.map((job) => job.status)),
        reason: 'OK',
        checkedAt: now.toISOString(),
        jobs: facts.jobs,
        recentFailures: facts.recentFailures,
      };
    } catch (error) {
      this.logger.warn(`system health: scheduler read failed (${error instanceof Error ? error.name : 'UnknownError'})`);
      return { status: 'UNKNOWN', reason: 'QUERY_FAILED', checkedAt: now.toISOString(), jobs: [], recentFailures: [] };
    }
  }

  /**
   * Every read is an index probe on `SchedulerRun(jobKey, startedAt)` scoped
   * to one job, run job by job so the report never holds more than a few
   * connections — the table only grows, and a scan of it is what this must
   * not do.
   */
  private async readSchedulerFacts(now: Date) {
    const day = new Date(now.getTime() - 24 * 60 * 60_000);
    const failureSince = new Date(now.getTime() - RECENT_FAILURE_WINDOW_MS);
    const [flags, enabledChanges] = await Promise.all([
      this.schedulerSettings.readEnabledFlags(),
      this.prisma.operationsSettingsChange.findMany({
        where: { setting: { in: SCHEDULER_JOB_KEYS.map((job) => SCHEDULER_JOB_SETTINGS[job]) }, newValue: 'true' },
        orderBy: { createdAt: 'desc' },
        distinct: ['setting'],
        select: { setting: true, createdAt: true },
      }),
    ]);
    const enabledSinceBySetting = new Map(enabledChanges.map((change) => [change.setting, change.createdAt]));

    const jobs: SchedulerJobReport[] = [];
    const recentFailures: SchedulerFailure[] = [];
    for (const job of RECORDED_JOBS) {
      const scheduled = { jobKey: job, trigger: SchedulerRunTrigger.SCHEDULER };
      const [lastRun, lastSuccess, dayCounts, failures] = await Promise.all([
        this.prisma.schedulerRun.findFirst({
          where: scheduled,
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          select: { status: true, startedAt: true, finishedAt: true, errorCode: true },
        }),
        this.prisma.schedulerRun.findFirst({
          where: { ...scheduled, status: SchedulerRunStatus.SUCCESS },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          select: { startedAt: true },
        }),
        this.prisma.schedulerRun.groupBy({
          by: ['status'],
          where: { ...scheduled, startedAt: { gte: day } },
          _count: { _all: true },
        }),
        this.prisma.schedulerRun.findMany({
          where: { ...scheduled, status: SchedulerRunStatus.FAILED, startedAt: { gte: failureSince } },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          take: Math.max(SCHEDULER_FAILURES_DOWN, RECENT_FAILURE_LIMIT),
          select: { startedAt: true, finishedAt: true, errorCode: true },
        }),
      ]);

      const switchable = (SCHEDULER_JOB_KEYS as readonly string[]).includes(job);
      const enabled = switchable ? flags[job as keyof typeof flags] : true;
      const cron = cronOf(job);
      const failuresSinceLastSuccess = failures.filter(
        (failure) => !lastSuccess || failure.startedAt > lastSuccess.startedAt,
      ).length;
      const enabledSince = switchable
        ? (enabledSinceBySetting.get(SCHEDULER_JOB_SETTINGS[job as keyof typeof SCHEDULER_JOB_SETTINGS]) ?? null)
        : null;
      const evaluation = evaluateSchedulerJob(
        { enabled, cron, lastRun, enabledSince, failuresSinceLastSuccess },
        now,
      );
      const count = (status: SchedulerRunStatus) =>
        dayCounts.find((row) => row.status === status)?._count._all ?? 0;

      jobs.push({
        key: job,
        enabled,
        switchable,
        cron,
        ...evaluation,
        lastRun: lastRun
          ? {
              status: lastRun.status,
              startedAt: lastRun.startedAt.toISOString(),
              finishedAt: lastRun.finishedAt?.toISOString() ?? null,
              errorType: lastRun.status === SchedulerRunStatus.FAILED ? schedulerErrorType(lastRun.errorCode) : null,
            }
          : null,
        lastSuccessAt: lastSuccess?.startedAt.toISOString() ?? null,
        last24h: { succeeded: count(SchedulerRunStatus.SUCCESS), failed: count(SchedulerRunStatus.FAILED) },
      });
      for (const failure of failures) {
        recentFailures.push({
          jobKey: job,
          errorType: schedulerErrorType(failure.errorCode),
          at: (failure.finishedAt ?? failure.startedAt).toISOString(),
        });
      }
    }

    recentFailures.sort((a, b) => b.at.localeCompare(a.at));
    return { jobs, recentFailures: recentFailures.slice(0, RECENT_FAILURE_LIMIT) };
  }

  private async measureEmail(): Promise<EmailReport> {
    const now = new Date();
    const windowHours = EMAIL_WINDOW_MS / (60 * 60_000);
    try {
      const facts = await withTimeout(this.readEmailFacts(now), SECTION_QUERY_TIMEOUT_MS);
      const { status, reason } = evaluateEmail(facts.counts);
      return { status, reason, checkedAt: now.toISOString(), windowHours, ...facts };
    } catch (error) {
      this.logger.warn(`system health: e-mail read failed (${error instanceof Error ? error.name : 'UnknownError'})`);
      return {
        status: 'UNKNOWN',
        reason: 'QUERY_FAILED',
        checkedAt: now.toISOString(),
        windowHours,
        counts: null,
        lastSentAt: null,
        recentFailures: [],
      };
    }
  }

  /**
   * E-mail only, over the window. Counts ride `(channel, createdAt)`; the
   * stuck count and the latest send ride `(status, createdAt)`. The failure
   * list carries the row id (for the notification screen's link), the
   * template and the safe error code — never the recipient.
   */
  private async readEmailFacts(now: Date) {
    const since = new Date(now.getTime() - EMAIL_WINDOW_MS);
    const stuckBefore = new Date(now.getTime() - EMAIL_STUCK_PENDING_MS);
    const failureSince = new Date(now.getTime() - RECENT_FAILURE_WINDOW_MS);
    const email = NotificationChannel.EMAIL;

    const [byStatus, stuckPending, lastSent, failures] = await Promise.all([
      this.prisma.notificationLog.groupBy({
        by: ['status'],
        where: { channel: email, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.notificationLog.count({
        where: {
          channel: email,
          status: NotificationStatus.PENDING,
          OR: [
            { lastAttemptAt: null, createdAt: { lt: stuckBefore } },
            { lastAttemptAt: { lt: stuckBefore } },
          ],
        },
      }),
      this.prisma.notificationLog.findFirst({
        where: { channel: email, status: NotificationStatus.SENT },
        orderBy: { createdAt: 'desc' },
        select: { sentAt: true, createdAt: true },
      }),
      this.prisma.notificationLog.findMany({
        where: { channel: email, status: NotificationStatus.FAILED, createdAt: { gte: failureSince } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_FAILURE_LIMIT,
        select: { id: true, template: true, errorCode: true, failedAt: true, createdAt: true },
      }),
    ]);

    const count = (status: NotificationStatus) => byStatus.find((row) => row.status === status)?._count._all ?? 0;
    return {
      counts: {
        sent: count(NotificationStatus.SENT),
        failed: count(NotificationStatus.FAILED),
        pending: count(NotificationStatus.PENDING),
        stuckPending,
      },
      lastSentAt: lastSent ? (lastSent.sentAt ?? lastSent.createdAt).toISOString() : null,
      recentFailures: failures.map((failure): EmailFailure => {
        const errorCode = normalizeStoredErrorCode(failure.errorCode);
        return {
          id: failure.id,
          template: failure.template,
          errorCode,
          errorLabel: errorCode ? notificationErrorLabel(errorCode) : null,
          at: (failure.failedAt ?? failure.createdAt).toISOString(),
        };
      }),
    };
  }
}
