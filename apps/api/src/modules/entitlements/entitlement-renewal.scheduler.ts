import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { warnIfLegacySchedulerFlagSet } from '../../common/legacy-scheduler-flags';
import { readSchedulerCron } from '../../common/scheduler-cron';
import { SchedulerRunRegistry } from '../operations-settings/scheduler-run-registry.service';
import { SchedulerSettingsService } from '../operations-settings/scheduler-settings.service';
import { EntitlementRenewalService } from './entitlement-renewal.service';

const renewalCron = readSchedulerCron('entitlement-renewal');

/**
 * Runs the period-end pass.
 *
 * Mirrors the refund scheduler deliberately — same switch, same "never start a
 * second pass while one is running" guard, same cron source — because both are
 * background money paths and an operator should not have to learn two sets of
 * rules.
 *
 * Off until an operator switches it on, like the refund scheduler, and for the
 * same reason: a deployment turns it on when somebody is ready to watch it.
 * Nothing depends on it for correctness — every reader of a period checks
 * `endAt` itself, so a scheduler that never runs cannot hand out an extra day
 * of access. It only writes down what the clock has already decided.
 *
 * The switch is a persistent operations setting rather than an environment
 * flag, re-read on every tick, so turning it off stops the next pass without a
 * deploy and without a restart.
 */
@Injectable()
export class EntitlementRenewalScheduler implements OnModuleInit {
  private readonly logger = new Logger(EntitlementRenewalScheduler.name);
  private isRunning = false;

  constructor(
    @Inject(EntitlementRenewalService) private readonly renewals: EntitlementRenewalService,
    @Inject(SchedulerSettingsService) private readonly settings: SchedulerSettingsService,
    @Inject(SchedulerRunRegistry) private readonly runs: SchedulerRunRegistry,
  ) {}

  onModuleInit() {
    this.logger.log(
      `Entitlement renewal registered with cron "${renewalCron}"; ` +
        'runs only while the operations setting says so',
    );
    warnIfLegacySchedulerFlagSet(this.logger, 'ENTITLEMENT_RENEWAL_SCHEDULER_ENABLED');
  }

  @Cron(renewalCron, { name: 'entitlement-renewal' })
  async runScheduledRenewals() {
    if (!(await this.settings.isJobEnabled('entitlement-renewal'))) {
      return;
    }

    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    const startedAt = new Date();

    try {
      const summary = await this.renewals.runDueRenewals();
      const line =
        `examined=${summary.examined} renewed=${summary.renewed} ` +
        `expired=${summary.expired} failed=${summary.failed} unsupported=${summary.unsupported}`;

      if (summary.examined > 0) {
        this.logger.log(`renewal pass ${line}`);
      }

      this.runs.record('entitlement-renewal', {
        startedAt,
        finishedAt: new Date(),
        outcome: 'SUCCESS',
        summary: line,
      });
    } catch (err) {
      this.logger.error(
        'Entitlement renewal pass failed',
        err instanceof Error ? err.stack : String(err),
      );
      // The class only. The panel shows this to an operator, and a driver's
      // error text can carry a connection string.
      this.runs.record('entitlement-renewal', {
        startedAt,
        finishedAt: new Date(),
        outcome: 'FAILED',
        summary: err instanceof Error ? err.name : 'UnknownError',
      });
    } finally {
      this.isRunning = false;
    }
  }
}
