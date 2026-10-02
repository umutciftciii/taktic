import { Inject, Injectable, Logger } from '@nestjs/common';
import { SchedulerRunStatus, SchedulerRunTrigger } from '@prisma/client';
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
  /** The error's class name on a FAILED run. */
  errorCode: string | null;
};

/** What a job holds between starting and finishing one run. */
export type SchedulerRunHandle = {
  succeed(summary: string | null): Promise<void>;
  fail(error: unknown): Promise<void>;
};

const runSelect = {
  id: true,
  status: true,
  trigger: true,
  startedAt: true,
  finishedAt: true,
  summary: true,
  errorCode: true,
} as const;

const SUMMARY_MAX = 1000;
const ERROR_CODE_MAX = 120;

/** The error's class name and nothing else — never its message or stack. */
export function schedulerErrorCode(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : 'UnknownError';
  return name.slice(0, ERROR_CODE_MAX);
}

@Injectable()
export class SchedulerRunRegistry {
  private readonly logger = new Logger(SchedulerRunRegistry.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Opens a RUNNING row for one execution and hands back the means to close it.
   *
   * Recording never decides whether the job runs. If the opening insert fails
   * (the database is unreachable — in which case the job will most likely fail
   * too), the failure is logged by class and the handle writes the whole run,
   * start and end, as one row when it finishes; if that also fails, it is
   * logged and the job's own outcome stands.
   */
  async start(
    job: SchedulerJobKey,
    trigger: SchedulerRunTrigger = SchedulerRunTrigger.SCHEDULER,
  ): Promise<SchedulerRunHandle> {
    const startedAt = new Date();
    let runId: string | null = null;
    try {
      const row = await this.prisma.schedulerRun.create({
        data: { jobKey: job, trigger, status: SchedulerRunStatus.RUNNING, startedAt },
        select: { id: true },
      });
      runId = row.id;
    } catch (error) {
      this.logger.error(`Scheduler run for "${job}" could not be opened (${schedulerErrorCode(error)})`);
    }

    const finish = async (status: SchedulerRunStatus, summary: string | null, errorCode: string | null) => {
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
          await this.prisma.schedulerRun.updateMany({
            where: { id: runId, status: SchedulerRunStatus.RUNNING },
            data: end,
          });
        } else {
          await this.prisma.schedulerRun.create({ data: { jobKey: job, trigger, startedAt, ...end } });
        }
      } catch (error) {
        this.logger.error(`Scheduler run for "${job}" could not be closed (${schedulerErrorCode(error)})`);
      }
    };

    return {
      succeed: (summary) => finish(SchedulerRunStatus.SUCCESS, summary, null),
      fail: (error) => finish(SchedulerRunStatus.FAILED, null, schedulerErrorCode(error)),
    };
  }

  /**
   * The most recent run of each job, by start time, whichever process wrote it.
   * A job that has no row has never run since runs were recorded, and is
   * answered `null` — not a guessed date.
   */
  async lastRuns(): Promise<Record<SchedulerJobKey, SchedulerRunView | null>> {
    const rows = await Promise.all(
      SCHEDULER_JOB_KEYS.map((job) =>
        this.prisma.schedulerRun.findFirst({
          where: { jobKey: job },
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
}
