import limits from '../../../packages/shared/limits.json';

/**
 * Provider reviews, as the web app words them.
 *
 * Client-safe on purpose: the review form, the star row and the report
 * dialog are Client Components and cannot pull in `lib/api.ts` (which reaches
 * for next/headers). `lib/api.ts` re-exports the types so server code keeps
 * one import.
 *
 * The three numbers come from `packages/shared/limits.json`, the same file
 * the API reads (`apps/api/src/common/provider-review-limits.ts`), so the
 * counter under the comment field, the sentence about the public threshold
 * and the window the review page names can never drift from the rules the
 * server enforces.
 */

export const PROVIDER_REVIEW_COMMENT_MAX_LENGTH: number = limits.providerReviewCommentMaxLength;
export const PROVIDER_REVIEW_PUBLIC_MIN_COUNT: number = limits.providerReviewPublicMinCount;
export const PROVIDER_REVIEW_WINDOW_DAYS: number = limits.providerReviewWindowDays;

/** The one sentence every public surface shows below the threshold. */
export const NOT_ENOUGH_REVIEWS_TEXT = 'Henüz yeterli değerlendirme yok';

/** The provider's own figures: every live review, no threshold. */
export type ReviewSummary = {
  count: number;
  /** Two decimals; null when there is nothing to average. */
  average: number | null;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
};

/** null = fewer than PROVIDER_REVIEW_PUBLIC_MIN_COUNT live reviews, or the switch is off. */
export type PublicReviewSummary = { count: number; average: number } | null;

export type PublicReviewItem = {
  id: string;
  rating: number;
  comment: string;
  /** YYYY-MM — the month, never the day. */
  month: string;
  categoryName: string;
};

export type PublicReviewsPage = {
  summary: PublicReviewSummary;
  items: PublicReviewItem[];
  nextCursor: string | null;
};

export type ProviderReviewReportReason =
  | 'OFFENSIVE'
  | 'CONTAINS_CONTACT_INFO'
  | 'NOT_ABOUT_THIS_JOB'
  | 'SUSPECTED_FAKE'
  | 'OTHER';

export type ProviderReviewReportResolution = 'DISMISSED' | 'COMMENT_REMOVED' | 'REVIEW_REMOVED';

export type ProviderReviewItem = {
  id: string;
  rating: number;
  comment: string | null;
  commentRemoved: boolean;
  createdAt: string;
  request: { id: string; requestNumber: string | null; categoryName: string };
  myReport: {
    reason: ProviderReviewReportReason;
    createdAt: string;
    resolution: ProviderReviewReportResolution | null;
  } | null;
};

export type ProviderReviewsPage = {
  summary: ReviewSummary;
  items: ProviderReviewItem[];
  nextCursor: string | null;
};

export type CustomerReviewEligibility =
  | 'ok'
  | 'disabled'
  | 'not-completed'
  | 'window-closed'
  | 'already-reviewed'
  | 'removed';

export type CustomerReviewState = {
  eligibility: CustomerReviewEligibility;
  windowEndsAt: string | null;
  provider: { id: string; businessName: string } | null;
  review: {
    id: string;
    rating: number;
    comment: string | null;
    createdAt: string;
    commentRemoved: boolean;
    removed: boolean;
    removalReason: ProviderReviewReportReason | null;
  } | null;
};

/**
 * Provider-facing wording for the report dialog, in the order it lists them.
 * Mirrors the API's `REVIEW_REASON_ADMIN_LABELS` keys; the wording is the
 * provider's, not the operator's.
 */
export const REVIEW_REPORT_REASON_LABELS: Record<ProviderReviewReportReason, string> = {
  OFFENSIVE: 'Hakaret veya uygunsuz dil',
  CONTAINS_CONTACT_INFO: 'İletişim bilgisi içeriyor',
  NOT_ABOUT_THIS_JOB: 'Bu işle ilgili değil',
  SUSPECTED_FAKE: 'Gerçek bir deneyime dayanmıyor',
  OTHER: 'Diğer',
};

export const REVIEW_REPORT_REASONS = Object.keys(
  REVIEW_REPORT_REASON_LABELS,
) as ProviderReviewReportReason[];

/**
 * What the customer whose review (or comment) was taken down is told, and
 * the only thing they are told about why. Mirrors the API's
 * `REVIEW_REASON_CUSTOMER_LABELS` (`provider-review-copy.ts`) word for word,
 * because the removal e-mail carries the same sentence.
 */
export const REVIEW_REMOVAL_REASON_CUSTOMER_LABELS: Record<ProviderReviewReportReason, string> = {
  OFFENSIVE: 'Hakaret veya uygunsuz dil',
  CONTAINS_CONTACT_INFO: 'İletişim bilgisi içeriyor',
  NOT_ABOUT_THIS_JOB: 'Bu işle ilgili değil',
  SUSPECTED_FAKE: 'Gerçek bir deneyime dayanmıyor',
  OTHER: 'Platform kurallarına aykırı',
};

/** What the provider's own list says about a report's outcome. */
export const REVIEW_REPORT_RESOLUTION_LABELS: Record<ProviderReviewReportResolution, string> = {
  DISMISSED: 'İncelendi, uygun bulundu',
  COMMENT_REMOVED: 'Yorum kaldırıldı',
  REVIEW_REMOVED: 'Değerlendirme kaldırıldı',
};

/** Mirrors REVIEW_REPORT_NOTE_MAX_LENGTH on the API side; the DTO is the authority. */
export const REVIEW_REPORT_NOTE_MAX_LENGTH = 500;

export function reviewReportReasonLabel(reason: string): string {
  return (REVIEW_REPORT_REASON_LABELS as Record<string, string>)[reason] ?? reason;
}

export function reviewRemovalReasonLabel(reason: string): string {
  return (REVIEW_REMOVAL_REASON_CUSTOMER_LABELS as Record<string, string>)[reason] ?? reason;
}

export function reviewReportResolutionLabel(resolution: string): string {
  return (REVIEW_REPORT_RESOLUTION_LABELS as Record<string, string>)[resolution] ?? resolution;
}

const RATING_FORMAT = new Intl.NumberFormat('tr-TR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** `4.66 → "4,7"`, `5 → "5,0"`: one decimal, Turkish comma. */
export function formatRating(average: number): string {
  return RATING_FORMAT.format(average);
}

export function ratingLabel(count: number): string {
  return `${count} değerlendirme`;
}

/** The public line as one string: `4,7 · 12 değerlendirme`, or the threshold sentence. */
export function reviewSummaryText(summary: PublicReviewSummary): string {
  return summary ? `${formatRating(summary.average)} · ${ratingLabel(summary.count)}` : NOT_ENOUGH_REVIEWS_TEXT;
}

const MONTH_FORMAT = new Intl.DateTimeFormat('tr-TR', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** `'2026-09' → 'Eylül 2026'`. The API sends the month only; this never invents a day. */
export function monthLabel(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!year || !monthNumber) return month;
  return MONTH_FORMAT.format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}
