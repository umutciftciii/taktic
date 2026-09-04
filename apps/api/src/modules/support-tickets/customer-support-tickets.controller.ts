import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { CustomerSupportTicketsService } from './customer-support-tickets.service';
import { CreateSupportTicketMessageDto } from './dto/create-support-ticket-message.dto';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';

/**
 * The customer's own support tickets. CUSTOMER only, and only their own.
 *
 * The role guard is deliberately exactly one role wide. A SUPER_ADMIN is not
 * among them and must not be: an operator reading tickets has its own routes
 * under `/admin/support/tickets` with their own guard and their own service, so
 * "which rules apply" is answered by which route was called rather than by a
 * branch inside a shared handler. Widening this list would be the quiet way an
 * admin ends up subject to the customer rules — including the ownership scope,
 * which would silently return them nothing and read as a bug rather than as the
 * design.
 *
 * The role guard is also only the outer ring. The real check is the ownership
 * scope the service puts in every query: a CUSTOMER who is not *this* ticket's
 * owner gets the same 404 as somebody who invented the id.
 */
@Controller('support/tickets')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.CUSTOMER)
export class CustomerSupportTicketsController {
  constructor(
    @Inject(CustomerSupportTicketsService)
    private readonly tickets: CustomerSupportTicketsService,
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
