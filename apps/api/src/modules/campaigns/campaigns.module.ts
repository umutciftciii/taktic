import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminCampaignsController } from './admin-campaigns.controller';
import { CampaignEngineSettingsService } from './campaign-engine-settings.service';
import { CampaignsService } from './campaigns.service';
import { CampaignEngineModule } from './engine/campaign-engine.module';
import { AdminPromotionEligibilityController } from './eligibility/admin-promotion-eligibility.controller';
import { PromotionEligibilityReviewsService } from './eligibility/promotion-eligibility-reviews.service';

/**
 * Campaign definitions, drafts and lifecycle for the super admin (CMP-002
 * S0/S1/S2B2). The engine itself lives in `CampaignEngineModule`; this module
 * imports it for the activation gate's view of the fact-writer register and
 * exports nothing — no other module reads a campaign through here, and no
 * route here evaluates or grants.
 */
@Module({
  imports: [PrismaModule, AuthModule, CampaignEngineModule],
  controllers: [AdminCampaignsController, AdminPromotionEligibilityController],
  providers: [CampaignsService, CampaignEngineSettingsService, PromotionEligibilityReviewsService],
})
export class CampaignsModule {}
