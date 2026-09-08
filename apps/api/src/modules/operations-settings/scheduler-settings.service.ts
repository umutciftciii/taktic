import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readSchedulerCron } from '../../common/scheduler-cron';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS } from '../offers/refund-policy';
import { OPERATIONS_SETTINGS_ID } from './operations-settings.service';
import {
  SCHEDULER_JOB_KEYS,
  SCHEDULER_JOB_MOVES_MONEY,
  SCHEDULER_JOB_SETTINGS,
  SchedulerJobKey,
  SchedulerJobSetting,
} from './scheduler-jobs';
import { SchedulerRunRecord, SchedulerRunRegistry } from './scheduler-run-registry.service';

/**
 * Whether each background job may act, as one persistent answer.
 *
 * This is the whole of the decision. There is no environment flag beside it and
 * no second switch a deployment can disagree with: the four schedulers ask this
 * service on every tick and do nothing at all unless the answer is a stored
 * `true`.
 *
 * **Fail-closed, three ways.** No settings row means off, because a fresh
 * deployment must not start expiring requests before an operator has opened the
 * screen. A `false` column means off. And a read that *fails* means off too —
 * see {@link SchedulerSettingsService.isJobEnabled}: a database the job cannot
 * reach is not a licence to move money on a guess.
 *
 * **Read every tick, never cached.** A toggle takes effect on the job's next
 * natural tick without a restart, and no process can hold an "on" the panel
 * disagrees with. The cost is one primary-key read per tick per job, which
 * against an hourly cron is nothing.
 *
 * There is deliberately no "run now". Every one of these jobs moves credits,
 * closes a request or mails a person, and the only thing that triggers that is
 * the schedule the deployment chose.
 */
export type SchedulerJobView = {
  key: SchedulerJobKey;
  enabled: boolean;
  /** The deployment's schedule for this job. Read-only, and not editable here. */
  cron: string;
  /** Whether switching this on starts a job that moves money or credits. */
  movesMoney: boolean;
  /** What this instance last saw the job do. Null until it has run here. */
  lastRun: SchedulerRunRecord | null;
};

export type SchedulerSettingsView = {
  jobs: SchedulerJobView[];
  /** The toggle history, newest first — only these four settings. */
  recentChanges: SchedulerSettingsChangeView[];
};

export type SchedulerSettingsChangeView = {
  id: string;
  setting: string;
  /** Null on the first change, when the effective value was the shipped default. */
  previousValue: string | null;
  newValue: string;
  createdAt: Date;
  changedBy: { id: string; name: string | null } | null;
};

const RECENT_CHANGE_LIMIT = 20;

const SETTING_NAMES = SCHEDULER_JOB_KEYS.map((job) => SCHEDULER_JOB_SETTINGS[job]);

/**
 * All four flags, always, however few the caller needs.
 *
 * A per-job `select` built from a computed key would be one string away from
 * reading a column that is not a scheduler flag at all, and it types as
 * `Record<string, unknown>`. Four booleans on a primary-key lookup cost
 * nothing, and the result is a shape the compiler can index by job key.
 */
const flagsSelect = {
  entitlementRenewalSchedulerEnabled: true,
  unviewedOfferRefundSchedulerEnabled: true,
  requestExpirySchedulerEnabled: true,
  requestReminderSchedulerEnabled: true,
} satisfies Prisma.OperationsSettingsSelect;

/**
 * The write half, spelled out per job.
 *
 * The read half can be an index — the row has every flag on it — but a write
 * cannot: an update built from a computed key does not typecheck against the
 * generated input, and the cast that would make it compile is exactly what
 * would let a rename here quietly start writing the wrong column.
 */
type FlagPatch = Partial<Record<SchedulerJobSetting, boolean>>;

const FLAG_PATCHES: Record<SchedulerJobKey, (enabled: boolean) => FlagPatch> = {
  'entitlement-renewal': (enabled) => ({ entitlementRenewalSchedulerEnabled: enabled }),
  'unviewed-offer-refund': (enabled) => ({ unviewedOfferRefundSchedulerEnabled: enabled }),
  'request-expiry': (enabled) => ({ requestExpirySchedulerEnabled: enabled }),
  'request-reminder': (enabled) => ({ requestReminderSchedulerEnabled: enabled }),
};

@Injectable()
export class SchedulerSettingsService {
  private readonly logger = new Logger(SchedulerSettingsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SchedulerRunRegistry) private readonly runs: SchedulerRunRegistry,
  ) {}

  /**
   * The question every tick asks.
   *
   * Never throws. A scheduler that could not read its own switch must skip the
   * pass — not crash the process, and not guess — so the failure is logged by
   * job name and error class and answered `false`. That log line is what makes
   * a database outage visible as "the jobs are not running" rather than as
   * silence.
   */
  async isJobEnabled(job: SchedulerJobKey): Promise<boolean> {
    try {
      const row = await this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: flagsSelect,
      });

      // No row is a real answer, not a gap: it is a deployment whose operator
      // has not switched anything on yet.
      return row ? row[SCHEDULER_JOB_SETTINGS[job]] : false;
    } catch (error) {
      // The error class only. A connection failure can carry the database URL,
      // and this line goes to the log an operator reads over somebody's
      // shoulder.
      this.logger.error(
        `Scheduler setting for "${job}" could not be read; treating the job as disabled ` +
          `(${error instanceof Error ? error.name : 'UnknownError'})`,
      );
      return false;
    }
  }

  async listForAdmin(): Promise<SchedulerSettingsView> {
    const [row, changes] = await Promise.all([
      this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: flagsSelect,
      }),
      this.prisma.operationsSettingsChange.findMany({
        where: { setting: { in: SETTING_NAMES } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_CHANGE_LIMIT,
        select: {
          id: true,
          setting: true,
          previousValue: true,
          newValue: true,
          createdAt: true,
          changedBy: { select: { id: true, name: true } },
        },
      }),
    ]);

    return {
      jobs: SCHEDULER_JOB_KEYS.map((job) => ({
        key: job,
        enabled: row ? row[SCHEDULER_JOB_SETTINGS[job]] : false,
        // The expression, and only the expression. No other environment value
        // reaches this response.
        cron: readSchedulerCron(job),
        movesMoney: SCHEDULER_JOB_MOVES_MONEY[job],
        lastRun: this.runs.get(job),
      })),
      recentChanges: changes,
    };
  }

  /**
   * Switches one job, and records who did it.
   *
   * The setting and its audit row commit together, so a background job that
   * moves money cannot be switched on with nobody's name against it.
   *
   * **A write that changes nothing writes nothing.** Re-submitting the state a
   * job is already in returns before the upsert — including switching off a job
   * that has no settings row yet, which is already off. The trail answers "who
   * turned the refund worker on, and when", and a re-posted form that recorded
   * the current state again would fill it with decisions nobody made.
   *
   * Serializable, for the reason the refund window is: the trail is a chain,
   * and two operators toggling at the same moment under a weaker level could
   * both record themselves as having changed it from the same predecessor.
   *
   * `changedById` is the authenticated operator, passed by the controller and
   * never read from the payload.
   */
  async setEnabled(
    job: SchedulerJobKey,
    enabled: boolean,
    changedById: string,
  ): Promise<SchedulerSettingsView> {
    await runSerializable(
      this.prisma,
      async (tx) => {
        const current = await tx.operationsSettings.findUnique({
          where: { id: OPERATIONS_SETTINGS_ID },
          select: flagsSelect,
        });

        const stored = current ? current[SCHEDULER_JOB_SETTINGS[job]] : null;
        // The comparison is against the *effective* answer, not the stored one:
        // with no row at all the job is already off, so switching it off is not
        // a decision and must not create a row or an audit entry.
        if ((stored ?? false) === enabled) {
          return;
        }

        await tx.operationsSettings.upsert({
          where: { id: OPERATIONS_SETTINGS_ID },
          create: {
            id: OPERATIONS_SETTINGS_ID,
            // The row carries the refund window too, and that column is NOT
            // NULL. Creating it here writes the shipped default — which is the
            // value that was already in force, since the absence of a row means
            // exactly that. Switching a scheduler on therefore changes the
            // scheduler and nothing else, and the refund-window panel still
            // reports the window as unconfigured, because it is.
            unviewedOfferRefundWindowHours: DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
            updatedById: changedById,
            ...FLAG_PATCHES[job](enabled),
          },
          update: { updatedById: changedById, ...FLAG_PATCHES[job](enabled) },
        });

        await tx.operationsSettingsChange.create({
          data: {
            setting: SCHEDULER_JOB_SETTINGS[job],
            // NULL exactly once per job: the change that first created the row,
            // when the effective value was the shipped default (off) rather
            // than something an operator had chosen.
            previousValue: stored === null ? null : String(stored),
            newValue: String(enabled),
            changedById,
          },
        });
      },
      { label: 'schedulerSettings.setEnabled' },
    );

    return this.listForAdmin();
  }
}
