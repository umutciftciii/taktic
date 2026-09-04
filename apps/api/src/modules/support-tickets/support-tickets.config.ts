import {
  SUPPORT_TICKET_MESSAGE_MAX_LENGTH,
  SUPPORT_TICKET_SUBJECT_MAX_LENGTH,
} from '../../common/support-ticket-limits';

/**
 * The limits and page sizes support tickets run under.
 *
 * The two lengths are re-exported from `common/support-ticket-limits.ts` rather
 * than restated, so this module and the customer's own screens are reading one
 * number out of `packages/shared/limits.json`. Everything else here is a
 * server-side page bound with no client counterpart.
 */
export { SUPPORT_TICKET_MESSAGE_MAX_LENGTH, SUPPORT_TICKET_SUBJECT_MAX_LENGTH };

/** How many tickets one page of the admin list carries by default. */
export const SUPPORT_TICKET_PAGE_DEFAULT_SIZE = 25;

/** And the most a caller may ask for, so a page cannot become "all of them". */
export const SUPPORT_TICKET_PAGE_MAX_SIZE = 100;

/**
 * Refusal code for a write aimed at a ticket that is no longer taking them.
 *
 * A single code for both sides: a customer writing to a resolved ticket and an
 * admin writing to a closed one are the same rule — the conversation is over —
 * and the message that comes with it says which state the ticket is actually
 * in.
 */
export const SUPPORT_TICKET_NOT_WRITABLE_CODE = 'SUPPORT_TICKET_NOT_WRITABLE';

/** Refusal code for a status change the transition table does not allow. */
export const SUPPORT_TICKET_INVALID_TRANSITION_CODE = 'SUPPORT_TICKET_INVALID_TRANSITION';
