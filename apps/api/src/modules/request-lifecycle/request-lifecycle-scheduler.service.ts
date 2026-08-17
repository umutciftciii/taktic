import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RequestExpiryService } from './request-expiry.service';
import {
  isRequestExpirySchedulerEnabled,
  isRequestReminderSchedulerEnabled,
  readRequestExpiryCron,
  readRequestLifecycleScanLimit,
  readRequestReminderCron,
} from './request-lifecycle.constants';
import { RequestReminderService } from './request-reminder.service';

// Read at import time, because @Cron needs the expression before an instance
// exists. That is also what turns a malformed REQUEST_*_SCHEDULER_CRON into a
// boot failure rather than a job quietly running on a schedule nobody chose.
const expiryCron = readRequestExpiryCron();
const reminderCron = readRequestReminderCron();

/**
 * Wakes the two approved-request jobs.
 *
 * Same shape as the refund scheduler: an env flag per job, a validated cron
 * expression, an in-process reentrancy guard, and log lines that carry counts
 * and ids only. Both jobs are disabled unless the deployment enables them, so
 * importing this module changes nothing on its own — CI and the test suite
 * never trigger either one.
 *
 * The guards are per-process. Two API instances with the scheduler enabled
 * would both wake up, which is safe by construction: each job's writes are
 * conditional updates, so a second runner finds nothing left to do.
 */
@Injectable()
export class RequestLifecycleSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(RequestLifecycleSchedulerService.name);
  private isExpiryRunning = false;
  private isReminderRunning = false;

  constructor(
    @Inject(RequestExpiryService) private readonly expiry: RequestExpiryService,
    @Inject(RequestReminderService) private readonly reminder: RequestReminderService,
  ) {}

  onModuleInit() {
    // Reading the limit here surfaces an out-of-range value at boot even when
    // both jobs are disabled.
    const limit = readRequestLifecycleScanLimit();

    this.logger.log(
      isRequestExpirySchedulerEnabled()
        ? `Request expiry scheduler enabled with cron "${expiryCron}" limit=${limit}`
        : 'Request expiry scheduler disabled',
    );
    this.logger.log(
      isRequestReminderSchedulerEnabled()
        ? `Request reminder scheduler enabled with cron "${reminderCron}" limit=${limit}`
        : 'Request reminder scheduler disabled',
    );
  }

  @Cron(expiryCron, { name: 'request-expiry-scheduler' })
  async runScheduledExpiry() {
    if (!isRequestExpirySchedulerEnabled()) {
      return;
    }

    if (this.isExpiryRunning) {
      this.logger.warn('Request expiry skipped because a previous run is still active');
      return;
    }

    this.isExpiryRunning = true;

    try {
      const limit = readRequestLifecycleScanLimit();
      const result = await this.expiry.execute({ limit });
      this.logger.log(
        `Request expiry summary processed=${result.processed} expired=${result.expired} skipped=${result.skipped} failed=${result.failed}`,
      );
    } catch (error) {
      this.logger.error(
        'Request expiry run failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isExpiryRunning = false;
    }
  }

  @Cron(reminderCron, { name: 'request-reminder-scheduler' })
  async runScheduledReminder() {
    if (!isRequestReminderSchedulerEnabled()) {
      return;
    }

    if (this.isReminderRunning) {
      this.logger.warn('Request reminder skipped because a previous run is still active');
      return;
    }

    this.isReminderRunning = true;

    try {
      const limit = readRequestLifecycleScanLimit();
      const result = await this.reminder.execute({ limit });
      this.logger.log(
        `Request reminder summary processed=${result.processed} reminded=${result.reminded} skipped=${result.skipped} failedToSend=${result.failedToSend}`,
      );
    } catch (error) {
      this.logger.error(
        'Request reminder run failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isReminderRunning = false;
    }
  }
}
