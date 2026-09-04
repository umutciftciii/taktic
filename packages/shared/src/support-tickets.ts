import limits from '../limits.json';

/**
 * The two lengths a support ticket is written under.
 *
 * Counted the way both sides of the wire count it: JavaScript's `string.length`
 * (UTF-16 code units). That is what `@MaxCodeUnitLength` on the DTOs measures,
 * what an `<input maxLength>` applies in the browser, and what the counter
 * beside the composer reports — so the number on screen and the server's answer
 * can never disagree, emoji included.
 *
 * The values live in `packages/shared/limits.json` rather than here for the
 * reason spelled out in `./service-requests.ts`: the API is compiled to
 * CommonJS and cannot `require` this package at runtime, so it reads the same
 * JSON directly (see `apps/api/src/common/support-ticket-limits.ts`). One
 * literal, two readers, no duplicated number.
 */

/**
 * The longest subject a ticket may carry.
 *
 * A subject is a headline — it is what the customer's list and the admin's
 * table show in one line — so 120 characters is generous for a sentence and
 * short of a length that would turn either list into prose.
 */
export const SUPPORT_TICKET_SUBJECT_MAX_LENGTH = limits.supportTicketSubjectMaxLength;

/**
 * The longest a single ticket message may be — the opening one included.
 *
 * The same two thousand characters post-match messaging runs under, and for the
 * same reason: several paragraphs is enough to describe a problem, and far
 * short of a size at which storing or rendering a conversation becomes a
 * different problem.
 */
export const SUPPORT_TICKET_MESSAGE_MAX_LENGTH = limits.supportTicketMessageMaxLength;
