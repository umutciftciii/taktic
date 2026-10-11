import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NumberingModule } from '../numbering/numbering.module';
import { OperationsSettingsModule } from '../operations-settings/operations-settings.module';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { ServiceIssueController } from './service-issue.controller';
import { ServiceIssueService } from './service-issue.service';
import { ServiceIssueThrottlerGuard } from './service-issue.throttler';

/**
 * REL-002 Faz 3: the customer service-issue flow. Depends on the requests
 * module (for the canonical publish gate a reopened direct lead goes
 * through); nothing depends on this one, so it cannot cycle.
 */
@Module({
  imports: [PrismaModule, AuthModule, NumberingModule, OperationsSettingsModule, ServiceRequestsModule],
  controllers: [ServiceIssueController],
  providers: [ServiceIssueService, ServiceIssueThrottlerGuard],
  exports: [ServiceIssueService],
})
export class ServiceIssuesModule {}
