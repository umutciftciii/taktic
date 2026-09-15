import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CustomerProviderReviewsController } from './customer-provider-reviews.controller';
import { ProviderReviewsService } from './provider-reviews.service';

/**
 * The mail service comes from the global `NotificationsModule`. Provider-side
 * lists, reports and moderation are added to this module by later tasks.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [CustomerProviderReviewsController],
  providers: [ProviderReviewsService],
  exports: [ProviderReviewsService],
})
export class ProviderReviewsModule {}
