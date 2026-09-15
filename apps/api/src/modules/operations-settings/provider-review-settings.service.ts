import { Inject, Injectable, Logger } from '@nestjs/common';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS } from '../offers/refund-policy';
import { OPERATIONS_SETTINGS_ID } from './operations-settings.service';
import type { SchedulerSettingsChangeView } from './scheduler-settings.service';

export const PROVIDER_REVIEWS_SETTING = 'providerReviewsEnabled';

export type ProviderReviewSettingsView = {
  enabled: boolean;
  recentChanges: SchedulerSettingsChangeView[];
};

const RECENT_CHANGE_LIMIT = 20;

/**
 * The one switch that decides whether customers can rate a provider. Same
 * contract as SchedulerSettingsService: no row, an unreadable row and a false
 * column all mean "off"; every read re-checks it.
 */
@Injectable()
export class ProviderReviewSettingsService {
  private readonly logger = new Logger(ProviderReviewSettingsService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Fail-closed: no row, unreadable row and false all mean "off". */
  async isEnabled(): Promise<boolean> {
    try {
      const row = await this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: { providerReviewsEnabled: true },
      });
      return row?.providerReviewsEnabled ?? false;
    } catch (error) {
      this.logger.error(
        `Provider reviews setting could not be read; treating it as off (${error instanceof Error ? error.name : 'UnknownError'})`,
      );
      return false;
    }
  }

  async getForAdmin(): Promise<ProviderReviewSettingsView> {
    const [row, changes] = await Promise.all([
      this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: { providerReviewsEnabled: true },
      }),
      this.prisma.operationsSettingsChange.findMany({
        where: { setting: PROVIDER_REVIEWS_SETTING },
        orderBy: { createdAt: 'desc' },
        take: RECENT_CHANGE_LIMIT,
        select: {
          id: true,
          setting: true,
          previousValue: true,
          newValue: true,
          createdAt: true,
          changedBy: { select: { id: true, name: true } },
        },
      }),
    ]);
    return { enabled: row?.providerReviewsEnabled ?? false, recentChanges: changes };
  }

  async setEnabled(enabled: boolean, changedById: string): Promise<ProviderReviewSettingsView> {
    await runSerializable(
      this.prisma,
      async (tx) => {
        const current = await tx.operationsSettings.findUnique({
          where: { id: OPERATIONS_SETTINGS_ID },
          select: { providerReviewsEnabled: true },
        });
        const stored = current?.providerReviewsEnabled ?? null;
        if ((stored ?? false) === enabled) {
          return;
        }
        await tx.operationsSettings.upsert({
          where: { id: OPERATIONS_SETTINGS_ID },
          create: {
            id: OPERATIONS_SETTINGS_ID,
            unviewedOfferRefundWindowHours: DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
            updatedById: changedById,
            providerReviewsEnabled: enabled,
          },
          update: { updatedById: changedById, providerReviewsEnabled: enabled },
        });
        await tx.operationsSettingsChange.create({
          data: {
            setting: PROVIDER_REVIEWS_SETTING,
            previousValue: stored === null ? null : String(stored),
            newValue: String(enabled),
            changedById,
          },
        });
      },
      { label: 'providerReviewSettings.set' },
    );
    return this.getForAdmin();
  }
}
