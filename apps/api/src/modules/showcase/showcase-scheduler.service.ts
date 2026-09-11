import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { readSchedulerCron } from '../../common/scheduler-cron';
import { SchedulerRunRegistry } from '../operations-settings/scheduler-run-registry.service';
import { SchedulerSettingsService } from '../operations-settings/scheduler-settings.service';
import { readShowcaseScanLimit } from './showcase.constants';
import { ShowcaseLeadSlaService } from './showcase-lead-sla.service';
import { ShowcasePlacementExpiryService } from './showcase-placement-expiry.service';

// Read at import time, because @Cron needs the expression before an instance
// exists. That is also what turns a malformed SHOWCASE_*_CRON into a boot
// failure rather than a job quietly running on a schedule nobody chose.
const slaCron = readSchedulerCron('showcase-lead-sla');
const expiryCron = readSchedulerCron('showcase-placement-expiry');

/**
 * Wakes the two vitrin jobs.
 *
 * The same shape as the other schedulers, deliberately and without variation: a
 * static cron expression the deployment owns, a persistent operations setting
 * the super admin owns, an in-process reentrancy guard, and log lines carrying
 * counts and ids only.
 *
 * Whether either job acts is re-read from the settings row on every tick, so a
 * switch flipped in the admin panel takes effect on the next natural tick with
 * no restart — and a database the job cannot reach reads as "off".
 *
 * The guards are per-process. Two API instances with a job enabled both wake
 * up, which is safe by construction: every write either job makes is a
 * conditional UPDATE, so the second runner finds nothing left to do.
 */
@Injectable()
export class ShowcaseSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(ShowcaseSchedulerService.name);
  private isSlaRunning = false;
  private isExpiryRunning = false;

  constructor(
    @Inject(ShowcaseLeadSlaService) private readonly sla: ShowcaseLeadSlaService,
    @Inject(ShowcasePlacementExpiryService)
    private readonly expiry: ShowcasePlacementExpiryService,
    @Inject(SchedulerSettingsService) private readonly settings: SchedulerSettingsService,
    @Inject(SchedulerRunRegistry) private readonly runs: SchedulerRunRegistry,
  ) {}

  onModuleInit() {
    // Reading the limit here surfaces an out-of-range value at boot even when
    // both jobs are switched off.
    const limit = readShowcaseScanLimit();

    // Not "enabled" or "disabled": whether either job acts is a database answer
    // that can change between now and the next tick, and a boot line claiming
    // otherwise would be stale the first time somebody used the panel.
    this.logger.log(
      `Vitrin lead SLA registered with cron "${slaCron}" limit=${limit}; ` +
        'runs only while the operations setting says so',
    );
    this.logger.log(
      `Vitrin placement expiry registered with cron "${expiryCron}" limit=${limit}; ` +
        'runs only while the operations setting says so',
    );
  }

  @Cron(slaCron, { name: 'showcase-lead-sla-scheduler' })
  async runScheduledSla() {
    if (!(await this.settings.isJobEnabled('showcase-lead-sla'))) {
      return;
    }

    if (this.isSlaRunning) {
      this.logger.warn('Vitrin lead SLA skipped because a previous run is still active');
      return;
    }

    this.isSlaRunning = true;
    const startedAt = new Date();

    try {
      const result = await this.sla.execute({ limit: readShowcaseScanLimit() });
      const summary =
        `breached=${result.breached} skipped=${result.skipped} ` +
        `timedOut=${result.timedOut} notified=${result.notified} failed=${result.failed}`;
      this.logger.log(`Vitrin lead SLA summary ${summary}`);
      this.runs.record('showcase-lead-sla', {
        startedAt,
        finishedAt: new Date(),
        outcome: 'SUCCESS',
        summary,
      });
    } catch (error) {
      this.logger.error(
        'Vitrin lead SLA run failed',
        error instanceof Error ? error.stack : String(error),
      );
      // The class only. The panel shows this to an operator, and a driver's
      // error text can carry a connection string.
      this.runs.record('showcase-lead-sla', {
        startedAt,
        finishedAt: new Date(),
        outcome: 'FAILED',
        summary: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      this.isSlaRunning = false;
    }
  }

  @Cron(expiryCron, { name: 'showcase-placement-expiry-scheduler' })
  async runScheduledExpiry() {
    if (!(await this.settings.isJobEnabled('showcase-placement-expiry'))) {
      return;
    }

    if (this.isExpiryRunning) {
      this.logger.warn('Vitrin placement expiry skipped because a previous run is still active');
      return;
    }

    this.isExpiryRunning = true;
    const startedAt = new Date();

    try {
      const result = await this.expiry.execute({ limit: readShowcaseScanLimit() });
      const summary =
        `expired=${result.expired} skipped=${result.skipped} ` +
        `shelvesClosed=${result.shelvesClosed} entitlementsExpired=${result.entitlementsExpired} ` +
        `reminders7d=${result.remindersEnqueued.first} reminders3d=${result.remindersEnqueued.second} ` +
        `noticesSent=${result.notices.sent} noticesFailed=${result.notices.failed}`;
      this.logger.log(`Vitrin placement expiry summary ${summary}`);
      this.runs.record('showcase-placement-expiry', {
        startedAt,
        finishedAt: new Date(),
        outcome: 'SUCCESS',
        summary,
      });
    } catch (error) {
      this.logger.error(
        'Vitrin placement expiry run failed',
        error instanceof Error ? error.stack : String(error),
      );
      this.runs.record('showcase-placement-expiry', {
        startedAt,
        finishedAt: new Date(),
        outcome: 'FAILED',
        summary: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      this.isExpiryRunning = false;
    }
  }
}
