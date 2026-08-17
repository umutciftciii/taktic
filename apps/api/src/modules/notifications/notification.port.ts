/**
 * Transport-agnostic outbound notification contract.
 *
 * Only the port and a development console adapter exist in this phase; picking
 * and wiring a real provider is a later phase. Call sites depend on this
 * abstract class so swapping the adapter never touches business code.
 */
export type NotificationTemplate = 'customer-activation';

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
