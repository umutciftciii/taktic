import { NotificationChannel, NotificationStatus } from '@prisma/client';
import {
  isRetryableTransactionalTemplate,
  RETRYABLE_TRANSACTIONAL_TEMPLATES,
} from '../notifications/transactional-mail.service';

export { RETRYABLE_TRANSACTIONAL_TEMPLATES };

/**
 * Why a row may not be re-sent. A closed set: the read endpoint returns it and
 * the admin screen turns it into a sentence, so it must never carry free text.
 */
export const NOTIFICATION_RETRY_BLOCKS = [
  /** Not an e-mail. No SMS provider is wired, and codes are not reproducible. */
  'CHANNEL_NOT_EMAIL',
  /** PENDING or SENT. Only a failure is re-sent, and only once it has settled. */
  'STATUS_NOT_FAILED',
  /**
   * The message cannot be composed again — it carried a single-use token that
   * was never stored (password reset, e-mail verification, guest activation,
   * provider claim) or it predates the templates this build can rebuild.
   */
  'TEMPLATE_NOT_REPRODUCIBLE',
  /**
   * The row names no transition, so there is no source entity to rebuild from.
   * True of every row written before dedupe keys existed.
   */
  'NO_SOURCE_TRANSITION',
] as const;

export type NotificationRetryBlock = (typeof NOTIFICATION_RETRY_BLOCKS)[number];

/** Operator-facing wording, in the terms the screen has to explain. */
export const NOTIFICATION_RETRY_BLOCK_LABELS: Record<NotificationRetryBlock, string> = {
  CHANNEL_NOT_EMAIL: 'Yalnız e-posta bildirimleri yeniden gönderilebilir.',
  STATUS_NOT_FAILED: 'Yalnız başarısız bildirimler yeniden gönderilebilir.',
  TEMPLATE_NOT_REPRODUCIBLE:
    'Bu bildirim tek kullanımlık bir bağlantı taşıyordu ve yeniden oluşturulamaz. Kullanıcının yeni bir istek başlatması gerekir.',
  NO_SOURCE_TRANSITION: 'Bu kayıt hangi işleme ait olduğunu taşımıyor.',
};

export type RetryCandidate = {
  channel: NotificationChannel;
  status: NotificationStatus;
  template: string;
  dedupeKey: string | null;
};

export type NotificationRetryEligibility =
  | { retryable: true; block: null }
  | { retryable: false; block: NotificationRetryBlock };

/**
 * Whether one audit row may be re-sent.
 *
 * The single authority on the question. The read projection calls it to decide
 * whether the screen shows a "Yeniden gönder" control, and the retry endpoint
 * calls it again before doing anything — a control that is never rendered is
 * not a check, and the endpoint takes only a log id precisely so that this
 * function, not the caller, decides what happens.
 *
 * The order of the checks is the order an operator would ask the questions, and
 * it puts reproducibility ahead of status on purpose: a failed password reset
 * must be refused because it carries a token, not because of anything about its
 * state, and that is what the message needs to say.
 */
export function notificationRetryEligibility(row: RetryCandidate): NotificationRetryEligibility {
  if (row.channel !== NotificationChannel.EMAIL) {
    return { retryable: false, block: 'CHANNEL_NOT_EMAIL' };
  }

  if (!isRetryableTransactionalTemplate(row.template)) {
    return { retryable: false, block: 'TEMPLATE_NOT_REPRODUCIBLE' };
  }

  if (!row.dedupeKey) {
    return { retryable: false, block: 'NO_SOURCE_TRANSITION' };
  }

  // Deliberately last, and deliberately strict. PENDING is either a send in
  // flight or a retry another operator is running right now; SENT is done. Only
  // a settled failure is offered, and the endpoint re-checks it inside a
  // conditional update so two clicks cannot both pass this line.
  if (row.status !== NotificationStatus.FAILED) {
    return { retryable: false, block: 'STATUS_NOT_FAILED' };
  }

  return { retryable: true, block: null };
}
