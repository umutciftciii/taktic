import { Inject, Injectable, Logger } from '@nestjs/common';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS } from '../offers/refund-policy';
import { OPERATIONS_SETTINGS_ID } from './operations-settings.service';
import type { SchedulerSettingsChangeView } from './scheduler-settings.service';

export const SERVICE_ISSUE_REPORTING_SETTING = 'serviceIssueReportingEnabled';

export type ServiceIssueSettingsView = {
  enabled: boolean;
  recentChanges: SchedulerSettingsChangeView[];
};

const RECENT_CHANGE_LIMIT = 20;

/**
 * REL-002 Faz 3 — the one switch that decides whether a customer may report a
 * service issue (close the match, exclude the provider, reopen the request).
 * Same contract as SchedulerSettingsService: no row, an unreadable row and a
 * false column all mean "off"; every report and every customer read re-checks
 * it. Ships off; turned on by a person after local acceptance, never by a
 * migration.
 */
@Injectable()
export class ServiceIssueSettingsService {
  private readonly logger = new Logger(ServiceIssueSettingsService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Fail-closed: no row, unreadable row and false all mean "off". */
  async isEnabled(): Promise<boolean> {
    try {
      const row = await this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: { serviceIssueReportingEnabled: true },
      });
      return row?.serviceIssueReportingEnabled ?? false;
    } catch (error) {
      this.logger.error(
        `Service issue setting could not be read; treating it as off (${error instanceof Error ? error.name : 'UnknownError'})`,
      );
      return false;
    }
  }

  async getForAdmin(): Promise<ServiceIssueSettingsView> {
    const [row, changes] = await Promise.all([
      this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: { serviceIssueReportingEnabled: true },
      }),
      this.prisma.operationsSettingsChange.findMany({
        where: { setting: SERVICE_ISSUE_REPORTING_SETTING },
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
    return { enabled: row?.serviceIssueReportingEnabled ?? false, recentChanges: changes };
  }

  async setEnabled(enabled: boolean, changedById: string): Promise<ServiceIssueSettingsView> {
    await runSerializable(
      this.prisma,
      async (tx) => {
        const current = await tx.operationsSettings.findUnique({
          where: { id: OPERATIONS_SETTINGS_ID },
          select: { serviceIssueReportingEnabled: true },
        });
        const stored = current?.serviceIssueReportingEnabled ?? null;
        if ((stored ?? false) === enabled) {
          return;
        }
        await tx.operationsSettings.upsert({
          where: { id: OPERATIONS_SETTINGS_ID },
          create: {
            id: OPERATIONS_SETTINGS_ID,
            unviewedOfferRefundWindowHours: DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
            updatedById: changedById,
            serviceIssueReportingEnabled: enabled,
          },
          update: { updatedById: changedById, serviceIssueReportingEnabled: enabled },
        });
        await tx.operationsSettingsChange.create({
          data: {
            setting: SERVICE_ISSUE_REPORTING_SETTING,
            previousValue: stored === null ? null : String(stored),
            newValue: String(enabled),
            changedById,
          },
        });
      },
      { label: 'serviceIssueSettings.set' },
    );
    return this.getForAdmin();
  }
}
