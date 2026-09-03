import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { OperationsSettingsController } from './operations-settings.controller';
import { OperationsSettingsService } from './operations-settings.service';
import { RefundPolicyController } from './refund-policy.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [OperationsSettingsController, RefundPolicyController],
  providers: [OperationsSettingsService],
  exports: [OperationsSettingsService],
})
export class OperationsSettingsModule {}
