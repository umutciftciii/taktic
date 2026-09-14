import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ProvidersModule } from '../providers/providers.module';
import { ProviderRequestReportsController } from './provider-request-reports.controller';
import { RequestReportsService } from './request-reports.service';

@Module({
  imports: [PrismaModule, AuthModule, ProvidersModule],
  controllers: [ProviderRequestReportsController],
  providers: [RequestReportsService],
  exports: [RequestReportsService],
})
export class RequestReportsModule {}
