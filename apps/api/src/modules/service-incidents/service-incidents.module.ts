import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminServiceIncidentsService } from './admin-service-incidents.service';
import { ProviderIncidentsService } from './provider-incidents.service';
import { ProviderReliabilityService } from './provider-reliability.service';
import {
  AdminProviderReliabilityController,
  AdminServiceIncidentsController,
  ProviderIncidentsController,
} from './service-incidents.controllers';

/**
 * REL-002 Faz 4: provider responses, staff adjudication (append-only, with
 * SUPER_ADMIN corrections) and provider reliability. Depends on nothing but
 * auth and the database (the outbox comes from the global notifications
 * module); nothing depends on it.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ProviderIncidentsController, AdminServiceIncidentsController, AdminProviderReliabilityController],
  providers: [ProviderIncidentsService, AdminServiceIncidentsService, ProviderReliabilityService],
})
export class ServiceIncidentsModule {}
