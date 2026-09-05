import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminSupportTicketsController } from './admin-support-tickets.controller';
import { AdminSupportTicketsService } from './admin-support-tickets.service';
import { RequesterSupportTicketsController } from './requester-support-tickets.controller';
import { RequesterSupportTicketsService } from './requester-support-tickets.service';

/**
 * One module, two surfaces: the desk, and the people who write to it.
 *
 * The split is by *authority*, not by marketplace role. Hizmet alan and hizmet
 * veren share one controller and one service because they are the same product
 * with a different sidebar around it; the operator has its own of both, because
 * an operator reads every ticket and owns none. The transition table, the text
 * rules and the shared append live in one place regardless, so no side can
 * disagree about what a message is or which statuses take one.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [RequesterSupportTicketsController, AdminSupportTicketsController],
  providers: [RequesterSupportTicketsService, AdminSupportTicketsService],
})
export class SupportTicketsModule {}
