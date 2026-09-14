import { ServiceRequestReportReason } from '@prisma/client';

/**
 * The wording around a request report, in two dictionaries that must never be
 * confused for each other.
 *
 * `REMOVAL_REASON_CUSTOMER_LABELS` is what the customer whose request was
 * taken down is told. It is the *only* thing they are told about why: not the
 * reporter, not how many reports there were, not the operator's note. The keys
 * are the operator's choice at decision time — the same vocabulary the report
 * reasons use, so an operator can carry a reporter's reason over one-to-one,
 * but a value of its own so the label a customer reads is never a reporter's
 * raw reason rendered by accident.
 *
 * `REPORT_REASON_ADMIN_LABELS` is the operator-facing spelling of a reporter's
 * reason, for the support inbox and the queue. It is shorter and blunter, and
 * it goes to nobody outside the company.
 */
export const REMOVAL_REASON_KEYS = [
  'SPAM',
  'FAKE_OR_TEST',
  'CONTAINS_CONTACT_INFO',
  'WRONG_CATEGORY',
  'INAPPROPRIATE_CONTENT',
  'DUPLICATE',
  'OTHER',
] as const;

export type RemovalReasonKey = (typeof REMOVAL_REASON_KEYS)[number];

export function isRemovalReasonKey(value: string): value is RemovalReasonKey {
  return (REMOVAL_REASON_KEYS as readonly string[]).includes(value);
}

/** What the customer is told. Never the reporter, never the operator's note. */
export const REMOVAL_REASON_CUSTOMER_LABELS: Record<RemovalReasonKey, string> = {
  SPAM: 'Talep içeriği platform kurallarına uygun bulunmadı',
  FAKE_OR_TEST: 'Talep gerçek bir hizmet ihtiyacı olarak değerlendirilemedi',
  CONTAINS_CONTACT_INFO: 'Talep metninde iletişim bilgisi paylaşımı',
  WRONG_CATEGORY: 'Talep seçilen hizmet kategorisine uygun değil',
  INAPPROPRIATE_CONTENT: 'Talep içeriği uygunsuz bulundu',
  DUPLICATE: 'Aynı hizmet için birden fazla talep açılmış',
  OTHER: 'Talep platform kurallarına uygun bulunmadı',
};

/**
 * The prefix `resolve` writes in front of the customer label when it stores
 * the removal as the request's `rejectionReason`. A retry of the removal mail
 * has only the request row to rebuild from, and this prefix is how it tells a
 * report's removal apart from a reason an operator typed by hand — see
 * {@link removalReasonFromRejectionReason}.
 */
export const REPORT_REJECTION_REASON_PREFIX = 'Bildirim: ';

export function rejectionReasonForRemoval(reason: RemovalReasonKey): string {
  return `${REPORT_REJECTION_REASON_PREFIX}${REMOVAL_REASON_CUSTOMER_LABELS[reason]}`;
}

/**
 * The inverse, for the retry path: the stored `rejectionReason` back to the
 * key it was written from. A reason without the prefix, or with a label this
 * build no longer knows, falls back to `OTHER` — the one label that is true of
 * every removal — rather than to nothing, because the mail it rebuilds is
 * still owed.
 */
export function removalReasonFromRejectionReason(rejectionReason: string | null): RemovalReasonKey {
  if (!rejectionReason?.startsWith(REPORT_REJECTION_REASON_PREFIX)) {
    return 'OTHER';
  }
  const label = rejectionReason.slice(REPORT_REJECTION_REASON_PREFIX.length);
  const match = REMOVAL_REASON_KEYS.find((key) => REMOVAL_REASON_CUSTOMER_LABELS[key] === label);
  return match ?? 'OTHER';
}

/** The operator's spelling of a reporter's reason. Never leaves the company. */
export const REPORT_REASON_ADMIN_LABELS: Record<ServiceRequestReportReason, string> = {
  SPAM: 'Spam / anlamsız',
  FAKE_OR_TEST: 'Sahte / deneme',
  CONTAINS_CONTACT_INFO: 'İletişim bilgisi içeriyor',
  WRONG_CATEGORY: 'Yanlış kategori',
  INAPPROPRIATE_CONTENT: 'Uygunsuz içerik',
  DUPLICATE: 'Mükerrer',
  OTHER: 'Diğer',
};
