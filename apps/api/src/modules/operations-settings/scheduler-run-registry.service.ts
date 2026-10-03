import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, SchedulerRunStatus, SchedulerRunTrigger } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SCHEDULER_JOB_KEYS, SchedulerJobKey } from './scheduler-jobs';

/**
 * Every execution of every background job, kept in the database
 * (OPS-SCHEDULER-RUN-PERSISTENCE-001).
 *
 * This used to be a Map in one process's memory — operator comfort that a
 * restart erased and that each API instance held separately. It is now the
 * `SchedulerRun` table: a row when a switched-on job starts work, closed once
 * when the work ends, never overwritten and never deleted (a trigger in the
 * migration enforces both). So the operations screen's "last run" survives a
 * restart, and a FAILED run stays on record after the next one succeeds.
 *
 * The cost the old note warned about does not apply: a tick of a switched-off
 * job returns before it gets here, so rows are written only by runs that did
 * something — at most one pair of statements per real run.
 *
 * Nothing identifying is stored. `summary` is the counts line the job already
 * logs — processed/expired/refunded and so on — never an id, an address or an
 * error message; a failure records the error's class name only, because a
 * driver's error text can carry a connection string.
 *
 * ADMIN-BACKEND-TRUTH-002 — the lease. A process that dies mid-run cannot
 * close its row, and a RUNNING row must not read "running" forever. Process
 * memory cannot tell a dead run from a live one on another API instance, so
 * the database holds a lease instead: the process running a job renews
 * `heartbeatAt` every {@link SCHEDULER_RUN_HEARTBEAT_MS} (database clock) for
 * as long as the run is open. A RUNNING row whose lease — its last heartbeat,
 * or its start for a row from before heartbeats — is older than
 * {@link SCHEDULER_RUN_LEASE_MS} belongs to a process that stopped, and
 * {@link SchedulerRunRegistry.recoverStale} closes it FAILED with
 * `errorCode = PROCESS_INTERRUPTED` and `finishedAt` = the moment it was
 * declared over. A live run on any instance keeps renewing its lease and is
 * never closed under it, however long it runs; that is why the threshold is a
 * liveness lease and not a multiple of the job's cron cadence — a long run is
 * not a dead run. Recovery runs before every new run of the same job, at
 * boot, and on a five-minute sweep, so a switched-off job's orphan closes too.
 * The UPDATE is conditional on RUNNING and on the lease, so instances
 * sweeping at once close each row once.
 */
export type SchedulerRunView = {
  id: string;
  status: SchedulerRunStatus;
  trigger: SchedulerRunTrigger;
  startedAt: Date;
  /** Null while RUNNING — or forever, for a run whose process died mid-way. */
  finishedAt: Date | null;
  /** Counts only. Null when the run produced no summary worth showing. */
  summary: string | null;
  /** The error's class name on a FAILED run; `PROCESS_INTERRUPTED` for a recovered one. */
  errorCode: string | null;
  /** The run's last sign of life; null on rows from before heartbeats. */
  heartbeatAt: Date | null;
  /** Who ran a MANUAL run; null on a SCHEDULER run. */
  actor: { id: string; name: string | null } | null;
};

/** What a job holds between starting and finishing one run. */
export type SchedulerRunHandle = {
  /** The row's id; null when the opening insert failed. */
  readonly id: string | null;
  succeed(summary: string | null): Promise<void>;
  fail(error: unknown): Promise<void>;
  /** Renews the lease now. The handle's timer calls it; exposed for tests. */
  heartbeat(): Promise<void>;
};

const runSelect = {
  id: true,
  status: true,
  trigger: true,
  startedAt: true,
  finishedAt: true,
  summary: true,
  errorCode: true,
  heartbeatAt: true,
  actor: { select: { id: true, name: true } },
} as const;

/** How often an open run renews its lease. */
export const SCHEDULER_RUN_HEARTBEAT_MS = 60_000;
/**
 * How long a lease lasts without renewal: five missed heartbeats. A run whose
 * process is alive renews long before this; one whose lease is this old is not
 * running anywhere.
 */
export const SCHEDULER_RUN_LEASE_MS = 5 * 60_000;
/** The machine-readable reason a recovered run carries in `errorCode`. */
export const PROCESS_INTERRUPTED = 'PROCESS_INTERRUPTED';

const SUMMARY_MAX = 1000;
const ERROR_CODE_MAX = 120;

/** The error's class name and nothing else — never its message or stack. */
export function schedulerErrorCode(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : 'UnknownError';
  return name.slice(0, ERROR_CODE_MAX);
}

@Injectable()
export class SchedulerRunRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerRunRegistry.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** A process that starts closes what a stopped one left open. */
  async onApplicationBootstrap() {
    await this.recoverStaleSafely(null);
  }

  /** The sweep, so an orphan of a job nobody runs again is closed too. */
  @Cron('*/5 * * * *', { name: 'scheduler-run-recovery' })
  async sweepStaleRuns() {
    await this.recoverStaleSafely(null);
  }

  /**
   * Opens a RUNNING row for one execution and hands back the means to close it.
   *
   * Recording never decides whether the job runs. If the opening insert fails
   * (the database is unreachable — in which case the job will most likely fail
   * too), the failure is logged by class and the handle writes the whole run,
   * start and end, as one row when it finishes; if that also fails, it is
   * logged and the job's own outcome stands.
   *
   * A MANUAL run names its operator (`actorId`); a SCHEDULER run has none. A
   * CHECK holds the pair together.
   */
  async start(
    job: SchedulerJobKey,
    trigger: SchedulerRunTrigger = SchedulerRunTrigger.SCHEDULER,
    options: { actorId?: string | null } = {},
  ): Promise<SchedulerRunHandle> {
    await this.recoverStaleSafely(job);

    const actorId = trigger === SchedulerRunTrigger.MANUAL ? (options.actorId ?? null) : null;
    const startedAt = new Date();
    let runId: string | null = null;
    try {
      const row = await this.prisma.schedulerRun.create({
        data: { jobKey: job, trigger, status: SchedulerRunStatus.RUNNING, startedAt, heartbeatAt: startedAt, actorId },
        select: { id: true },
      });
      runId = row.id;
    } catch (error) {
      this.logger.error(`Scheduler run for "${job}" could not be opened (${schedulerErrorCode(error)})`);
    }

    const heartbeat = async () => {
      if (!runId) return;
      try {
        // The database's clock, as the recovery's; GREATEST keeps the lease
        // moving forward only (the guard refuses anything else).
        await this.prisma.$executeRaw`
          UPDATE "SchedulerRun"
          SET "heartbeatAt" = GREATEST(now() AT TIME ZONE 'UTC', "heartbeatAt")
          WHERE "id" = ${runId} AND "status" = 'RUNNING'`;
      } catch (error) {
        this.logger.warn(`Scheduler run for "${job}" could not renew its lease (${schedulerErrorCode(error)})`);
      }
    };
    const timer = runId ? setInterval(() => void heartbeat(), SCHEDULER_RUN_HEARTBEAT_MS) : null;
    timer?.unref();

    const finish = async (status: SchedulerRunStatus, summary: string | null, errorCode: string | null) => {
      if (timer) clearInterval(timer);
      const finishedAt = new Date();
      const end = {
        status,
        finishedAt,
        summary: summary === null ? null : summary.slice(0, SUMMARY_MAX),
        errorCode,
      };
      try {
        if (runId) {
          // Conditional on RUNNING, so a handle can never reopen or rewrite a
          // closed run; the trigger refuses it regardless.
          const closed = await this.prisma.schedulerRun.updateMany({
            where: { id: runId, status: SchedulerRunStatus.RUNNING },
            data: end,
          });
          if (closed.count === 0) {
            // Its lease ran out (heartbeats failed for longer than the lease)
            // and a recovery closed it as interrupted. That record stands —
            // history is not rewritten — and the real outcome goes to the log.
            this.logger.warn(
              `Scheduler run for "${job}" was already closed as ${PROCESS_INTERRUPTED}; ` +
                `its own end was ${status}${summary ? ` (${summary.slice(0, SUMMARY_MAX)})` : ''}`,
            );
          }
        } else {
          await this.prisma.schedulerRun.create({ data: { jobKey: job, trigger, startedAt, actorId, ...end } });
        }
      } catch (error) {
        this.logger.error(`Scheduler run for "${job}" could not be closed (${schedulerErrorCode(error)})`);
      }
    };

    return {
      id: runId,
      succeed: (summary) => finish(SchedulerRunStatus.SUCCESS, summary, null),
      fail: (error) => finish(SchedulerRunStatus.FAILED, null, schedulerErrorCode(error)),
      heartbeat,
    };
  }

  /**
   * Closes every RUNNING run — of `job`, or of every job — whose lease ran
   * out, as FAILED with {@link PROCESS_INTERRUPTED}. Returns how many it
   * closed. Database clock throughout, so instances with drifting clocks agree.
   */
  async recoverStale(job: SchedulerJobKey | null = null): Promise<number> {
    const leaseMs = SCHEDULER_RUN_LEASE_MS;
    const jobFilter = job === null ? Prisma.empty : Prisma.sql`AND "jobKey" = ${job}`;
    return this.prisma.$executeRaw`
      UPDATE "SchedulerRun"
      SET "status" = 'FAILED',
          "finishedAt" = GREATEST(now() AT TIME ZONE 'UTC', "startedAt"),
          "errorCode" = ${PROCESS_INTERRUPTED}
      WHERE "status" = 'RUNNING'
        AND COALESCE("heartbeatAt", "startedAt") < (now() AT TIME ZONE 'UTC') - (${leaseMs}::int * INTERVAL '1 millisecond')
        ${jobFilter}`;
  }

  private async recoverStaleSafely(job: SchedulerJobKey | null) {
    try {
      const closed = await this.recoverStale(job);
      if (closed > 0) {
        this.logger.warn(`Closed ${closed} scheduler run(s) whose lease ran out as ${PROCESS_INTERRUPTED}`);
      }
    } catch (error) {
      this.logger.error(`Stale scheduler run recovery failed (${schedulerErrorCode(error)})`);
    }
  }

  /**
   * The most recent scheduled run of each job, by start time, whichever
   * process wrote it. A job that has no row has never run since runs were
   * recorded, and is answered `null` — not a guessed date. A hand-run is not
   * the scheduler running, so it is read separately ({@link lastManualRun}).
   */
  async lastRuns(): Promise<Record<SchedulerJobKey, SchedulerRunView | null>> {
    const rows = await Promise.all(
      SCHEDULER_JOB_KEYS.map((job) =>
        this.prisma.schedulerRun.findFirst({
          where: { jobKey: job, trigger: SchedulerRunTrigger.SCHEDULER },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          select: runSelect,
        }),
      ),
    );
    return Object.fromEntries(SCHEDULER_JOB_KEYS.map((job, index) => [job, rows[index] ?? null])) as Record<
      SchedulerJobKey,
      SchedulerRunView | null
    >;
  }

  /**
   * The most recent MANUAL run of one job, with its operator. Only the refund
   * scan has a hand-run today, so this is asked per job rather than for all.
   */
  async lastManualRun(job: SchedulerJobKey): Promise<SchedulerRunView | null> {
    return this.prisma.schedulerRun.findFirst({
      where: { jobKey: job, trigger: SchedulerRunTrigger.MANUAL },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: runSelect,
    });
  }
}
