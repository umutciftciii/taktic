import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminCampaignsController } from './admin-campaigns.controller';
import { CampaignEngineSettingsService } from './campaign-engine-settings.service';
import { CampaignsService } from './campaigns.service';
import { CampaignEngineService } from './engine/campaign-engine.service';

/**
 * Campaign definitions (CMP-002 S0/S1) and the engine boundary (S2A).
 *
 * Imports nothing from the domain — not providers, not payments, not credits
 * — and exports nothing to it. That is the slice boundary made structural:
 * no event handler, webhook or scheduler can reach a campaign or the engine
 * through this module, because no module that owns one of those depends on
 * it and `CampaignEngineService` is not exported. S2B exports it and wires the
 * hooks; until then its only caller is the test suite.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AdminCampaignsController],
  providers: [CampaignsService, CampaignEngineSettingsService, CampaignEngineService],
})
export class CampaignsModule {}
