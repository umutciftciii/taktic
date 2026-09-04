import type { TransactionalEmailTemplate } from './templates/transactional-templates';

/**
 * Transport-agnostic outbound notification contract.
 *
 * Call sites depend on this abstract class, so swapping the adapter — console in
 * development, the recording file outbox in the browser suite, Resend in a
 * delivering deployment — never touches business code.
 */
/**
 * Every message this application may send, taken from
 * {@link import('./templates/transactional-templates').TRANSACTIONAL_EMAIL_TEMPLATES}
 * so the union and the renderer's switch can never drift apart: adding an
 * identifier there is what makes it sendable here.
 *
 * Three of them used to be listed separately, because they predated the design
 * system and rendered through a plain renderer of their own. They are documents
 * in the same table as the rest now, with their wording, their variables, their
 * links and their expiry semantics unchanged:
 *
 * - `customer-activation` carries the single-use link that opens a guest
 *   customer's account.
 * - `provider-claim` invites the applicant behind a guest provider application
 *   to take ownership of it. It carries the single-use claim URL and nothing
 *   about the moderation outcome: an application that is still under review
 *   must not be described as accepted, and a claim never approves anything.
 * - `request-expiring` is the day-7 nudge for an approved request that has not
 *   received a single offer. It states that the request's window is running out
 *   and nothing more: it must never claim the request is "verified", and it
 *   must never promise that offers are coming.
 */
export type NotificationTemplate = TransactionalEmailTemplate;

export type NotificationMessage = {
  template: NotificationTemplate;
  /** Recipient e-mail address. */
  to: string;
  subject: string;
  /**
   * Template variables. `actionUrl` carries a single-use secret and is only
   * rendered by adapters that are allowed to see it (see ConsoleNotification
   * adapter for the development-only rules).
   */
  actionUrl?: string;
  data?: Record<string, string | null | undefined>;
  /**
   * Where a recipient's reply should go, when it is not the sender.
   *
   * Set on exactly one family of messages: the support-ticket notifications,
   * whose whole point is that the customer can answer them. Every message this
   * platform sends leaves from a no-reply sender, so without this header a
   * customer hitting "reply" on "destek talebinize yanıt verdik" would be
   * writing to nobody.
   *
   * It is an address this repository resolves (see
   * {@link import('../support-tickets/support-inbox.config').supportReplyToEmail}),
   * never anything a user supplied, and it is never stored on the audit row —
   * NotificationLog records no addresses but a masked recipient.
   */
  replyTo?: string;
  /**
   * A stable name for *this message*, handed to transports that can de-duplicate
   * on one.
   *
   * Derived from the NotificationLog row's id and nothing else, so it is the
   * same string on the first dispatch and on every later admin retry of that
   * row — which is exactly the property that matters. A send that timed out
   * after the provider had already accepted it is re-offered under the key it
   * was accepted with, and the provider answers with the original message
   * instead of delivering a second copy.
   *
   * It is an opaque identifier: no address, no template data, nothing derived
   * from the body.
   */
  idempotencyKey?: string;
};

/**
 * Mirrors {@link import('./sms.port').SmsSendResult}: the only thing an adapter
 * reports back is the provider's own identifier for the accepted message, which
 * is what support and reconciliation need. Adapters that deliver nothing return
 * null — there is no id to hand out — and no adapter may return anything else
 * about the message, because everything else is content.
 */
export type NotificationSendResult = {
  providerMessageId: string | null;
};

export abstract class NotificationPort {
  abstract send(message: NotificationMessage): Promise<NotificationSendResult>;
}
