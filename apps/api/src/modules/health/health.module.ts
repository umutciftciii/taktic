import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';

@Module({
  controllers: [HealthController],
  providers: [ReadinessService],
  // ADMIN-SYSTEM-HEALTH-001 reads the same probe for its database row.
  exports: [ReadinessService],
})
export class HealthModule {}
