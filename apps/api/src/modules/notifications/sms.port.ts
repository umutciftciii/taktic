/**
 * Outbound SMS contract, deliberately separate from {@link NotificationPort}.
 *
 * SMS has no subject and no action URL, and its only current payload — a
 * one-time code — must never be persisted or logged. Keeping it as its own port
 * means the e-mail adapter can never be handed a code by accident, and picking a
 * real SMS provider later touches this file and nothing else.
 */
export type SmsTemplate = 'phone-verification-code';

export type SmsMessage = {
  template: SmsTemplate;
  /** Normalised destination number. Never written to a log or the database. */
  to: string;
  /**
   * The one-time code. It exists only in memory, for the duration of the send:
   * no adapter may persist it, and only the development console adapter may
   * print it.
   */
  code: string;
  expiresInMinutes: number;
};

export type SmsSendResult = {
  /** Provider-side identifier, safe to store for support and reconciliation. */
  providerMessageId: string | null;
};

export abstract class SmsPort {
  abstract send(message: SmsMessage): Promise<SmsSendResult>;
}
