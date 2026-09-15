import { describe, expect, it } from 'vitest';
import limits from '../../../packages/shared/limits.json';
import {
  NOT_ENOUGH_REVIEWS_TEXT,
  PROVIDER_REVIEW_COMMENT_MAX_LENGTH,
  PROVIDER_REVIEW_PUBLIC_MIN_COUNT,
  PROVIDER_REVIEW_WINDOW_DAYS,
  REVIEW_REPORT_REASONS,
  formatRating,
  monthLabel,
  ratingLabel,
  reviewRemovalReasonLabel,
  reviewReportReasonLabel,
  reviewSummaryText,
} from '../lib/reviews';

/**
 * The review wording every screen shares: the number a rating prints as, the
 * count beside it, the one sentence shown below the public threshold, and
 * the limits the form promises.
 */
describe('review formatting', () => {
  it('prints an average to one decimal with a Turkish comma', () => {
    expect(formatRating(4.66)).toBe('4,7');
    expect(formatRating(5)).toBe('5,0');
    expect(formatRating(3.04)).toBe('3,0');
  });

  it('labels the count', () => {
    expect(ratingLabel(1)).toBe('1 değerlendirme');
    expect(ratingLabel(12)).toBe('12 değerlendirme');
  });

  it('folds a public summary into one line, and the threshold sentence when there is none', () => {
    expect(reviewSummaryText({ count: 3, average: 4.67 })).toBe('4,7 · 3 değerlendirme');
    expect(reviewSummaryText(null)).toBe(NOT_ENOUGH_REVIEWS_TEXT);
    expect(NOT_ENOUGH_REVIEWS_TEXT).toBe('Henüz yeterli değerlendirme yok');
  });

  it('names a review month in Turkish without a day', () => {
    expect(monthLabel('2026-09')).toBe('Eylül 2026');
    expect(monthLabel('2026-01')).toBe('Ocak 2026');
  });
});

describe('review limits', () => {
  it('are the values carried by the shared limits file', () => {
    expect(PROVIDER_REVIEW_COMMENT_MAX_LENGTH).toBe(limits.providerReviewCommentMaxLength);
    expect(PROVIDER_REVIEW_PUBLIC_MIN_COUNT).toBe(limits.providerReviewPublicMinCount);
    expect(PROVIDER_REVIEW_WINDOW_DAYS).toBe(limits.providerReviewWindowDays);
  });

  it('are 600 characters, three reviews and ninety days', () => {
    expect(PROVIDER_REVIEW_COMMENT_MAX_LENGTH).toBe(600);
    expect(PROVIDER_REVIEW_PUBLIC_MIN_COUNT).toBe(3);
    expect(PROVIDER_REVIEW_WINDOW_DAYS).toBe(90);
  });
});

describe('review report reasons', () => {
  it('offers the five reasons the API stores, each with provider-facing wording', () => {
    expect(REVIEW_REPORT_REASONS).toEqual([
      'OFFENSIVE',
      'CONTAINS_CONTACT_INFO',
      'NOT_ABOUT_THIS_JOB',
      'SUSPECTED_FAKE',
      'OTHER',
    ]);
    for (const reason of REVIEW_REPORT_REASONS) {
      expect(reviewReportReasonLabel(reason)).not.toBe(reason);
      expect(reviewRemovalReasonLabel(reason)).not.toBe(reason);
    }
  });

  it('tells the customer the removal reason in the API\'s own customer wording', () => {
    expect(reviewRemovalReasonLabel('OFFENSIVE')).toBe('Hakaret veya uygunsuz dil');
    expect(reviewRemovalReasonLabel('OTHER')).toBe('Platform kurallarına aykırı');
  });
});
