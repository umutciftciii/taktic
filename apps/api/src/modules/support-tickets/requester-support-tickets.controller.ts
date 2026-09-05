import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { CreateSupportTicketMessageDto } from './dto/create-support-ticket-message.dto';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { RequesterSupportTicketsService } from './requester-support-tickets.service';

/**
 * A person's own support tickets. The two marketplace roles, and only their own.
 *
 * One surface for hizmet alan and hizmet veren rather than two, because they
 * are the same product seen from two panels: the same composer, the same
 * timeline, the same refusals. Two controllers would have been two copies of
 * this file drifting, and a second path prefix that had to be kept in step with
 * the first.
 *
 * The two roles are still completely separated, just not by routing. The
 * service's ownership scope carries the caller's own desk in every `where`, so
 * a CUSTOMER asking for a PROVIDER's ticket matches no row and is told the same
 * nothing as somebody who invented the id — see
 * {@link RequesterSupportTicketsService}.
 *
 * A SUPER_ADMIN is deliberately not among the roles here and must not be: an
 * operator reading tickets has its own routes under `/admin/support/tickets`
 * with their own guard and their own service, so "which rules apply" is
 * answered by which route was called rather than by a branch inside a shared
 * handler. Widening this list would be the quiet way an admin ends up subject
 * to the ownership scope, which would silently return them nothing and read as
 * a bug rather than as the design.
 */
@Controller('support/tickets')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.CUSTOMER, UserRole.PROVIDER)
export class RequesterSupportTicketsController {
  constructor(
    @Inject(RequesterSupportTicketsService)
    private readonly tickets: RequesterSupportTicketsService,
  ) {}

  @Get()
  listTickets(@CurrentUser() user: AuthUser) {
    return this.tickets.listTickets(user);
  }

  @Post()
  createTicket(@Body() dto: CreateSupportTicketDto, @CurrentUser() user: AuthUser) {
    return this.tickets.createTicket(user, { subject: dto.subject, message: dto.message });
  }

  @Get(':ticketId')
  getTicket(@Param('ticketId') ticketId: string, @CurrentUser() user: AuthUser) {
    return this.tickets.getTicket(ticketId, user);
  }

  @Post(':ticketId/messages')
  addMessage(
    @Param('ticketId') ticketId: string,
    @Body() dto: CreateSupportTicketMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tickets.addMessage(ticketId, user, { body: dto.body });
  }
}
