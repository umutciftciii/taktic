import { NotificationChannel, NotificationStatus, Prisma } from '@prisma/client';
import { TRANSACTIONAL_EMAIL_TEMPLATES } from '../notifications/templates/transactional-templates';
import {
  normalizeStoredErrorCode,
  notificationErrorLabel,
  type NotificationErrorCode,
} from '../notifications/notification-errors';
import {
  NOTIFICATION_RETRY_BLOCK_LABELS,
  notificationRetryEligibility,
  type NotificationRetryBlock,
} from './notification-retry.rules';

/**
 * The templates this build sends. Used to offer a sensible filter list; the
 * filter itself accepts any string, because rows written by an older build must
 * stay reachable.
 */
export const NOTIFICATION_TEMPLATES = [
  'customer-activation',
  'request-expiring',
  'phone-verification-code',
  'provider-claim',
  ...TRANSACTIONAL_EMAIL_TEMPLATES,
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
 *
 * `providerId` is an id and stays an id: the relation is deliberately not
 * loaded here, because joining ProviderProfile would pull an application's
 * contact address into a payload whose entire design is that addresses only
 * appear masked.
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
  providerId: true,
  attemptCount: true,
  lastAttemptAt: true,
  createdAt: true,
  sentAt: true,
  failedAt: true,
  /**
   * Read, never returned.
   *
   * The key names the state transition a message belonged to, which is what
   * decides whether the row can be rebuilt and re-sent. It is derived from ids
   * and timestamps only — see the schema — but it is an internal handle rather
   * than something an operator acts on, so it is consumed here to compute
   * `retryable` and left out of the payload.
   */
  dedupeKey: true,
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
  providerId: string | null;
  /** Attempts against this one message: the first send plus every retry. */
  attemptCount: number;
  /** When the latest attempt was claimed, including one still in flight. */
  lastAttemptAt: Date | null;
  createdAt: Date;
  sentAt: Date | null;
  failedAt: Date | null;
  /** Whether an operator may re-send this exact row. */
  retryable: boolean;
  /** Why not, as a closed code. Null when it is retryable. */
  retryBlock: NotificationRetryBlock | null;
  /** The same reason as a sentence, so the screen does not restate the rules. */
  retryBlockLabel: string | null;
};

export function toSafeNotificationLog(row: NotificationLogRow): SafeNotificationLog {
  const errorCode = normalizeStoredErrorCode(row.errorCode);
  const providerMessageId = projectProviderMessageId(row.providerMessageId);
  const retry = notificationRetryEligibility(row);

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
    providerId: row.providerId,
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
    failedAt: row.failedAt,
    retryable: retry.retryable,
    retryBlock: retry.block,
    retryBlockLabel: retry.block ? NOTIFICATION_RETRY_BLOCK_LABELS[retry.block] : null,
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
