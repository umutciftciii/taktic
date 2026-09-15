/**
 * Provider reviews, as the operator names them.
 *
 * Client-safe on purpose: the moderation form is a Client Component and
 * cannot pull in `lib/api.ts` (which reaches for next/headers). `lib/api.ts`
 * re-exports everything here so server code keeps one import.
 */

/**
 * A provider's reason for reporting a review. Mirrors the API's enum; the
 * operator's wording below mirrors `REVIEW_REASON_ADMIN_LABELS`
 * (`provider-review-copy.ts`), copied because the admin app cannot import
 * the API. The customer wording is what the removal notice says.
 */
export const REVIEW_REPORT_REASON_KEYS = [
  'OFFENSIVE',
  'CONTAINS_CONTACT_INFO',
  'NOT_ABOUT_THIS_JOB',
  'SUSPECTED_FAKE',
  'OTHER',
] as const;

export type ReviewReportReason = (typeof REVIEW_REPORT_REASON_KEYS)[number];
export type ReviewReportResolution = 'DISMISSED' | 'COMMENT_REMOVED' | 'REVIEW_REMOVED';
export type ReviewModerationAction = 'REMOVE_COMMENT' | 'REMOVE_REVIEW' | 'RESTORE';

export const REVIEW_REASON_ADMIN_LABELS: Record<ReviewReportReason, string> = {
  OFFENSIVE: 'Hakaret / uygunsuz dil',
  CONTAINS_CONTACT_INFO: 'İletişim bilgisi',
  NOT_ABOUT_THIS_JOB: 'İşle ilgisiz',
  SUSPECTED_FAKE: 'Sahte şüphesi',
  OTHER: 'Diğer',
};

/** The sentence the customer reads in the removal notice — shown beside each option. */
export const REVIEW_REASON_CUSTOMER_LABELS: Record<ReviewReportReason, string> = {
  OFFENSIVE: 'Hakaret veya uygunsuz dil',
  CONTAINS_CONTACT_INFO: 'İletişim bilgisi içeriyor',
  NOT_ABOUT_THIS_JOB: 'Bu işle ilgili değil',
  SUSPECTED_FAKE: 'Gerçek bir deneyime dayanmıyor',
  OTHER: 'Platform kurallarına aykırı',
};

export const REVIEW_REPORT_RESOLUTION_LABELS: Record<ReviewReportResolution, string> = {
  DISMISSED: 'Uygun bulundu',
  COMMENT_REMOVED: 'Yorum kaldırıldı',
  REVIEW_REMOVED: 'Değerlendirme kaldırıldı',
};

export const REVIEW_MODERATION_ACTION_LABELS: Record<ReviewModerationAction, string> = {
  REMOVE_COMMENT: 'Yorum kaldırıldı',
  REMOVE_REVIEW: 'Değerlendirme kaldırıldı',
  RESTORE: 'Geri getirildi',
};

export function reviewReasonLabel(reason: string): string {
  return (REVIEW_REASON_ADMIN_LABELS as Record<string, string>)[reason] ?? reason;
}

export function reviewResolutionLabel(resolution: string): string {
  return (REVIEW_REPORT_RESOLUTION_LABELS as Record<string, string>)[resolution] ?? resolution;
}

export function reviewModerationActionLabel(action: string): string {
  return (REVIEW_MODERATION_ACTION_LABELS as Record<string, string>)[action] ?? action;
}

/** The operator's summary of where a review stands, from its two removal marks. */
export function reviewStateLabel(review: { removed: boolean; commentRemoved: boolean }): string {
  if (review.removed) return 'Kaldırıldı';
  if (review.commentRemoved) return 'Yorum kaldırıldı';
  return 'Yayında';
}

export function reviewStateBadgeClass(review: { removed: boolean; commentRemoved: boolean }): string {
  if (review.removed) return 'badge badge-bad';
  if (review.commentRemoved) return 'badge badge-warn';
  return 'badge badge-good';
}

