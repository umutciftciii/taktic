import {
  NOT_ENOUGH_REVIEWS_TEXT,
  formatRating,
  ratingLabel,
  type PublicReviewSummary,
} from '../lib/reviews';

/**
 * A rating, read-only, as five glyphs and one accessible sentence.
 *
 * Server-safe — no state, no handlers — so the same component draws the star
 * on the customer's board, the provider's list, the public profile and the
 * operator's screens. The glyphs are hidden from assistive technology and the
 * `img` role carries the meaning, so a screen reader hears "5 üzerinden 4
 * yıldız" once rather than five stars one at a time.
 */
export function ReviewStars({
  value,
  label,
  testId = 'review-stars',
}: {
  value: number;
  label?: string;
  testId?: string;
}) {
  return (
    <span
      className="review-stars"
      role="img"
      aria-label={label ?? `5 üzerinden ${value} yıldız`}
      data-testid={testId}
      data-value={value}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} aria-hidden="true" className={n <= value ? 'review-star is-on' : 'review-star'}>
          ★
        </span>
      ))}
    </span>
  );
}

/**
 * The public summary as one line: `★ 4,7 · 12 değerlendirme`, or the one
 * sentence every public surface shows below the threshold. The threshold
 * itself is the API's decision — a null summary is what it hands over when
 * there are fewer than three live reviews or the feature is off — so this
 * never counts anything; it only words what it was given.
 */
export function RatingSummaryLine({
  summary,
  testId = 'review-summary',
  className,
}: {
  summary: PublicReviewSummary;
  testId?: string;
  className?: string;
}) {
  if (!summary) {
    return (
      <p className={['review-summary-empty', className].filter(Boolean).join(' ')} data-testid={testId}>
        {NOT_ENOUGH_REVIEWS_TEXT}
      </p>
    );
  }

  return (
    <p className={['review-summary', className].filter(Boolean).join(' ')} data-testid={testId}>
      <span className="review-summary-star" aria-hidden="true">
        ★
      </span>{' '}
      <span className="review-summary-average">{formatRating(summary.average)}</span>
      <span aria-hidden="true"> · </span>
      <span className="review-summary-count">{ratingLabel(summary.count)}</span>
    </p>
  );
}
