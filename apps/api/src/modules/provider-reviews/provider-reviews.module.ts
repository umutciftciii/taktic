import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminProviderReviewsController } from './admin-provider-reviews.controller';
import { CustomerProviderReviewsController } from './customer-provider-reviews.controller';
import { ProviderPanelReviewsController } from './provider-panel-reviews.controller';
import { ProviderReviewModerationService } from './provider-review-moderation.service';
import { ProviderReviewsService } from './provider-reviews.service';
import { PublicProviderReviewsController } from './public-provider-reviews.controller';

/**
 * The mail service comes from the global `NotificationsModule`;
 * `ProviderAccessGuard` needs `PrismaModule`. The admin controller owns the
 * `/provider-reviews` prefix outright, so it needs no ordering against any
 * other module.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    CustomerProviderReviewsController,
    ProviderPanelReviewsController,
    PublicProviderReviewsController,
    AdminProviderReviewsController,
  ],
  providers: [ProviderReviewsService, ProviderReviewModerationService],
  exports: [ProviderReviewsService, ProviderReviewModerationService],
})
export class ProviderReviewsModule {}
