import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CustomerProviderReviewsController } from './customer-provider-reviews.controller';
import { ProviderPanelReviewsController } from './provider-panel-reviews.controller';
import { ProviderReviewsService } from './provider-reviews.service';
import { PublicProviderReviewsController } from './public-provider-reviews.controller';

/**
 * The mail service comes from the global `NotificationsModule`;
 * `ProviderAccessGuard` needs `PrismaModule`. Reports and moderation are
 * added to this module by later tasks.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    CustomerProviderReviewsController,
    ProviderPanelReviewsController,
    PublicProviderReviewsController,
  ],
  providers: [ProviderReviewsService],
  exports: [ProviderReviewsService],
})
export class ProviderReviewsModule {}
