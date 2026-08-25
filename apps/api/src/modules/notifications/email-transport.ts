import { isNotificationOutboxEnabled } from './notification-outbox';

/**
 * Which outbound e-mail transport this process is wired to.
 *
 * The point of naming them is the last predicate in this file. A feature whose
 * whole safety story is "the applicant proves they own the mailbox" is worthless
 * when nothing can reach that mailbox, so such a feature has to be able to ask
 * whether the process can actually deliver mail — not merely whether some
 * adapter is bound to NotificationPort.
 */
export const EMAIL_TRANSPORT_KINDS = ['console', 'file-outbox'] as const;

export type EmailTransportKind = (typeof EMAIL_TRANSPORT_KINDS)[number];

/**
 * The transports that put a message in a stranger's inbox.
 *
 * Empty on purpose: this repository ships no real e-mail provider. `console`
 * writes to the application log and refuses to print an action URL outside
 * development; `file-outbox` writes to disk for the browser suite and cannot be
 * enabled in production at all. Neither delivers anything.
 *
 * Wiring a provider later means adding its adapter, adding its kind to
 * {@link EMAIL_TRANSPORT_KINDS} and listing it here. Nothing else changes —
 * every boot check that consults this starts passing on its own.
 */
const DELIVERING_EMAIL_TRANSPORTS: ReadonlySet<EmailTransportKind> =
  new Set<EmailTransportKind>();

/** Mirrors the adapter NotificationsModule binds, read from the same switch. */
export function resolveEmailTransportKind(): EmailTransportKind {
  return isNotificationOutboxEnabled() ? 'file-outbox' : 'console';
}

export function isDeliveringEmailTransportConfigured(): boolean {
  return DELIVERING_EMAIL_TRANSPORTS.has(resolveEmailTransportKind());
}
