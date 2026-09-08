import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { warnIfLegacySchedulerFlagSet } from '../../common/legacy-scheduler-flags';
import { readSchedulerCron } from '../../common/scheduler-cron';
import { SchedulerRunRegistry } from '../operations-settings/scheduler-run-registry.service';
import { SchedulerSettingsService } from '../operations-settings/scheduler-settings.service';
import { UnviewedOfferRefundService } from '../offers/unviewed-offer-refund.service';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const schedulerCron = readSchedulerCron('unviewed-offer-refund');

/**
 * Runs the unviewed-offer refund on a schedule.
 *
 * Off until a super admin switches it on from the admin panel, and re-read on
 * every tick. A worker that moves money must be turned on by somebody, in one
 * environment at a time, and never by a default that follows a deploy into
 * production — the switch used to be an environment flag, which said the same
 * thing but could only be answered by reading a deploy config over somebody's
 * shoulder.
 *
 * There is no window setting here, and the configurable one does not belong
 * here either. The scheduler decides *when to look*, never *how far back to
 * look*: the window is a commercial term a super admin sets, and each offer
 * carries the moment it produced. A late run therefore refunds on its next
 * pass, and an aggressive cron cannot refund early.
 */
@Injectable()
export class UnviewedOfferRefundSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(UnviewedOfferRefundSchedulerService.name);
  private isRunning = false;

  constructor(
    @Inject(UnviewedOfferRefundService)
    private readonly unviewedOfferRefund: UnviewedOfferRefundService,
    @Inject(SchedulerSettingsService) private readonly settings: SchedulerSettingsService,
    @Inject(SchedulerRunRegistry) private readonly runs: SchedulerRunRegistry,
  ) {}

  onModuleInit() {
    this.logger.log(
      `Unviewed-offer refund registered with cron "${schedulerCron}"; ` +
        'runs only while the operations setting says so',
    );
    warnIfLegacySchedulerFlagSet(this.logger, 'UNVIEWED_OFFER_REFUND_ENABLED');
  }

  @Cron(schedulerCron, { name: 'unviewed-offer-refund' })
  async runScheduledRefund() {
    if (!(await this.settings.isJobEnabled('unviewed-offer-refund'))) {
      return;
    }

    if (this.isRunning) {
      this.logger.warn('Unviewed-offer refund skipped because a previous run is still active');
      return;
    }

    const limit = readPositiveIntegerEnv('UNVIEWED_OFFER_REFUND_LIMIT', DEFAULT_LIMIT, {
      max: MAX_LIMIT,
    });

    this.isRunning = true;
    const startedAt = new Date();
    this.logger.log(`Unviewed-offer refund started limit=${limit}`);

    try {
      const result = await this.unviewedOfferRefund.execute({ limit });
      const failed = result.results.filter((item) => item.status === 'FAILED').length;
      const summary =
        `processed=${result.processed} refunded=${result.refunded} ` +
        `skipped=${result.skipped} failed=${failed}`;

      this.logger.log(`Unviewed-offer refund summary ${summary}`);
      this.runs.record('unviewed-offer-refund', {
        startedAt,
        finishedAt: new Date(),
        outcome: 'SUCCESS',
        summary,
      });
    } catch (err) {
      this.logger.error(
        'Unviewed-offer refund failed',
        err instanceof Error ? err.stack : String(err),
      );
      // The class only. The panel shows this to an operator, and a driver's
      // error text can carry a connection string.
      this.runs.record('unviewed-offer-refund', {
        startedAt,
        finishedAt: new Date(),
        outcome: 'FAILED',
        summary: err instanceof Error ? err.name : 'UnknownError',
      });
    } finally {
      this.isRunning = false;
      this.logger.log('Unviewed-offer refund finished');
    }
  }
}

function readPositiveIntegerEnv(key: string, fallback: number, options: { max?: number } = {}) {
  const rawValue = process.env[key];
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  if (options.max !== undefined && parsed > options.max) {
    return options.max;
  }

  return parsed;
}
