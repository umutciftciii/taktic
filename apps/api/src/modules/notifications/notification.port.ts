/**
 * Transport-agnostic outbound notification contract.
 *
 * Only the port and a development console adapter exist in this phase; picking
 * and wiring a real provider is a later phase. Call sites depend on this
 * abstract class so swapping the adapter never touches business code.
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
export type NotificationTemplate =
  | 'customer-activation'
  | 'request-expiring'
  | 'provider-claim';

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
};

export abstract class NotificationPort {
  abstract send(message: NotificationMessage): Promise<void>;
}
