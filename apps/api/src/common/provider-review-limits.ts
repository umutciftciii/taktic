import limits from '@taktic/shared/limits.json';

/**
 * Review limits, read from the same file the web screens read. JSON import
 * only — see service-request-limits.ts for why the package's TS entry point
 * cannot be required from the compiled API.
 */
export const PROVIDER_REVIEW_COMMENT_MAX_LENGTH = limits.providerReviewCommentMaxLength;
export const PROVIDER_REVIEW_PUBLIC_MIN_COUNT = limits.providerReviewPublicMinCount;
export const PROVIDER_REVIEW_WINDOW_DAYS = limits.providerReviewWindowDays;
