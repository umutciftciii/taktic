import { ProviderReviewReportReason } from '@prisma/client';

/**
 * The wording around a review report and a removal, in two dictionaries that
 * must never be confused for each other — the same split as
 * `request-report-copy.ts`.
 *
 * `REVIEW_REASON_CUSTOMER_LABELS` is what the customer whose review (or
 * comment) was taken down is told, and the *only* thing they are told about
 * why: not the reporter, not the operator's note.
 *
 * `REVIEW_REASON_ADMIN_LABELS` is the operator-facing spelling of a reporter's
 * reason, for the support inbox and the queue. It goes to nobody outside the
 * company.
 */
export const REVIEW_REASON_CUSTOMER_LABELS: Record<ProviderReviewReportReason, string> = {
  OFFENSIVE: 'Hakaret veya uygunsuz dil',
  CONTAINS_CONTACT_INFO: 'İletişim bilgisi içeriyor',
  NOT_ABOUT_THIS_JOB: 'Bu işle ilgili değil',
  SUSPECTED_FAKE: 'Gerçek bir deneyime dayanmıyor',
  OTHER: 'Platform kurallarına aykırı',
};

export const REVIEW_REASON_ADMIN_LABELS: Record<ProviderReviewReportReason, string> = {
  OFFENSIVE: 'Hakaret / uygunsuz dil',
  CONTAINS_CONTACT_INFO: 'İletişim bilgisi',
  NOT_ABOUT_THIS_JOB: 'İşle ilgisiz',
  SUSPECTED_FAKE: 'Sahte şüphesi',
  OTHER: 'Diğer',
};

/** What was taken down, as the customer reads it: the comment alone, or the whole review. */
export const REVIEW_SCOPE_LABELS = {
  COMMENT: 'Yorumunuz',
  REVIEW: 'Değerlendirmeniz',
} as const;

export type ReviewRemovalScope = keyof typeof REVIEW_SCOPE_LABELS;
