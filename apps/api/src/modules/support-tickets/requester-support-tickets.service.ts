import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  SupportTicketAuthorRole,
  SupportTicketRequesterRole,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import {
  supportTicketSelect,
  toSupportTicketMessage,
  toSupportTicketSummary,
  toSupportTicketTimeline,
} from './support-ticket.projection';
import { REQUESTER_WRITABLE_STATUSES } from './support-ticket.rules';
import { normalizeSupportTicketBody, normalizeSupportTicketSubject } from './support-ticket.text';
import { appendSupportTicketMessage, readSupportTicketTimeline } from './support-ticket.writes';

/**
 * Support tickets, from the side of whoever opened one.
 *
 * One service for hizmet alan and hizmet veren, because they are one product:
 * the same subject, the same timeline, the same status rules and the same
 * refusals. What differs between them is a single value — which desk the ticket
 * is filed at — and that value is derived from the session here, in
 * {@link requesterRoleOf}, rather than accepted from anybody.
 *
 * The rule this service exists to enforce: **a ticket belongs to the account
 * that opened it, on the desk it was opened at, and both come from the session
 * rather than from the URL.** Every read below carries `requesterId: user.id`
 * *and* the caller's own `requesterRole` inside the `where` clause rather than
 * fetching a row and comparing afterwards, so there is no post-filter to forget
 * and no branch in which somebody else's ticket has already been loaded into
 * memory. A caller who guesses another account's ticket id gets the same 404 as
 * one who invents an id outright — and so does a customer who guesses a
 * provider's, which is the cross-role rule: the two are indistinguishable on
 * purpose, because "this exists, you may not see it" tells a stranger that it
 * exists.
 *
 * The role predicate is not redundant with the id one. An account holds exactly
 * one role today, so `requesterId` alone would already scope correctly; the
 * role is carried as well so that if an account's role is ever changed, its old
 * tickets stay on the desk they were opened at instead of following the account
 * onto the other side's routes.
 *
 * What this service deliberately never accepts: an owner, a requester role, an
 * author, a status, or a ticket id in a request body. What it never returns:
 * another account's ticket, anything about which operator answered beyond "the
 * support team", or any account, payment or security fact that is not the
 * ticket itself.
 */
@Injectable()
export class RequesterSupportTicketsService {
  private readonly logger = new Logger(RequesterSupportTicketsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /** The caller's own tickets, most recent activity first. Never anybody else's. */
  async listTickets(user: AuthUser) {
    const tickets = await this.prisma.supportTicket.findMany({
      where: requesterScope(user),
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
   *
   * The desk and the author role are both taken from the session's role, so a
   * hizmet veren's ticket is filed as a hizmet veren's and its first message
   * reads as one, without either fact ever passing through a request body.
   */
  async createTicket(user: AuthUser, input: { subject: string; message: string }) {
    const requesterRole = this.requireRequesterRole(user);
    const subject = normalizeSupportTicketSubject(input.subject);
    const body = normalizeSupportTicketBody(input.message);
    const now = new Date();

    const ticket = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: {
          // From the session, both of them. There is no code path in this module
          // through which a caller can name the owner of a ticket or the desk it
          // is filed at.
          requesterId: user.id,
          requesterRole,
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
          authorRole: authorRoleFor(requesterRole),
          body,
          createdAt: now,
        },
      });

      return created;
    });

    // After the commit, and best-effort. The ticket exists and its owner has
    // been shown it, so a broken transport must not turn an opened ticket into
    // a failed submission — and a rolled-back transaction never reaches this
    // line at all, which is what keeps NotificationLog free of messages about
    // tickets that do not exist.
    await this.notify(() => this.mail.sendSupportTicketOpened(ticket.id), `ticket ${ticket.id}`);

    return toSupportTicketSummary(ticket);
  }

  /** One of the caller's own tickets, with its whole timeline. */
  async getTicket(ticketId: string, user: AuthUser) {
    const ticket = await this.loadOwnTicket(ticketId, user);
    const [messages, statusChanges] = await readSupportTicketTimeline(this.prisma, ticket.id);

    return {
      ...toSupportTicketSummary(ticket),
      canReply: REQUESTER_WRITABLE_STATUSES.includes(ticket.status),
      timeline: toSupportTicketTimeline(messages, statusChanges, user.id),
    };
  }

  /**
   * Adds one message to a ticket the caller owns.
   *
   * Ownership is settled first and by the same scoped query every read uses, so
   * nobody can write into a ticket they cannot read. The status rule is settled
   * second and inside the transaction that writes the row — see
   * {@link appendSupportTicketMessage} — because between deciding and writing
   * an operator may have closed the ticket.
   */
  async addMessage(ticketId: string, user: AuthUser, input: { body: string }) {
    const ticket = await this.loadOwnTicket(ticketId, user);
    const body = normalizeSupportTicketBody(input.body);

    const message = await appendSupportTicketMessage(this.prisma, {
      ticketId: ticket.id,
      authorUserId: user.id,
      // The ticket's own snapshot rather than the session's role. They agree —
      // the scoped load above would not have returned this row otherwise — and
      // preferring the row means the message is stamped with the desk the
      // conversation actually belongs to.
      authorRole: authorRoleFor(ticket.requesterRole),
      body,
      writableStatuses: REQUESTER_WRITABLE_STATUSES,
    });

    // The support mailbox hears; the person does not need to be told what they
    // just wrote. Keyed on the message, so a ticket with four replies produces
    // four notices and a replay of any one of them produces none.
    await this.notify(
      () => this.mail.sendSupportTicketRequesterMessage(message.id),
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
   * Loads a ticket the caller really owns, on their own desk.
   *
   * Both halves of the ownership predicate are in the `where`, so a caller who
   * owns nothing here — including one looking at the other role's ticket — gets
   * the same 404 as one who named a ticket that does not exist.
   */
  private async loadOwnTicket(ticketId: string, user: AuthUser) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, ...requesterScope(user) },
      select: supportTicketSelect,
    });

    if (!ticket) {
      throw new NotFoundException('Support ticket not found');
    }

    return ticket;
  }

  /**
   * The desk this caller opens tickets at.
   *
   * Only reached by the create path, which is the one operation with no ticket
   * to read the answer off. The guard has already refused every role but the
   * two below, so the throw is the unreachable branch that keeps the type
   * honest rather than a case anybody meets.
   */
  private requireRequesterRole(user: AuthUser): SupportTicketRequesterRole {
    const role = requesterRoleOf(user);

    if (!role) {
      throw new NotFoundException('Support ticket not found');
    }

    return role;
  }
}

/**
 * Which desk an account belongs to, or null for one that has none.
 *
 * A SUPER_ADMIN has none, deliberately: an operator answers tickets and owns
 * none, and the admin routes are where that is expressed. Returning null rather
 * than throwing lets {@link requesterScope} turn it into "matches no row",
 * which is the correct answer to an operator who reached a requester route —
 * the same nothing a stranger gets.
 */
function requesterRoleOf(user: AuthUser): SupportTicketRequesterRole | null {
  if (user.role === UserRole.CUSTOMER) return SupportTicketRequesterRole.CUSTOMER;
  if (user.role === UserRole.PROVIDER) return SupportTicketRequesterRole.PROVIDER;
  return null;
}

/** How a message from each desk is stamped. */
function authorRoleFor(role: SupportTicketRequesterRole): SupportTicketAuthorRole {
  return role === SupportTicketRequesterRole.PROVIDER
    ? SupportTicketAuthorRole.PROVIDER
    : SupportTicketAuthorRole.CUSTOMER;
}

/**
 * The ownership predicate: this account, on this account's own desk.
 *
 * The role is part of it rather than assumed from the guard, for the reason the
 * messaging module gives: an account can only ever match the desk it opened a
 * ticket at, so an account whose role changed cannot silently keep reaching an
 * old ticket through the other side's route. A role with no desk at all —
 * SUPER_ADMIN — matches no row, which is the correct answer here rather than an
 * exception, because an operator reading tickets has its own routes with its
 * own guard.
 */
function requesterScope(user: AuthUser): Prisma.SupportTicketWhereInput {
  const requesterRole = requesterRoleOf(user);

  if (!requesterRole) {
    return { id: { in: [] } };
  }

  return { requesterId: user.id, requesterRole };
}
