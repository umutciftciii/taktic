import { Prisma, SupportTicketAuthorRole, SupportTicketStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SupportTicketNotWritableException } from './support-ticket.errors';
import { supportTicketMessageSelect } from './support-ticket.projection';

/**
 * The one write both sides share: appending a message to a ticket.
 *
 * It lives here rather than in either service because the two role services
 * must not drift on it. The customer's rule and the admin's rule differ only in
 * *which* statuses they pass in; everything else — the status check, the
 * activity mark, the transaction they happen in — is one behaviour, and one
 * behaviour should be one piece of code.
 *
 * The concurrency story is the whole reason this is a transaction rather than
 * two calls. The guarded `updateMany` is a compare-and-swap on the ticket's
 * status: it matches only while the ticket is still in a status this author may
 * write to, and PostgreSQL holds the row lock it takes until the transaction
 * commits. So an operator closing a ticket at the same moment a customer sends
 * a reply produces one of two outcomes and never a third — either the reply
 * lands and then the close does, or the close lands and the reply is refused —
 * and the ticket's `lastActivityAt` reflects whichever actually happened.
 */
export async function appendSupportTicketMessage(
  prisma: PrismaService,
  input: {
    ticketId: string;
    authorUserId: string;
    authorRole: SupportTicketAuthorRole;
    body: string;
    writableStatuses: readonly SupportTicketStatus[];
  },
) {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const guarded = await tx.supportTicket.updateMany({
      where: {
        id: input.ticketId,
        status: { in: [...input.writableStatuses] },
        // Monotonic: the activity mark only ever moves forwards, so two
        // near-simultaneous replies cannot leave the ticket claiming the older
        // of the two moments. The `count === 0` branch below tells the two
        // reasons this predicate can miss apart.
        lastActivityAt: { lte: now },
      },
      data: { lastActivityAt: now },
    });

    if (guarded.count !== 1) {
      // Either the ticket stopped taking messages, or it simply already carries
      // an activity mark newer than this write's clock. Only the first is a
      // refusal; the second means somebody else wrote a moment ago and this
      // message still belongs on the ticket.
      const current = await tx.supportTicket.findUnique({
        where: { id: input.ticketId },
        select: { status: true },
      });

      if (!current || !input.writableStatuses.includes(current.status)) {
        // `!current` is unreachable through either service — both load the
        // ticket first, and nothing in this product deletes one — so the CLOSED
        // fallback is a last resort rather than a case. It says "this ticket
        // takes no messages", which is true of a ticket that is not there.
        throw new SupportTicketNotWritableException(current?.status ?? SupportTicketStatus.CLOSED);
      }
    }

    return tx.supportTicketMessage.create({
      data: {
        ticketId: input.ticketId,
        authorUserId: input.authorUserId,
        authorRole: input.authorRole,
        body: input.body,
        createdAt: now,
      },
      select: supportTicketMessageSelect,
    });
  });
}

/**
 * The timeline of one ticket, read as two ordered queries.
 *
 * Both are bounded by the ticket id and ordered by `(createdAt, id)`, which is
 * exactly how their indexes are built. They are merged into one list by
 * {@link toSupportTicketTimeline}.
 */
export function readSupportTicketTimeline(prisma: PrismaService, ticketId: string) {
  return Promise.all([
    prisma.supportTicketMessage.findMany({
      where: { ticketId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: supportTicketMessageSelect,
    }),
    prisma.supportTicketStatusChange.findMany({
      where: { ticketId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        ticketId: true,
        fromStatus: true,
        toStatus: true,
        createdAt: true,
      } satisfies Prisma.SupportTicketStatusChangeSelect,
    }),
  ]);
}
