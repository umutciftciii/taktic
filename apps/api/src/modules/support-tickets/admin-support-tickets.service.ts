import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  SupportTicketAuthorRole,
  SupportTicketRequesterRole,
  SupportTicketStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
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
 *   - There is no create. An operator cannot open a ticket in somebody else's
 *     name, because there is no method and no route that would let them.
 *   - There is no way to change a ticket's owner or the desk it sits on.
 *     `requesterId` and `requesterRole` are written once, by the owner's own
 *     create, and nothing in this file writes either.
 *   - There is no delete, for a ticket or for a message. The record is the
 *     product.
 *
 * Nothing here logs a subject, a message body, an address or a name. The
 * timeline is returned to the caller and goes nowhere else.
 */
@Injectable()
export class AdminSupportTicketsService {
  private readonly logger = new Logger(AdminSupportTicketsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /**
   * Every ticket, newest activity first, optionally narrowed to a set of
   * statuses.
   *
   * A set rather than a single status because the two ends of the product
   * disagreed otherwise: the dashboard's "açık destek talepleri" card counts
   * the backlog — OPEN and IN_PROGRESS together — and a link that could only
   * name one of them sent the operator to a list that was missing the other
   * half of the number they had just read.
   *
   * One status is the same query with a one-element set, so `?status=OPEN`
   * still means exactly what it always did.
   *
   * Paged rather than complete: the list is the operator's queue and a queue
   * that returns every ticket ever opened stops being usable long before it
   * stops being answerable.
   *
   * `requesterRole` narrows the same queue to one side of the marketplace. It
   * is a filter and nothing more — one queue holds both desks, so an operator
   * answering a hizmet veren does it on the screen they already know, and
   * nothing can fall between two lists because there is only one.
   */
  async listTickets(filters: ListSupportTicketsDto) {
    const page = filters.page ?? 1;
    const pageSize = clampPageSize(filters.pageSize);
    const statuses = filters.status ?? [];
    const requesterRole = filters.requesterRole;

    // The desk filter is separate from the status one and applies to the counts
    // as well as to the rows — see below.
    const deskWhere: Prisma.SupportTicketWhereInput = requesterRole ? { requesterRole } : {};
    const where: Prisma.SupportTicketWhereInput = {
      ...deskWhere,
      ...(statuses.length ? { status: { in: statuses } } : {}),
    };

    const [total, rows, statusCounts, requesterRoleCounts] = await Promise.all([
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
      // Scoped to the chosen desk on purpose. These numbers are printed on the
      // status filter's own options, so a queue narrowed to hizmet verenler
      // whose chips still counted every customer's ticket would be a screen
      // whose filter and whose numbers described two different lists.
      this.countByStatus(deskWhere),
      // Not scoped, and for the mirror-image reason: these numbers are printed
      // on the desk filter's own options, and an option that counted only the
      // desk already chosen would always read as the total.
      this.countByRequesterRole(statuses),
    ]);

    return {
      items: rows.map(toAdminSupportTicketSummary),
      total,
      page,
      pageSize,
      hasNextPage: page * pageSize < total,
      /** The counts behind the status filter's chips, for every status. */
      statusCounts,
      /** And behind the desk filter's, for both sides of the marketplace. */
      requesterRoleCounts,
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

    // The customer hears, and hears nothing about who answered — see
    // TransactionalMailService.sendSupportTicketAdminMessage, which never reads
    // the author.
    await this.notify(
      () => this.mail.sendSupportTicketAdminMessage(message.id),
      `message ${message.id}`,
    );

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

    const statusChangeId = await this.prisma.$transaction(async (tx) => {
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

      const change = await tx.supportTicketStatusChange.create({
        data: {
          ticketId: ticket.id,
          fromStatus: ticket.status,
          toStatus: next,
          changedById: user.id,
          createdAt: now,
        },
        select: { id: true },
      });

      return change.id;
    });

    // After the commit, and keyed on the recorded change. A transition the
    // table refused wrote no row and reaches no line below; a transaction that
    // rolled back returns no id.
    await this.notify(
      () => this.mail.sendSupportTicketStatusChanged(statusChangeId),
      `status change ${statusChangeId}`,
    );

    return this.getTicket(ticket.id, user);
  }

  /**
   * Runs a notification without letting it undo what already happened.
   *
   * The log entry names an id and never a subject, a body or an address: the
   * whole module keeps a ticket's text out of stdout, and a notification
   * failure is not the place to start writing it there.
   */
  private async notify(run: () => Promise<unknown>, subject: string) {
    try {
      await run();
    } catch (error) {
      this.logger.error(
        `Failed to send a support notification for ${subject}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
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

  /**
   * One grouped count, so the status filter can say how much is behind each
   * option — within whichever desk the operator is currently looking at.
   *
   * Every status is present with a zero rather than omitted, because a missing
   * key and a zero read the same on a screen and only one of them is a number
   * this method actually established.
   */
  private async countByStatus(where: Prisma.SupportTicketWhereInput) {
    const grouped = await this.prisma.supportTicket.groupBy({
      by: ['status'],
      where,
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

  /**
   * The same, for the desk filter: how many tickets each side of the
   * marketplace has *under the status filter already applied*.
   *
   * The status filter is carried in and the desk filter is not, so the two
   * options answer the question an operator is actually asking when they read
   * them — "if I switch desks, how many of these am I looking at" — rather than
   * each quietly counting the list already on screen.
   */
  private async countByRequesterRole(statuses: readonly SupportTicketStatus[]) {
    const grouped = await this.prisma.supportTicket.groupBy({
      by: ['requesterRole'],
      where: statuses.length ? { status: { in: [...statuses] } } : {},
      _count: { _all: true },
    });

    const counts: Record<SupportTicketRequesterRole, number> = {
      [SupportTicketRequesterRole.CUSTOMER]: 0,
      [SupportTicketRequesterRole.PROVIDER]: 0,
    };

    for (const row of grouped) {
      counts[row.requesterRole] = row._count._all;
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
