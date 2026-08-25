import { isNotificationOutboxEnabled } from './notification-outbox';
import { readResendConfig } from './resend.config';

/**
 * Which outbound e-mail transport this process is wired to.
 *
 * The set is a closed allow-list read from EMAIL_TRANSPORT. There is no
 * "whatever was in the variable" branch: an unrecognised value fails at boot
 * rather than silently falling back to a transport nobody chose.
 *
 * The point of naming the kinds is the last predicate in this file. A feature
 * whose whole safety story is "the applicant proves they own the mailbox" is
 * worthless when nothing can reach that mailbox, so such a feature has to be
 * able to ask whether the process can actually deliver mail — not merely
 * whether some adapter is bound to NotificationPort.
 */
export const EMAIL_TRANSPORT_KINDS = ['console', 'file-outbox', 'resend'] as const;

export type EmailTransportKind = (typeof EMAIL_TRANSPORT_KINDS)[number];

/**
 * The transports that put a message in a stranger's inbox.
 *
 * `console` writes to the application log and refuses to print an action URL
 * outside development; `file-outbox` writes to disk for the browser suite and
 * cannot be enabled in production at all. Neither delivers anything, so neither
 * is listed here. `resend` is the one transport that does.
 */
const DELIVERING_EMAIL_TRANSPORTS: ReadonlySet<EmailTransportKind> =
  new Set<EmailTransportKind>(['resend']);

/**
 * Mirrors the adapter NotificationsModule binds, read from the same switch.
 *
 * Read on every call rather than cached, so a deployment (and a test) sees the
 * environment it actually has. With EMAIL_TRANSPORT unset the historical
 * behaviour stands: the recording outbox when NOTIFICATION_OUTBOX_DIR is set,
 * the console adapter otherwise. Development therefore keeps its console
 * default and the browser suite keeps its file outbox without either having to
 * opt in.
 */
export function resolveEmailTransportKind(): EmailTransportKind {
  const outboxEnabled = isNotificationOutboxEnabled();
  const raw = process.env.EMAIL_TRANSPORT?.trim();

  if (!raw) {
    return outboxEnabled ? 'file-outbox' : 'console';
  }

  if (!isEmailTransportKind(raw)) {
    // The value is not echoed. A misconfiguration that pastes an API key into
    // the wrong variable must not turn the boot log into the place that key
    // finally gets written down.
    throw new Error(
      `EMAIL_TRANSPORT must be exactly one of: ${EMAIL_TRANSPORT_KINDS.join(', ')}.`,
    );
  }

  // The two switches must agree. Silently ignoring one of them is how a process
  // ends up recording live mail to disk, or asking a test transport to deliver.
  if (raw === 'file-outbox' && !outboxEnabled) {
    throw new Error(
      'EMAIL_TRANSPORT=file-outbox requires NOTIFICATION_OUTBOX_DIR: the recording transport has ' +
        'nowhere to write without it.',
    );
  }

  if (raw !== 'file-outbox' && outboxEnabled) {
    throw new Error(
      `NOTIFICATION_OUTBOX_DIR is set, which selects the recording transport, but ` +
        `EMAIL_TRANSPORT asks for a different one. Unset one of the two.`,
    );
  }

  return raw;
}

export function isDeliveringEmailTransportConfigured(): boolean {
  return DELIVERING_EMAIL_TRANSPORTS.has(resolveEmailTransportKind());
}

/**
 * Called once at boot, before anything listens, so a misconfigured transport is
 * a startup failure rather than a surprise on the first message.
 *
 * Two rules, and both are about not lying to the operator:
 *
 * 1. A production process must be wired to a transport that delivers. The
 *    console adapter would log "not delivered" for every activation link and
 *    the file outbox refuses to exist in production at all; either way the
 *    application would look healthy while no customer ever receives anything.
 * 2. The selected transport's own configuration has to be complete now, not on
 *    the first send. A missing API key discovered at 03:00 by a scheduler is a
 *    silent FAILED row; discovered at boot it is a deployment that never
 *    started.
 */
export function assertEmailTransportConfig(): void {
  const kind = resolveEmailTransportKind();

  if (process.env.NODE_ENV === 'production' && !DELIVERING_EMAIL_TRANSPORTS.has(kind)) {
    throw new Error(
      'NODE_ENV=production requires an e-mail transport that actually delivers. ' +
        'EMAIL_TRANSPORT=console only writes to the application log and EMAIL_TRANSPORT=file-outbox ' +
        'is a test-only recorder. Set EMAIL_TRANSPORT=resend and configure it.',
    );
  }

  if (kind === 'resend') {
    // Validates RESEND_API_KEY and EMAIL_FROM. Throws without echoing either.
    readResendConfig();
  }
}

function isEmailTransportKind(value: string): value is EmailTransportKind {
  return (EMAIL_TRANSPORT_KINDS as readonly string[]).includes(value);
}
