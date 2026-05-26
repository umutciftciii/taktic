import { Module } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [HealthModule, PrismaModule],
})
export class AppModule {}
