import { SupportTicketStatus } from '@prisma/client';

/**
 * The whole life of a ticket, as a table rather than a chain of `if`s.
 *
 * Written out exhaustively and keyed by the status a ticket is *in*, so the set
 * of legal moves is readable in one glance and a new status cannot be added
 * without deciding what it may become. Every transition below is an operator's
 * to make; a customer has none.
 *
 *   OPEN        ↔ IN_PROGRESS   picking a ticket up, and putting it back down
 *   OPEN        → RESOLVED      answered without ever being taken in hand
 *   IN_PROGRESS → RESOLVED      answered
 *   RESOLVED    → CLOSED        filed away
 *   CLOSED      → (nothing)     terminal, deliberately
 *
 * CLOSED being terminal is the one rule worth stating twice: a customer who
 * needs more help opens a new ticket. Re-opening would let one row accumulate
 * two unrelated problems and would make "what did we answer, and when" a
 * question the timeline could no longer settle.
 *
 * A transition to the status a ticket already has is not in the table either.
 * It is not harmful, but it is not a change, and recording it would put rows on
 * the permanent timeline that say nothing happened.
 */
export const SUPPORT_TICKET_TRANSITIONS: Readonly<
  Record<SupportTicketStatus, readonly SupportTicketStatus[]>
> = {
  [SupportTicketStatus.OPEN]: [SupportTicketStatus.IN_PROGRESS, SupportTicketStatus.RESOLVED],
  [SupportTicketStatus.IN_PROGRESS]: [SupportTicketStatus.OPEN, SupportTicketStatus.RESOLVED],
  [SupportTicketStatus.RESOLVED]: [SupportTicketStatus.CLOSED],
  [SupportTicketStatus.CLOSED]: [],
};

export function isAllowedTransition(from: SupportTicketStatus, to: SupportTicketStatus): boolean {
  return SUPPORT_TICKET_TRANSITIONS[from].includes(to);
}

/**
 * The statuses a **customer** may add a message to.
 *
 * A resolved or closed ticket is one the operator has answered; the customer's
 * screen says so and offers a new ticket instead of a composer. Enforced here
 * rather than only on screen, because the composer is not the only way to POST.
 */
export const CUSTOMER_WRITABLE_STATUSES: readonly SupportTicketStatus[] = [
  SupportTicketStatus.OPEN,
  SupportTicketStatus.IN_PROGRESS,
];

/**
 * The statuses an **admin** may add a message to.
 *
 * Wider than the customer's by exactly one: an operator may still write on a
 * RESOLVED ticket, because "here is the detail I promised" belongs on the
 * ticket it answers rather than on a new one. CLOSED takes no message from
 * anybody — that is what closing it means.
 */
export const ADMIN_WRITABLE_STATUSES: readonly SupportTicketStatus[] = [
  SupportTicketStatus.OPEN,
  SupportTicketStatus.IN_PROGRESS,
  SupportTicketStatus.RESOLVED,
];
