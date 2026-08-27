/**
 * The complete, closed set of failure classes a notification send may record.
 *
 * Both sides of NotificationLog.errorCode depend on this list. The dispatcher
 * writes nothing outside it — a raw provider error string can carry the
 * destination address or the message body — and the admin read path normalises
 * anything it does not recognise back to UNKNOWN, so a row written by an older
 * build (or by hand) can never turn the API into an echo for arbitrary text.
 */
export const NOTIFICATION_ERROR_CODES = [
  'TRANSPORT_UNAVAILABLE',
  'REJECTED',
  'TIMEOUT',
  'INVALID_RECIPIENT',
  /**
   * The company footer this deployment would have printed is missing or
   * unusable — no settings row, no legal name, or a support address nobody
   * could write to. Raised before anything is handed to a provider, so the row
   * records a message that was composed and deliberately not sent.
   */
  'EMAIL_BRANDING_INCOMPLETE',
  /**
   * This deployment's public base URL cannot appear in a message a stranger
   * opens — it is unset, unparseable, carries a path, is plain http, or points
   * at loopback. Every link and the logo would be built from it, so the message
   * is refused before it reaches the transport.
   *
   * Deliberately distinct from EMAIL_BRANDING_INCOMPLETE: one is a company
   * detail an operator types into the admin panel, the other is deployment
   * configuration they set in the environment, and telling them apart is the
   * difference between fixing it in a minute and hunting for it.
   */
  'EMAIL_PUBLIC_URL_INVALID',
  /**
   * A retry could not rebuild the message. The transition's source row is gone,
   * no longer in the state the message describes, or the platform no longer
   * holds an address for its recipient.
   *
   * Only ever written by the admin retry path, and never by an adapter: it is a
   * statement about this deployment's own data, not about a transport. It names
   * a class and nothing else — which row, and which of those three it was, is
   * not recorded, because that would start describing the message.
   */
  'SOURCE_UNAVAILABLE',
  'UNKNOWN',
] as const;

export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_CODES)[number];

/**
 * The classes an adapter may raise.
 *
 * UNKNOWN is the dispatcher's own fallback, and SOURCE_UNAVAILABLE is written
 * directly by the retry path — neither may be claimed by a thrown error, so an
 * adapter cannot dress a transport failure up as one of them.
 */
const RAISABLE_ERROR_CODES: ReadonlySet<string> = new Set(
  NOTIFICATION_ERROR_CODES.filter(
    (code) => code !== 'UNKNOWN' && code !== 'SOURCE_UNAVAILABLE',
  ),
);

/** Operator-facing wording. Says what class of thing went wrong, nothing more. */
export const NOTIFICATION_ERROR_LABELS: Record<NotificationErrorCode, string> = {
  TRANSPORT_UNAVAILABLE: 'Taşıma servisi kullanılamıyor',
  REJECTED: 'Alıcı reddedildi',
  TIMEOUT: 'Zaman aşımı',
  INVALID_RECIPIENT: 'Geçersiz alıcı',
  EMAIL_BRANDING_INCOMPLETE: 'Şirket ve e-posta ayarları eksik',
  EMAIL_PUBLIC_URL_INVALID: 'Uygulamanın public adresi e-postada kullanılamaz',
  SOURCE_UNAVAILABLE: 'Kaynak kayıt yeniden oluşturulamıyor',
  UNKNOWN: 'Bilinmeyen hata',
};

/**
 * Reads the failure class off a thrown error. Anything unrecognised — including
 * a plain Error whose message is the provider's own text — becomes UNKNOWN.
 */
export function classifyNotificationError(error: unknown): NotificationErrorCode {
  const candidate = (error as { errorCode?: unknown } | null)?.errorCode;
  if (typeof candidate === 'string' && RAISABLE_ERROR_CODES.has(candidate)) {
    return candidate as NotificationErrorCode;
  }

  return 'UNKNOWN';
}

/**
 * Read-side normaliser. A stored value outside the set is reported as UNKNOWN
 * rather than passed through, so the response can only ever carry one of the
 * constants above.
 */
export function normalizeStoredErrorCode(stored: string | null): NotificationErrorCode | null {
  if (!stored) {
    return null;
  }

  return (NOTIFICATION_ERROR_CODES as readonly string[]).includes(stored)
    ? (stored as NotificationErrorCode)
    : 'UNKNOWN';
}

export function notificationErrorLabel(code: NotificationErrorCode): string {
  return NOTIFICATION_ERROR_LABELS[code];
}
