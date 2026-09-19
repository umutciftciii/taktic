import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminCampaignsController } from './admin-campaigns.controller';
import { CampaignEngineSettingsService } from './campaign-engine-settings.service';
import { CampaignsService } from './campaigns.service';

/**
 * Campaign definitions (CMP-002 S0/S1).
 *
 * Imports nothing from the domain — not providers, not payments, not credits
 * — and exports nothing to it. That is the slice boundary made structural:
 * no event handler, webhook or scheduler can reach a campaign through this
 * module, because no module that owns one of those depends on it.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AdminCampaignsController],
  providers: [CampaignsService, CampaignEngineSettingsService],
})
export class CampaignsModule {}
