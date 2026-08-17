import { NotificationChannel, NotificationStatus, Prisma } from '@prisma/client';
import {
  normalizeStoredErrorCode,
  notificationErrorLabel,
  type NotificationErrorCode,
} from '../notifications/notification-errors';

/**
 * The templates this build sends. Used to offer a sensible filter list; the
 * filter itself accepts any string, because rows written by an older build must
 * stay reachable.
 */
export const NOTIFICATION_TEMPLATES = [
  'customer-activation',
  'request-expiring',
  'phone-verification-code',
] as const;

/**
 * The only columns the admin read path ever loads.
 *
 * An explicit `select` rather than the whole row: NotificationLog is designed to
 * hold nothing replayable, and this keeps that guarantee independent of the
 * schema. If a future column ever did carry something sensitive, it would have
 * to be added here on purpose before it could reach an operator.
 *
 * Note what is absent by construction — there is no body, no subject, no action
 * URL, no one-time code and no raw recipient anywhere in the table.
 */
export const notificationLogSelect = {
  id: true,
  channel: true,
  template: true,
  maskedRecipient: true,
  status: true,
  providerMessageId: true,
  errorCode: true,
  requestId: true,
  userId: true,
  createdAt: true,
  sentAt: true,
  failedAt: true,
} satisfies Prisma.NotificationLogSelect;

export type NotificationLogRow = Prisma.NotificationLogGetPayload<{
  select: typeof notificationLogSelect;
}>;

export type SafeNotificationLog = {
  id: string;
  channel: NotificationChannel;
  template: string;
  maskedRecipient: string;
  status: NotificationStatus;
  errorCode: NotificationErrorCode | null;
  errorLabel: string | null;
  /** Null when absent, and also when the stored value failed the safety check. */
  providerMessageId: string | null;
  /** True only in the second case, so the screen can say so instead of lying. */
  providerMessageIdRedacted: boolean;
  requestId: string | null;
  userId: string | null;
  createdAt: Date;
  sentAt: Date | null;
  failedAt: Date | null;
};

export function toSafeNotificationLog(row: NotificationLogRow): SafeNotificationLog {
  const errorCode = normalizeStoredErrorCode(row.errorCode);
  const providerMessageId = projectProviderMessageId(row.providerMessageId);

  return {
    id: row.id,
    channel: row.channel,
    template: row.template,
    maskedRecipient: row.maskedRecipient,
    status: row.status,
    errorCode,
    errorLabel: errorCode ? notificationErrorLabel(errorCode) : null,
    ...providerMessageId,
    requestId: row.requestId,
    userId: row.userId,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
    failedAt: row.failedAt,
  };
}

/**
 * Guards the one free-form value in the payload.
 *
 * Today's adapters write either null (e-mail, console SMS) or an opaque
 * `outbox-<uuid>` (the test transport), so nothing sensitive can be in there.
 * But the column is filled by whichever provider is wired next, and providers do
 * echo the destination address back as a correlation key. Rather than trusting
 * an adapter that does not exist yet, anything that does not look like an opaque
 * identifier is withheld — the operator is told it was withheld, which is more
 * useful than a value nobody may look at.
 */
export function projectProviderMessageId(value: string | null): {
  providerMessageId: string | null;
  providerMessageIdRedacted: boolean;
} {
  if (!value) {
    return { providerMessageId: null, providerMessageIdRedacted: false };
  }

  return isOpaqueIdentifier(value)
    ? { providerMessageId: value, providerMessageIdRedacted: false }
    : { providerMessageId: null, providerMessageIdRedacted: true };
}

function isOpaqueIdentifier(value: string): boolean {
  // An address, a URL or anything with whitespace is content, not an id.
  if (value.length > 128 || /[\s@]/.test(value) || value.includes('://')) {
    return false;
  }

  // A bare phone number, in any of the shapes a provider might return it.
  // Checked on the digits alone so "+90 555 ..." and "905550000000" both fail;
  // a real opaque id always carries non-digits (a prefix, a dash, hex letters).
  const digitsOnly = value.replace(/[\s()+.-]/g, '');
  return !/^\d{7,}$/.test(digitsOnly);
}
