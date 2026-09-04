import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminSupportTicketsController } from './admin-support-tickets.controller';
import { AdminSupportTicketsService } from './admin-support-tickets.service';
import { CustomerSupportTicketsController } from './customer-support-tickets.controller';
import { CustomerSupportTicketsService } from './customer-support-tickets.service';

/**
 * One module, two role surfaces.
 *
 * The controllers and services are separate all the way down — see either
 * controller for why — but the transition table, the text rules and the shared
 * append live in one place, so the two sides cannot disagree about what a
 * message is or which statuses take one.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [CustomerSupportTicketsController, AdminSupportTicketsController],
  providers: [CustomerSupportTicketsService, AdminSupportTicketsService],
})
export class SupportTicketsModule {}
