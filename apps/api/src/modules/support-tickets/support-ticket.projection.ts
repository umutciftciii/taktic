import { Prisma, SupportTicketAuthorRole, SupportTicketStatus } from '@prisma/client';

/**
 * What a ticket, a message and a status change look like on the wire.
 *
 * Two audiences read these projections and they are not given the same thing.
 * A customer's ticket carries no customer block at all — they know who they
 * are, and repeating their own name and address in a payload only widens what a
 * leaked response would say. The admin's carries exactly the identity an
 * operator needs to answer: the account's name and e-mail, which every other
 * admin screen already shows.
 *
 * Neither carries a password hash, a session, a token, a phone verification, a
 * payment fact or anything at all about another customer. The selects below are
 * explicit for that reason: a `select` that lists its columns cannot silently
 * start returning a column somebody adds to the table later.
 */

export const supportTicketMessageSelect = {
  id: true,
  ticketId: true,
  authorUserId: true,
  authorRole: true,
  body: true,
  createdAt: true,
} satisfies Prisma.SupportTicketMessageSelect;

type SupportTicketMessageRow = Prisma.SupportTicketMessageGetPayload<{
  select: typeof supportTicketMessageSelect;
}>;

export const supportTicketStatusChangeSelect = {
  id: true,
  ticketId: true,
  fromStatus: true,
  toStatus: true,
  createdAt: true,
} satisfies Prisma.SupportTicketStatusChangeSelect;

type SupportTicketStatusChangeRow = Prisma.SupportTicketStatusChangeGetPayload<{
  select: typeof supportTicketStatusChangeSelect;
}>;

export const supportTicketSelect = {
  id: true,
  subject: true,
  status: true,
  lastActivityAt: true,
  resolvedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SupportTicketSelect;

type SupportTicketRow = Prisma.SupportTicketGetPayload<{ select: typeof supportTicketSelect }>;

/** The same row, plus the owner an operator needs in order to answer. */
export const adminSupportTicketSelect = {
  ...supportTicketSelect,
  customerId: true,
  customer: { select: { id: true, name: true, email: true } },
} satisfies Prisma.SupportTicketSelect;

type AdminSupportTicketRow = Prisma.SupportTicketGetPayload<{
  select: typeof adminSupportTicketSelect;
}>;

export type SupportTicketTimelineEntry =
  | {
      kind: 'MESSAGE';
      id: string;
      authorRole: SupportTicketAuthorRole;
      /** True when this message was written by the account reading it. */
      mine: boolean;
      body: string;
      createdAt: string;
    }
  | {
      kind: 'STATUS_CHANGE';
      id: string;
      fromStatus: SupportTicketStatus | null;
      toStatus: SupportTicketStatus;
      createdAt: string;
    };

export function toSupportTicketSummary(ticket: SupportTicketRow) {
  return {
    id: ticket.id,
    subject: ticket.subject,
    status: ticket.status,
    lastActivityAt: ticket.lastActivityAt.toISOString(),
    resolvedAt: ticket.resolvedAt ? ticket.resolvedAt.toISOString() : null,
    closedAt: ticket.closedAt ? ticket.closedAt.toISOString() : null,
    createdAt: ticket.createdAt.toISOString(),
  };
}

/**
 * The admin list row.
 *
 * `customer.name` may be null — an account created for a guest request has no
 * name until somebody fills one in — and the projection says so rather than
 * inventing a placeholder, so the screen can decide what to print.
 */
export function toAdminSupportTicketSummary(ticket: AdminSupportTicketRow) {
  return {
    ...toSupportTicketSummary(ticket),
    customer: {
      id: ticket.customer.id,
      name: ticket.customer.name,
      email: ticket.customer.email,
    },
  };
}

/**
 * The permanent timeline: every message and every status change this ticket has
 * ever carried, in one list, oldest first.
 *
 * Merged here rather than on either screen so both read the same order, and
 * discriminated by `kind` so a status change can never be mistaken for
 * something somebody wrote. `(createdAt, id)` is the sort, which is the order
 * both underlying indexes are built in — so two entries written in the same
 * millisecond still have exactly one order, and both screens agree on it.
 */
export function toSupportTicketTimeline(
  messages: SupportTicketMessageRow[],
  statusChanges: SupportTicketStatusChangeRow[],
  viewerUserId: string,
): SupportTicketTimelineEntry[] {
  const entries: SupportTicketTimelineEntry[] = [
    ...messages.map((message): SupportTicketTimelineEntry => ({
      kind: 'MESSAGE',
      id: message.id,
      authorRole: message.authorRole,
      mine: message.authorUserId === viewerUserId,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    })),
    ...statusChanges.map((change): SupportTicketTimelineEntry => ({
      kind: 'STATUS_CHANGE',
      id: change.id,
      fromStatus: change.fromStatus,
      toStatus: change.toStatus,
      createdAt: change.createdAt.toISOString(),
    })),
  ];

  return entries.sort((a, b) => {
    if (a.createdAt === b.createdAt) {
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

export function toSupportTicketMessage(message: SupportTicketMessageRow, viewerUserId: string) {
  return {
    id: message.id,
    ticketId: message.ticketId,
    authorRole: message.authorRole,
    mine: message.authorUserId === viewerUserId,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
  };
}
