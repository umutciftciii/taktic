import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { validateCronExpression } from 'cron';
import { UnviewedOfferRefundService } from '../offers/unviewed-offer-refund.service';

const DEFAULT_CRON = '0 * * * *';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const schedulerCron = readCronEnv();

/**
 * Runs the unviewed-offer refund on a schedule.
 *
 * Off unless `UNVIEWED_OFFER_REFUND_ENABLED` is exactly `"true"`. A worker that
 * moves money must be turned on by somebody, in one environment at a time, and
 * never by a default that follows a deploy into production.
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
  ) {}

  onModuleInit() {
    if (!isSchedulerEnabled()) {
      this.logger.log('Unviewed-offer refund scheduler disabled');
      return;
    }

    this.logger.log(`Unviewed-offer refund scheduler enabled with cron "${schedulerCron}"`);
  }

  @Cron(schedulerCron, { name: 'unviewed-offer-refund' })
  async runScheduledRefund() {
    if (!isSchedulerEnabled()) {
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
    this.logger.log(`Unviewed-offer refund started limit=${limit}`);

    try {
      const result = await this.unviewedOfferRefund.execute({ limit });
      const failed = result.results.filter((item) => item.status === 'FAILED').length;

      this.logger.log(
        `Unviewed-offer refund summary processed=${result.processed} refunded=${result.refunded} skipped=${result.skipped} failed=${failed}`,
      );
    } catch (err) {
      this.logger.error(
        'Unviewed-offer refund failed',
        err instanceof Error ? err.stack : String(err),
      );
    } finally {
      this.isRunning = false;
      this.logger.log('Unviewed-offer refund finished');
    }
  }
}

function isSchedulerEnabled() {
  return process.env.UNVIEWED_OFFER_REFUND_ENABLED === 'true';
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

function readCronEnv() {
  const rawValue = process.env.UNVIEWED_OFFER_REFUND_CRON;
  if (!rawValue) {
    return DEFAULT_CRON;
  }

  const result = validateCronExpression(rawValue);
  return result.valid ? rawValue : DEFAULT_CRON;
}
