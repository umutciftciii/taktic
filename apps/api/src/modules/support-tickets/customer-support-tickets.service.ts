import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SupportTicketAuthorRole, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import {
  supportTicketSelect,
  toSupportTicketMessage,
  toSupportTicketSummary,
  toSupportTicketTimeline,
} from './support-ticket.projection';
import { CUSTOMER_WRITABLE_STATUSES } from './support-ticket.rules';
import { normalizeSupportTicketBody, normalizeSupportTicketSubject } from './support-ticket.text';
import { appendSupportTicketMessage, readSupportTicketTimeline } from './support-ticket.writes';

/**
 * Support tickets, from the customer's side.
 *
 * The single rule this service exists to enforce: **a ticket belongs to the
 * account that opened it, and the account is the session, not the URL.** Every
 * read below carries `customerId: user.id` inside the `where` clause rather
 * than fetching a row and comparing afterwards, so there is no post-filter to
 * forget and no branch in which somebody else's ticket has already been loaded
 * into memory. A customer who guesses another customer's id gets the same 404
 * as one who invents an id outright — the two are indistinguishable on purpose,
 * because "this exists, you may not see it" tells a stranger that a ticket
 * exists.
 *
 * What this service deliberately never accepts: an owner, an author, a status,
 * or a ticket id in a request body. What it never returns: another customer's
 * ticket, anything about who the answering operator is beyond "the support
 * team", or any account, payment or security fact that is not the ticket
 * itself.
 */
@Injectable()
export class CustomerSupportTicketsService {
  private readonly logger = new Logger(CustomerSupportTicketsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /** The caller's own tickets, most recent activity first. Never anybody else's. */
  async listTickets(user: AuthUser) {
    const tickets = await this.prisma.supportTicket.findMany({
      where: customerScope(user),
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      select: supportTicketSelect,
    });

    return tickets.map(toSupportTicketSummary);
  }

  /**
   * Opens a ticket.
   *
   * The subject and the opening message are written together, in one
   * transaction, so a ticket with no message is not a state this table can be
   * left in — not by a crash between two calls and not by a client that gave up
   * halfway. The opening message is an ordinary message row: it is the first
   * thing on the timeline rather than a column every reader would have to
   * remember to prepend.
   */
  async createTicket(user: AuthUser, input: { subject: string; message: string }) {
    const subject = normalizeSupportTicketSubject(input.subject);
    const body = normalizeSupportTicketBody(input.message);
    const now = new Date();

    const ticket = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: {
          // From the session. There is no code path in this module through
          // which a caller can name the owner of a ticket.
          customerId: user.id,
          subject,
          lastActivityAt: now,
          createdAt: now,
        },
        select: supportTicketSelect,
      });

      await tx.supportTicketMessage.create({
        data: {
          ticketId: created.id,
          authorUserId: user.id,
          authorRole: SupportTicketAuthorRole.CUSTOMER,
          body,
          createdAt: now,
        },
      });

      return created;
    });

    // After the commit, and best-effort. The ticket exists and the customer has
    // been shown it, so a broken transport must not turn an opened ticket into
    // a failed submission — and a rolled-back transaction never reaches this
    // line at all, which is what keeps NotificationLog free of messages about
    // tickets that do not exist.
    await this.notify(
      () => this.mail.sendSupportTicketOpened(ticket.id),
      `ticket ${ticket.id}`,
    );

    return toSupportTicketSummary(ticket);
  }

  /** One of the caller's own tickets, with its whole timeline. */
  async getTicket(ticketId: string, user: AuthUser) {
    const ticket = await this.loadOwnTicket(ticketId, user);
    const [messages, statusChanges] = await readSupportTicketTimeline(this.prisma, ticket.id);

    return {
      ...toSupportTicketSummary(ticket),
      canReply: CUSTOMER_WRITABLE_STATUSES.includes(ticket.status),
      timeline: toSupportTicketTimeline(messages, statusChanges, user.id),
    };
  }

  /**
   * Adds one message to a ticket the caller owns.
   *
   * Ownership is settled first and by the same scoped query every read uses, so
   * a customer cannot write into a ticket they cannot read. The status rule is
   * settled second and inside the transaction that writes the row — see
   * {@link appendSupportTicketMessage} — because between deciding and writing
   * an operator may have closed the ticket.
   */
  async addMessage(ticketId: string, user: AuthUser, input: { body: string }) {
    const ticket = await this.loadOwnTicket(ticketId, user);
    const body = normalizeSupportTicketBody(input.body);

    const message = await appendSupportTicketMessage(this.prisma, {
      ticketId: ticket.id,
      authorUserId: user.id,
      authorRole: SupportTicketAuthorRole.CUSTOMER,
      body,
      writableStatuses: CUSTOMER_WRITABLE_STATUSES,
    });

    // The support mailbox hears; the customer does not need to be told what
    // they just wrote. Keyed on the message, so a ticket with four replies
    // produces four notices and a replay of any one of them produces none.
    await this.notify(
      () => this.mail.sendSupportTicketCustomerMessage(message.id),
      `message ${message.id}`,
    );

    return toSupportTicketMessage(message, user.id);
  }

  /**
   * Runs a notification without letting it undo what already happened.
   *
   * The subject line of the log entry is an id, never a subject or a body: a
   * ticket's text is the one thing this module has always kept out of stdout.
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

  /**
   * Loads a ticket the caller really owns.
   *
   * The owner column is in the `where`, so a caller who owns nothing here gets
   * the same 404 as one who named a ticket that does not exist.
   */
  private async loadOwnTicket(ticketId: string, user: AuthUser) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, ...customerScope(user) },
      select: supportTicketSelect,
    });

    if (!ticket) {
      throw new NotFoundException('Support ticket not found');
    }

    return ticket;
  }
}

/**
 * The ownership predicate, role included.
 *
 * The role is part of it rather than assumed from the guard, for the reason the
 * messaging module gives: a CUSTOMER account can only ever match the customer
 * column, so an account whose role changed cannot silently keep reaching a
 * ticket through a customer route. Every other role matches no row at all —
 * which is the correct answer here rather than an exception, because an admin
 * reading customer tickets has its own routes with its own guard.
 */
function customerScope(user: AuthUser): Prisma.SupportTicketWhereInput {
  if (user.role !== UserRole.CUSTOMER) {
    return { id: { in: [] } };
  }

  return { customerId: user.id };
}
