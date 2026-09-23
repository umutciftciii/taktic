import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { warnIfLegacySchedulerFlagSet } from '../../common/legacy-scheduler-flags';
import { readSchedulerCron } from '../../common/scheduler-cron';
import { RequestPublishOutbox } from '../notifications/request-publish-outbox.service';
import { PackageRefundNotificationOutbox } from '../notifications/package-refund-notification-outbox.service';
import { ReviewInvitationOutbox } from '../notifications/review-invitation-outbox.service';
import { SchedulerRunRegistry } from '../operations-settings/scheduler-run-registry.service';
import { SchedulerSettingsService } from '../operations-settings/scheduler-settings.service';
import { RequestExpiryService } from './request-expiry.service';
import { readRequestLifecycleScanLimit } from './request-lifecycle.constants';
import { RequestReminderService } from './request-reminder.service';

// Read at import time, because @Cron needs the expression before an instance
// exists. That is also what turns a malformed REQUEST_*_SCHEDULER_CRON into a
// boot failure rather than a job quietly running on a schedule nobody chose.
const expiryCron = readSchedulerCron('request-expiry');
const reminderCron = readSchedulerCron('request-reminder');

/**
 * Wakes the two approved-request jobs.
 *
 * Same shape as the other two schedulers: a static cron expression the
 * deployment owns, a persistent operations setting the super admin owns, an
 * in-process reentrancy guard, and log lines that carry counts and ids only.
 *
 * The tick always happens; whether it *does* anything is re-read from the
 * settings row every time. So a switch flipped in the admin panel takes effect
 * on the next natural tick with no restart, and a database the job cannot reach
 * reads as "off" — see SchedulerSettingsService.
 *
 * The guards are per-process. Two API instances with the job enabled would both
 * wake up, which is safe by construction: each job's writes are conditional
 * updates, so a second runner finds nothing left to do.
 */
@Injectable()
export class RequestLifecycleSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(RequestLifecycleSchedulerService.name);
  private isExpiryRunning = false;
  private isReminderRunning = false;

  constructor(
    @Inject(RequestExpiryService) private readonly expiry: RequestExpiryService,
    @Inject(RequestReminderService) private readonly reminder: RequestReminderService,
    @Inject(SchedulerSettingsService) private readonly settings: SchedulerSettingsService,
    @Inject(SchedulerRunRegistry) private readonly runs: SchedulerRunRegistry,
    @Inject(RequestPublishOutbox) private readonly publishOutbox: RequestPublishOutbox,
    @Inject(ReviewInvitationOutbox)
    private readonly reviewInvitationOutbox: ReviewInvitationOutbox,
    @Inject(PackageRefundNotificationOutbox)
    private readonly packageRefundNotices: PackageRefundNotificationOutbox,
  ) {}

  onModuleInit() {
    // Reading the limit here surfaces an out-of-range value at boot even when
    // both jobs are switched off.
    const limit = readRequestLifecycleScanLimit();

    // Not "enabled" or "disabled": whether either job acts is a database
    // answer that can change between now and the next tick, and a boot line
    // claiming otherwise would be stale the first time somebody used the panel.
    this.logger.log(
      `Request expiry registered with cron "${expiryCron}" limit=${limit}; ` +
        'runs only while the operations setting says so',
    );
    this.logger.log(
      `Request reminder registered with cron "${reminderCron}" limit=${limit}; ` +
        'runs only while the operations setting says so',
    );

    warnIfLegacySchedulerFlagSet(this.logger, 'REQUEST_EXPIRY_SCHEDULER_ENABLED');
    warnIfLegacySchedulerFlagSet(this.logger, 'REQUEST_REMINDER_SCHEDULER_ENABLED');
  }

  @Cron(expiryCron, { name: 'request-expiry-scheduler' })
  async runScheduledExpiry() {
    if (!(await this.settings.isJobEnabled('request-expiry'))) {
      return;
    }

    if (this.isExpiryRunning) {
      this.logger.warn('Request expiry skipped because a previous run is still active');
      return;
    }

    this.isExpiryRunning = true;
    const startedAt = new Date();

    try {
      const limit = readRequestLifecycleScanLimit();
      const result = await this.expiry.execute({ limit });
      // The publish outbox rides the same tick: anything a request handler's
      // post-commit delivery did not finish is swept here, with no cron of its own.
      const publish = await this.publishOutbox.deliverPending({ limit });
      // So does the review invitation outbox: a completion whose post-commit
      // delivery died is swept here rather than waiting for an admin retry.
      const invitations = await this.reviewInvitationOutbox.deliverPending({ limit });
      // And the package refund status notices (CMP-006 PR-B), on the same terms.
      const refundNotices = await this.packageRefundNotices.deliverPending({ limit });
      const summary =
        `processed=${result.processed} expired=${result.expired} ` +
        `skipped=${result.skipped} failed=${result.failed} ` +
        `enqueued=${result.enqueued} notified=${result.notified} ` +
        `publishSent=${publish.sent} reviewInvitationsSent=${invitations.sent} ` +
        `packageRefundNoticesSent=${refundNotices.sent}`;
      this.logger.log(`Request expiry summary ${summary}`);
      this.runs.record('request-expiry', {
        startedAt,
        finishedAt: new Date(),
        outcome: 'SUCCESS',
        summary,
      });
    } catch (error) {
      this.logger.error(
        'Request expiry run failed',
        error instanceof Error ? error.stack : String(error),
      );
      // The class only. The panel shows this to an operator, and a driver's
      // error text can carry a connection string.
      this.runs.record('request-expiry', {
        startedAt,
        finishedAt: new Date(),
        outcome: 'FAILED',
        summary: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      this.isExpiryRunning = false;
    }
  }

  @Cron(reminderCron, { name: 'request-reminder-scheduler' })
  async runScheduledReminder() {
    if (!(await this.settings.isJobEnabled('request-reminder'))) {
      return;
    }

    if (this.isReminderRunning) {
      this.logger.warn('Request reminder skipped because a previous run is still active');
      return;
    }

    this.isReminderRunning = true;
    const startedAt = new Date();

    try {
      const limit = readRequestLifecycleScanLimit();
      const result = await this.reminder.execute({ limit });
      const summary =
        `processed=${result.processed} reminded=${result.reminded} ` +
        `skipped=${result.skipped} failedToSend=${result.failedToSend}`;
      this.logger.log(`Request reminder summary ${summary}`);
      this.runs.record('request-reminder', {
        startedAt,
        finishedAt: new Date(),
        outcome: 'SUCCESS',
        summary,
      });
    } catch (error) {
      this.logger.error(
        'Request reminder run failed',
        error instanceof Error ? error.stack : String(error),
      );
      this.runs.record('request-reminder', {
        startedAt,
        finishedAt: new Date(),
        outcome: 'FAILED',
        summary: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      this.isReminderRunning = false;
    }
  }
}
