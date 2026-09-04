import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { AdminSupportTicketsService } from './admin-support-tickets.service';
import { CreateSupportTicketMessageDto } from './dto/create-support-ticket-message.dto';
import { ListSupportTicketsDto } from './dto/list-support-tickets.dto';
import { UpdateSupportTicketStatusDto } from './dto/update-support-ticket-status.dto';

/**
 * Support tickets, for the operator. SUPER_ADMIN only.
 *
 * A separate path prefix, a separate guard and a separate service from the
 * customer's routes, on purpose: nothing an operator may do is reachable by
 * widening a customer endpoint, and nothing a customer may do is reachable by
 * calling an admin one. AuthGuard turns an anonymous call into 401 and
 * RolesGuard turns a customer's or a provider's into 403 — no other role
 * reaches the service.
 *
 * Note what this controller does not have. There is no create route, so an
 * operator cannot open a ticket in somebody else's name; no route accepts a
 * customer id, so an operator cannot move a ticket to another owner; and there
 * is no delete, so nothing here can remove what was said.
 */
@Controller('admin/support/tickets')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminSupportTicketsController {
  constructor(
    @Inject(AdminSupportTicketsService) private readonly tickets: AdminSupportTicketsService,
  ) {}

  @Get()
  listTickets(@Query() query: ListSupportTicketsDto) {
    return this.tickets.listTickets(query);
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

  /**
   * Moves the ticket to another status.
   *
   * 200 rather than 201: nothing is created that the caller addressed — the same
   * ticket comes back in its new state, with the transition now on its
   * timeline.
   */
  @Post(':ticketId/status')
  @HttpCode(200)
  changeStatus(
    @Param('ticketId') ticketId: string,
    @Body() dto: UpdateSupportTicketStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tickets.changeStatus(ticketId, user, dto.status);
  }
}
