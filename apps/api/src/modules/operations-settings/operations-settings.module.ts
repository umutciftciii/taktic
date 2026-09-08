import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { OperationsSettingsController } from './operations-settings.controller';
import { OperationsSettingsService } from './operations-settings.service';
import { RefundPolicyController } from './refund-policy.controller';
import { SchedulerRunRegistry } from './scheduler-run-registry.service';
import { SchedulerSettingsController } from './scheduler-settings.controller';
import { SchedulerSettingsService } from './scheduler-settings.service';

/**
 * The operations settings, and the four background jobs they now also govern.
 *
 * The two scheduler providers are exported because the schedulers themselves
 * live in the modules that own their work — entitlements, offers, request
 * lifecycle — and ask this module on every tick whether they may act. Nothing
 * flows the other way: this module imports no domain module, so wiring a fifth
 * scheduler to it can never produce a cycle.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [OperationsSettingsController, RefundPolicyController, SchedulerSettingsController],
  providers: [OperationsSettingsService, SchedulerSettingsService, SchedulerRunRegistry],
  exports: [OperationsSettingsService, SchedulerSettingsService, SchedulerRunRegistry],
})
export class OperationsSettingsModule {}
