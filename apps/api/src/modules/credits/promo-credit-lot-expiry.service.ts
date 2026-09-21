import { Inject, Injectable, Logger } from '@nestjs/common';
import { PromoCreditLotStatus } from '@prisma/client';
import { isConcurrentModificationError, runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { expirePromoCreditLot } from './promo-credit-ledger';

const DEFAULT_LIMIT = 200;

export type PromoCreditLotExpiryResult = {
  candidates: number;
  expired: number;
  creditsExpired: number;
  skipped: number;
  failed: number;
  items: Array<{ lotId: string; status: 'EXPIRED' | 'SKIPPED' | 'FAILED'; credits: number; transactionId: string | null }>;
};

/**
 * The internal seam that expires due promo lots (CMP-002 S2B1).
 *
 * Deliberately not a scheduler: no `@Cron`, no `OperationsSettings` switch
 * and no endpoint call it. S2B2 adds `campaignLotExpirySchedulerEnabled`
 * and the job around this method; until then its only caller is the test
 * suite, which is also the only place a lot can come from.
 *
 * One Serializable transaction per lot, mirroring the unviewed-offer refund
 * worker: a lot that a concurrent runner expired first is a skip, not a
 * failure, and a failure on one lot does not stop the others.
 */
@Injectable()
export class PromoCreditLotExpiryService {
  private readonly logger = new Logger(PromoCreditLotExpiryService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async expireDueLots(now = new Date(), options: { limit?: number } = {}): Promise<PromoCreditLotExpiryResult> {
    const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 1000));
    const candidates = await this.prisma.promoCreditLot.findMany({
      where: {
        status: { in: [PromoCreditLotStatus.ACTIVE, PromoCreditLotStatus.EXHAUSTED] },
        expiresAt: { lte: now },
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });

    const items: PromoCreditLotExpiryResult['items'] = [];
    for (const candidate of candidates) {
      try {
        const result = await runSerializable(
          this.prisma,
          (tx) => expirePromoCreditLot(tx, { lotId: candidate.id, now }),
          { label: 'promoCreditLotExpiry.expire' },
        );
        items.push({
          lotId: candidate.id,
          status: result.expired ? 'EXPIRED' : 'SKIPPED',
          credits: result.credits,
          transactionId: result.transactionId,
        });
      } catch (error) {
        if (isConcurrentModificationError(error)) {
          items.push({ lotId: candidate.id, status: 'SKIPPED', credits: 0, transactionId: null });
          continue;
        }
        this.logger.error(
          `Promo lot expiry failed for lot ${candidate.id}`,
          error instanceof Error ? error.stack : String(error),
        );
        items.push({ lotId: candidate.id, status: 'FAILED', credits: 0, transactionId: null });
      }
    }

    return {
      candidates: candidates.length,
      expired: items.filter((item) => item.status === 'EXPIRED').length,
      creditsExpired: items.reduce((total, item) => total + (item.status === 'EXPIRED' ? item.credits : 0), 0),
      skipped: items.filter((item) => item.status === 'SKIPPED').length,
      failed: items.filter((item) => item.status === 'FAILED').length,
      items,
    };
  }
}
