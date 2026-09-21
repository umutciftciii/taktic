import { Inject, Injectable } from '@nestjs/common';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS } from '../offers/refund-policy';
import { OPERATIONS_SETTINGS_ID } from './operations-settings.service';
import type { SchedulerSettingsChangeView } from './scheduler-settings.service';

export const CAMPAIGN_ENGINE_SETTING = 'campaignEngineEnabled';

export type CampaignEngineSettingsView = {
  enabled: boolean;
  recentChanges: SchedulerSettingsChangeView[];
};

const RECENT_CHANGE_LIMIT = 20;

/**
 * The campaign engine's switch, and its one writer (CMP-004 S4).
 *
 * `OperationsSettings.campaignEngineEnabled` has been read fail-closed by
 * every engine path since S2A — the hooks that make an event durable, the
 * worker that claims and evaluates, the activation and resume routes — and
 * until now nothing could set it. This service is that writer, on exactly
 * the contract of the other operations switches: SUPER_ADMIN only (the
 * controller), Serializable, the value and its `OperationsSettingsChange`
 * row committed together, and a write that changes nothing writing nothing
 * — including switching off a switch that has no row yet, which is already
 * off. The stored default stays `false`; no seed, migration or environment
 * variable sets it, and neither does this class unless an operator asks.
 *
 * What the switch governs is *new entitlement*. Reversing a promotion that
 * already exists (`CampaignRevokeService`) does not read it, so switching
 * the engine off never leaves a refunded promotion in a wallet; and
 * switching it on raises no event for anything that happened while it was
 * off, because events are raised only inside the transactions that make
 * the underlying facts true.
 */
@Injectable()
export class CampaignEngineSwitchService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getForAdmin(): Promise<CampaignEngineSettingsView> {
    const [row, changes] = await Promise.all([
      this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: { campaignEngineEnabled: true },
      }),
      this.prisma.operationsSettingsChange.findMany({
        where: { setting: CAMPAIGN_ENGINE_SETTING },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
    return { enabled: row?.campaignEngineEnabled ?? false, recentChanges: changes };
  }

  async setEnabled(enabled: boolean, changedById: string): Promise<CampaignEngineSettingsView> {
    await runSerializable(
      this.prisma,
      async (tx) => {
        const current = await tx.operationsSettings.findUnique({
          where: { id: OPERATIONS_SETTINGS_ID },
          select: { campaignEngineEnabled: true },
        });
        const stored = current?.campaignEngineEnabled ?? null;
        // Against the *effective* value: no row is "off", so asking for off
        // is not a decision and creates neither a row nor an audit entry.
        if ((stored ?? false) === enabled) {
          return;
        }
        await tx.operationsSettings.upsert({
          where: { id: OPERATIONS_SETTINGS_ID },
          create: {
            id: OPERATIONS_SETTINGS_ID,
            // The row's other NOT NULL column, at the value already in force.
            unviewedOfferRefundWindowHours: DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
            updatedById: changedById,
            campaignEngineEnabled: enabled,
          },
          update: { updatedById: changedById, campaignEngineEnabled: enabled },
        });
        await tx.operationsSettingsChange.create({
          data: {
            setting: CAMPAIGN_ENGINE_SETTING,
            previousValue: stored === null ? null : String(stored),
            newValue: String(enabled),
            changedById,
          },
        });
      },
      { label: 'campaignEngineSettings.set' },
    );
    return this.getForAdmin();
  }
}
