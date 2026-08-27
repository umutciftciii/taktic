import type { TransactionalEmailTemplate } from './templates/transactional-templates';

/**
 * Transport-agnostic outbound notification contract.
 *
 * Call sites depend on this abstract class, so swapping the adapter — console in
 * development, the recording file outbox in the browser suite, Resend in a
 * delivering deployment — never touches business code.
 */
/**
 * `request-expiring` is the day-7 nudge for an approved request that has not
 * received a single offer. It states that the request's window is running out
 * and nothing more: it must never claim the request is "verified", and it must
 * never promise that offers are coming.
 */
/**
 * `provider-claim` invites the applicant behind a guest provider application to
 * take ownership of it. It carries the single-use claim URL and nothing about
 * the moderation outcome: an application that is still under review must not be
 * described as accepted, and a claim never approves anything.
 */
/**
 * The twelve designed transactional messages live in
 * {@link import('./templates/transactional-templates').TRANSACTIONAL_EMAIL_TEMPLATES}
 * and are spread in below, so the union and the renderer's switch can never
 * drift apart: adding an identifier there is what makes it sendable here.
 *
 * The three names listed explicitly predate that set. They keep the plain
 * renderer in email-template.ts — same wording, same behaviour — because
 * re-skinning them is a product decision, not a side effect of this work.
 */
export type NotificationTemplate =
  | 'customer-activation'
  | 'request-expiring'
  | 'provider-claim'
  | TransactionalEmailTemplate;

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
