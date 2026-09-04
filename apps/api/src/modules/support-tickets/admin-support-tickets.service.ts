import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SupportTicketAuthorRole, SupportTicketStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { ListSupportTicketsDto } from './dto/list-support-tickets.dto';
import { SupportTicketInvalidTransitionException } from './support-ticket.errors';
import {
  adminSupportTicketSelect,
  toAdminSupportTicketSummary,
  toSupportTicketMessage,
  toSupportTicketTimeline,
} from './support-ticket.projection';
import { ADMIN_WRITABLE_STATUSES, isAllowedTransition } from './support-ticket.rules';
import { normalizeSupportTicketBody } from './support-ticket.text';
import { appendSupportTicketMessage, readSupportTicketTimeline } from './support-ticket.writes';
import {
  SUPPORT_TICKET_PAGE_DEFAULT_SIZE,
  SUPPORT_TICKET_PAGE_MAX_SIZE,
} from './support-tickets.config';

/**
 * Support tickets, from the operator's side.
 *
 * Deliberately a separate service behind a separate controller and a separate
 * guard, rather than the customer service widened with an "if admin" branch.
 * The two have genuinely different rules — an operator reads every ticket and
 * owns none of them — and expressing that as a condition inside a query that is
 * otherwise the ownership check is how an ownership check stops being one.
 *
 * What an operator may do here is bounded by what this class exposes, and the
 * gaps are the point:
 *
 *   - There is no create. An operator cannot open a ticket in a customer's
 *     name, because there is no method and no route that would let them.
 *   - There is no way to change a ticket's owner. `customerId` is written once,
 *     by the customer's own create, and nothing in this file writes it.
 *   - There is no delete, for a ticket or for a message. The record is the
 *     product.
 *
 * Nothing here logs a subject, a message body, an address or a name. The
 * timeline is returned to the caller and goes nowhere else.
 */
@Injectable()
export class AdminSupportTicketsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Every ticket, newest activity first, optionally narrowed to one status.
   *
   * Paged rather than complete: the list is the operator's queue and a queue
   * that returns every ticket ever opened stops being usable long before it
   * stops being answerable.
   */
  async listTickets(filters: ListSupportTicketsDto) {
    const page = filters.page ?? 1;
    const pageSize = clampPageSize(filters.pageSize);
    const where: Prisma.SupportTicketWhereInput = filters.status ? { status: filters.status } : {};

    const [total, rows] = await Promise.all([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({
        where,
        // `id` breaks the tie so a page boundary cannot show the same ticket
        // twice when two share a millisecond of activity.
        orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: adminSupportTicketSelect,
      }),
    ]);

    return {
      items: rows.map(toAdminSupportTicketSummary),
      total,
      page,
      pageSize,
      hasNextPage: page * pageSize < total,
      /** The counts behind the status filter's chips, for every status. */
      statusCounts: await this.countByStatus(),
    };
  }

  /** One ticket, with its whole timeline and the owner who opened it. */
  async getTicket(ticketId: string, user: AuthUser) {
    const ticket = await this.loadTicket(ticketId);
    const [messages, statusChanges] = await readSupportTicketTimeline(this.prisma, ticket.id);

    return {
      ...toAdminSupportTicketSummary(ticket),
      canReply: ADMIN_WRITABLE_STATUSES.includes(ticket.status),
      /** Exactly the moves this ticket may make right now, and no others. */
      allowedTransitions: allowedTransitionsFor(ticket.status),
      timeline: toSupportTicketTimeline(messages, statusChanges, user.id),
    };
  }

  /** Adds one operator message. Refused on a CLOSED ticket, like the customer's. */
  async addMessage(ticketId: string, user: AuthUser, input: { body: string }) {
    const ticket = await this.loadTicket(ticketId);
    const body = normalizeSupportTicketBody(input.body);

    const message = await appendSupportTicketMessage(this.prisma, {
      ticketId: ticket.id,
      authorUserId: user.id,
      authorRole: SupportTicketAuthorRole.ADMIN,
      body,
      writableStatuses: ADMIN_WRITABLE_STATUSES,
    });

    return toSupportTicketMessage(message, user.id);
  }

  /**
   * Moves a ticket to another status, and records that it happened.
   *
   * Two checks, and the second is the one that holds under load. The
   * transition table is consulted against the status the row currently holds —
   * never against a status the caller supplied, because there is no such field.
   * The write is then a compare-and-swap: `updateMany` matches only while the
   * ticket is *still* in that status, and PostgreSQL holds the row lock until
   * the transaction commits. Two operators resolving and closing the same
   * ticket at the same moment therefore produce one of the two orders and never
   * a ticket that is closed without a resolve on its timeline.
   *
   * `resolvedAt` and `closedAt` are stamped, never cleared: no transition in the
   * table leaves either state, so a cleared timestamp would be a fact the
   * product cannot produce.
   */
  async changeStatus(ticketId: string, user: AuthUser, next: SupportTicketStatus) {
    const ticket = await this.loadTicket(ticketId);

    if (!isAllowedTransition(ticket.status, next)) {
      throw new SupportTicketInvalidTransitionException(ticket.status, next);
    }

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      const swapped = await tx.supportTicket.updateMany({
        where: { id: ticket.id, status: ticket.status },
        data: {
          status: next,
          lastActivityAt: now,
          ...(next === SupportTicketStatus.RESOLVED ? { resolvedAt: now } : {}),
          ...(next === SupportTicketStatus.CLOSED ? { closedAt: now } : {}),
        },
      });

      if (swapped.count !== 1) {
        // Somebody moved it between the read and the write. Their transition is
        // the one that happened; this one is judged against a status the ticket
        // no longer holds, so it is refused rather than forced.
        const current = await tx.supportTicket.findUnique({
          where: { id: ticket.id },
          select: { status: true },
        });

        throw new SupportTicketInvalidTransitionException(current?.status ?? ticket.status, next);
      }

      await tx.supportTicketStatusChange.create({
        data: {
          ticketId: ticket.id,
          fromStatus: ticket.status,
          toStatus: next,
          changedById: user.id,
          createdAt: now,
        },
      });
    });

    return this.getTicket(ticket.id, user);
  }

  private async loadTicket(ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: adminSupportTicketSelect,
    });

    if (!ticket) {
      throw new NotFoundException('Support ticket not found');
    }

    return ticket;
  }

  /** One grouped count, so the filter can say how much is behind each option. */
  private async countByStatus() {
    const grouped = await this.prisma.supportTicket.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    const counts: Record<SupportTicketStatus, number> = {
      [SupportTicketStatus.OPEN]: 0,
      [SupportTicketStatus.IN_PROGRESS]: 0,
      [SupportTicketStatus.RESOLVED]: 0,
      [SupportTicketStatus.CLOSED]: 0,
    };

    for (const row of grouped) {
      counts[row.status] = row._count._all;
    }

    return counts;
  }
}

function allowedTransitionsFor(status: SupportTicketStatus): SupportTicketStatus[] {
  return Object.values(SupportTicketStatus).filter((candidate) =>
    isAllowedTransition(status, candidate),
  );
}

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return SUPPORT_TICKET_PAGE_DEFAULT_SIZE;
  }

  return Math.min(Math.max(Math.trunc(value), 1), SUPPORT_TICKET_PAGE_MAX_SIZE);
}
