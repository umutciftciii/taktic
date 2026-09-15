import { PROVIDER_REVIEW_WINDOW_DAYS } from '../../common/provider-review-limits';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a customer's chance to review a completed job closes: a fixed number of
 * days after `completedAt`, from `limits.json` so the web screens and the
 * invitation mail name the same date.
 */
export function reviewWindowEndsAt(completedAt: Date): Date {
  return new Date(completedAt.getTime() + PROVIDER_REVIEW_WINDOW_DAYS * DAY_MS);
}

/** Inclusive at the end: a review written at the exact closing instant still counts. */
export function isReviewWindowOpen(completedAt: Date, now = new Date()): boolean {
  return now.getTime() <= reviewWindowEndsAt(completedAt).getTime();
}
