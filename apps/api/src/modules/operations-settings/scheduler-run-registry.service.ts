import { Injectable } from '@nestjs/common';
import { SchedulerJobKey } from './scheduler-jobs';

/**
 * What this process last saw each job do.
 *
 * Deliberately in memory, and deliberately not a table. A run record is
 * operator comfort — "did the refund pass actually happen at midnight?" — and
 * the price of answering it in the database is a write on every tick of every
 * job, forever, including the overwhelming majority of ticks that examined
 * nothing. That is exactly the audit noise the settings trail is kept clean of:
 * OperationsSettingsChange records decisions a person made, and a cron waking
 * up is not one.
 *
 * The honest consequence is that this is per-process and does not survive a
 * restart, and the panel says so in as many words rather than presenting it as
 * the platform's memory. With more than one API instance each holds its own
 * view, which is the truth: they are separate runners.
 *
 * Nothing identifying is stored. `summary` is the counts line the job already
 * logs — processed/expired/refunded and so on — never an id, an address or an
 * error message from a provider.
 */
export type SchedulerRunOutcome = 'SUCCESS' | 'FAILED' | 'SKIPPED';

export type SchedulerRunRecord = {
  startedAt: Date;
  finishedAt: Date;
  outcome: SchedulerRunOutcome;
  /** Counts only. Null when the run produced no summary worth showing. */
  summary: string | null;
};

@Injectable()
export class SchedulerRunRegistry {
  private readonly runs = new Map<SchedulerJobKey, SchedulerRunRecord>();

  record(job: SchedulerJobKey, run: SchedulerRunRecord): void {
    this.runs.set(job, run);
  }

  get(job: SchedulerJobKey): SchedulerRunRecord | null {
    return this.runs.get(job) ?? null;
  }
}
