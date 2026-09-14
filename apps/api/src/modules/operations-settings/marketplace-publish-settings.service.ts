import { Inject, Injectable, Logger } from '@nestjs/common';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS } from '../offers/refund-policy';
import { OPERATIONS_SETTINGS_ID } from './operations-settings.service';
import type { SchedulerSettingsChangeView } from './scheduler-settings.service';

export const MARKETPLACE_AUTO_PUBLISH_SETTING = 'marketplaceAutoPublishEnabled';

export type MarketplacePublishSettingsView = {
  enabled: boolean;
  recentChanges: SchedulerSettingsChangeView[];
};

const RECENT_CHANGE_LIMIT = 20;

/**
 * The one switch that decides whether a marketplace request waits for an
 * operator. Same contract as SchedulerSettingsService: no row, an unreadable
 * row and a false column all mean "off"; every creation re-reads it.
 */
@Injectable()
export class MarketplacePublishSettingsService {
  private readonly logger = new Logger(MarketplacePublishSettingsService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async isAutoPublishEnabled(): Promise<boolean> {
    try {
      const row = await this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: { marketplaceAutoPublishEnabled: true },
      });
      return row?.marketplaceAutoPublishEnabled ?? false;
    } catch (error) {
      this.logger.error(
        `Auto-publish setting could not be read; treating it as off (${error instanceof Error ? error.name : 'UnknownError'})`,
      );
      return false;
    }
  }

  async getForAdmin(): Promise<MarketplacePublishSettingsView> {
    const [row, changes] = await Promise.all([
      this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: { marketplaceAutoPublishEnabled: true },
      }),
      this.prisma.operationsSettingsChange.findMany({
        where: { setting: MARKETPLACE_AUTO_PUBLISH_SETTING },
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
    return { enabled: row?.marketplaceAutoPublishEnabled ?? false, recentChanges: changes };
  }

  async setAutoPublishEnabled(
    enabled: boolean,
    changedById: string,
  ): Promise<MarketplacePublishSettingsView> {
    await runSerializable(
      this.prisma,
      async (tx) => {
        const current = await tx.operationsSettings.findUnique({
          where: { id: OPERATIONS_SETTINGS_ID },
          select: { marketplaceAutoPublishEnabled: true },
        });
        const stored = current?.marketplaceAutoPublishEnabled ?? null;
        if ((stored ?? false) === enabled) {
          return;
        }
        await tx.operationsSettings.upsert({
          where: { id: OPERATIONS_SETTINGS_ID },
          create: {
            id: OPERATIONS_SETTINGS_ID,
            unviewedOfferRefundWindowHours: DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
            updatedById: changedById,
            marketplaceAutoPublishEnabled: enabled,
          },
          update: { updatedById: changedById, marketplaceAutoPublishEnabled: enabled },
        });
        await tx.operationsSettingsChange.create({
          data: {
            setting: MARKETPLACE_AUTO_PUBLISH_SETTING,
            previousValue: stored === null ? null : String(stored),
            newValue: String(enabled),
            changedById,
          },
        });
      },
      { label: 'marketplacePublishSettings.set' },
    );
    return this.getForAdmin();
  }
}
