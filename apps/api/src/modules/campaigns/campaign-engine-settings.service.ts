import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OPERATIONS_SETTINGS_ID } from '../operations-settings/operations-settings.service';

/**
 * Whether the campaign engine may grant anything — read, never written.
 *
 * Same contract as the other operations switches: no row, an unreadable row
 * and a false column all mean "off". In the S0/S1 slice the only reader is the
 * admin campaign screen, which shows the answer as a badge; no code path
 * evaluates a campaign, and no endpoint sets this column. The switch exists
 * now so that the screen tells the truth from the database rather than from a
 * constant, and so that S2 inherits a reader that already fails closed.
 */
@Injectable()
export class CampaignEngineSettingsService {
  private readonly logger = new Logger(CampaignEngineSettingsService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async isEngineEnabled(): Promise<boolean> {
    try {
      const row = await this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: { campaignEngineEnabled: true },
      });
      return row?.campaignEngineEnabled ?? false;
    } catch (error) {
      this.logger.error(
        `Campaign engine setting could not be read; treating it as off (${error instanceof Error ? error.name : 'UnknownError'})`,
      );
      return false;
    }
  }
}
