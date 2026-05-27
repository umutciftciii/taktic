import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { validateCronExpression } from 'cron';
import { RefundScanService } from '../offers/refund-scan.service';

const DEFAULT_REFUND_SCHEDULER_CRON = '0 * * * *';
const DEFAULT_REFUND_SCAN_OLDER_THAN_HOURS = 48;
const DEFAULT_REFUND_SCAN_LIMIT = 100;
const MAX_REFUND_SCAN_LIMIT = 500;
const refundSchedulerCron = readCronEnv();

@Injectable()
export class RefundSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(RefundSchedulerService.name);
  private isRunning = false;

  constructor(@Inject(RefundScanService) private readonly refundScanService: RefundScanService) {}

  onModuleInit() {
    if (!isRefundSchedulerEnabled()) {
      this.logger.log('Refund scheduler disabled');
      return;
    }

    this.logger.log(`Refund scheduler enabled with cron "${refundSchedulerCron}"`);
  }

  @Cron(refundSchedulerCron, { name: 'refund-scheduler' })
  async runScheduledRefundScan() {
    if (!isRefundSchedulerEnabled()) {
      return;
    }

    if (this.isRunning) {
      this.logger.warn('Refund scheduler skipped because a previous run is still active');
      return;
    }

    const olderThanHours = readPositiveIntegerEnv(
      'REFUND_SCAN_OLDER_THAN_HOURS',
      DEFAULT_REFUND_SCAN_OLDER_THAN_HOURS,
    );
    const limit = readPositiveIntegerEnv('REFUND_SCAN_LIMIT', DEFAULT_REFUND_SCAN_LIMIT, {
      max: MAX_REFUND_SCAN_LIMIT,
    });

    this.isRunning = true;
    this.logger.log(`Refund scheduler started olderThanHours=${olderThanHours} limit=${limit}`);

    try {
      const result = await this.refundScanService.execute({ olderThanHours, limit });
      const failed = result.results.filter((item) => item.status === 'FAILED').length;

      this.logger.log(
        `Refund scheduler summary processed=${result.processed} refunded=${result.refunded} skipped=${result.skipped} failed=${failed}`,
      );
    } catch (err) {
      this.logger.error('Refund scheduler failed', err instanceof Error ? err.stack : String(err));
    } finally {
      this.isRunning = false;
      this.logger.log('Refund scheduler finished');
    }
  }
}

function isRefundSchedulerEnabled() {
  return process.env.REFUND_SCHEDULER_ENABLED === 'true';
}

function readPositiveIntegerEnv(
  key: string,
  fallback: number,
  options: { max?: number } = {},
) {
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
  const rawValue = process.env.REFUND_SCHEDULER_CRON;
  if (!rawValue) {
    return DEFAULT_REFUND_SCHEDULER_CRON;
  }

  const result = validateCronExpression(rawValue);
  return result.valid ? rawValue : DEFAULT_REFUND_SCHEDULER_CRON;
}
