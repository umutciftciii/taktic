import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { readSeoNotFoundRetentionCron } from '../../../common/scheduler-cron';
import { SchedulerRunRegistry } from '../../operations-settings/scheduler-run-registry.service';
import { SeoNotFoundRecorder } from '../seo-not-found.recorder';

/**
 * SEO-004 — the 404 suggestions' retention: OPEN rows unseen for 90 days and
 * REJECTED rows 180 days after the decision are deleted. APPROVED rows stay:
 * they are the history of a redirect.
 *
 * Always on (housekeeping has no switch), and recorded like every other job
 * in `SchedulerRun`, with its lease: the operations screen's "last run"
 * machinery and the stale-run recovery cover it.
 */
@Injectable()
export class SeoRetentionScheduler {
  private readonly logger = new Logger(SeoRetentionScheduler.name);

  constructor(
    @Inject(SeoNotFoundRecorder) private readonly recorder: SeoNotFoundRecorder,
    @Inject(SchedulerRunRegistry) private readonly runs: SchedulerRunRegistry,
  ) {}

  @Cron(readSeoNotFoundRetentionCron(), { name: 'seo-not-found-retention' })
  async tick() {
    await this.run();
  }

  async run(now: Date = new Date()) {
    const run = await this.runs.start('seo-not-found-retention');
    try {
      const removed = await this.recorder.applyRetention(now);
      await run.succeed(`open=${removed.open} rejected=${removed.rejected}`);
      return removed;
    } catch (error) {
      this.logger.error(`404 suggestion retention failed (${error instanceof Error ? error.name : 'UnknownError'})`);
      await run.fail(error);
      throw error;
    }
  }
}
