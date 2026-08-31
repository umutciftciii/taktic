import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { validateCronExpression } from 'cron';
import { EntitlementRenewalService } from './entitlement-renewal.service';

const DEFAULT_RENEWAL_CRON = '*/15 * * * *';
const renewalCron = readCronEnv();

/**
 * Runs the period-end pass.
 *
 * Mirrors the refund scheduler deliberately — same enable switch shape, same
 * "never start a second pass while one is running" guard, same cron validation
 * — because both are background money paths and an operator should not have to
 * learn two sets of rules.
 *
 * Disabled by default, like the refund scheduler: a deployment turns it on when
 * an operator is ready to watch it. Nothing depends on it for correctness —
 * every reader of a period checks `endAt` itself, so a scheduler that never
 * runs cannot hand out an extra day of access. It only writes down what the
 * clock has already decided.
 */
@Injectable()
export class EntitlementRenewalScheduler implements OnModuleInit {
  private readonly logger = new Logger(EntitlementRenewalScheduler.name);
  private isRunning = false;

  constructor(
    @Inject(EntitlementRenewalService) private readonly renewals: EntitlementRenewalService,
  ) {}

  onModuleInit() {
    if (!isRenewalSchedulerEnabled()) {
      this.logger.log('Entitlement renewal scheduler disabled');
      return;
    }

    this.logger.log(`Entitlement renewal scheduler enabled with cron "${renewalCron}"`);
  }

  @Cron(renewalCron, { name: 'entitlement-renewal' })
  async runScheduledRenewals() {
    if (!isRenewalSchedulerEnabled() || this.isRunning) {
      return;
    }

    this.isRunning = true;
    try {
      const summary = await this.renewals.runDueRenewals();
      if (summary.examined > 0) {
        this.logger.log(
          `renewal pass examined=${summary.examined} renewed=${summary.renewed} ` +
            `expired=${summary.expired} failed=${summary.failed} unsupported=${summary.unsupported}`,
        );
      }
    } catch (err) {
      this.logger.error(
        'Entitlement renewal pass failed',
        err instanceof Error ? err.stack : String(err),
      );
    } finally {
      this.isRunning = false;
    }
  }
}

export function isRenewalSchedulerEnabled(): boolean {
  return process.env.ENTITLEMENT_RENEWAL_SCHEDULER_ENABLED === 'true';
}

function readCronEnv(): string {
  const raw = process.env.ENTITLEMENT_RENEWAL_CRON?.trim();
  if (!raw) {
    return DEFAULT_RENEWAL_CRON;
  }

  const validation = validateCronExpression(raw);
  if (!validation.valid) {
    throw new Error(
      'ENTITLEMENT_RENEWAL_CRON is not a valid cron expression. The value itself is deliberately not shown.',
    );
  }

  return raw;
}
