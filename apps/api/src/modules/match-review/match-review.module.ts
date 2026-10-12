import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { OperationsSettingsModule } from '../operations-settings/operations-settings.module';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { AdminMatchReviewController } from './match-review.controller';
import { MatchReviewService } from './match-review.service';

/**
 * REL-002 Faz 5: staff recovery of a request in MATCH_REVIEW. Depends on the
 * requests module (the canonical publish gate the new round goes through);
 * nothing depends on this one, so it cannot cycle.
 */
@Module({
  imports: [PrismaModule, AuthModule, OperationsSettingsModule, ServiceRequestsModule],
  controllers: [AdminMatchReviewController],
  providers: [MatchReviewService],
})
export class MatchReviewModule {}
