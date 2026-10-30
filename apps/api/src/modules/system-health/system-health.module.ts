import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { HealthModule } from '../health/health.module';
import { OperationsSettingsModule } from '../operations-settings/operations-settings.module';
import { SystemHealthController } from './system-health.controller';
import { SystemHealthService } from './system-health.service';

@Module({
  imports: [PrismaModule, AuthModule, HealthModule, OperationsSettingsModule],
  controllers: [SystemHealthController],
  providers: [SystemHealthService],
})
export class SystemHealthModule {}
