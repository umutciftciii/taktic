import { Fragment } from 'react';
import { formatRating, ratingLabel, type ReviewSummary } from '../lib/reviews';
import { ReviewStars } from './review-stars';

/**
 * The business's own figures: the average, the count and how the stars are
 * spread. No public threshold here — this is a business reading its own
 * reviews, and one review is a fact on its own screen whatever the profile
 * shows. The caller says, beside it, when the public line appears.
 *
 * Server-safe; drawn on the provider's review list, their dashboard rail and
 * the operator's provider screen.
 */
export function ReviewSummaryCard({
  summary,
  testId = 'review-summary-card',
  showDistribution = true,
}: {
  summary: ReviewSummary;
  testId?: string;
  showDistribution?: boolean;
}) {
  if (summary.count === 0 || summary.average === null) {
    return (
      <div className="review-summary-card" data-testid={testId} data-count={0}>
        <span className="review-summary-figure">
          —<small> henüz değerlendirme yok</small>
        </span>
      </div>
    );
  }

  const rounded = Math.round(summary.average);

  return (
    <div className="review-summary-card" data-testid={testId} data-count={summary.count}>
      <span className="review-summary-figure">
        {formatRating(summary.average)}
        <small> / 5 · {ratingLabel(summary.count)}</small>
      </span>
      <ReviewStars value={rounded} label={`Ortalama 5 üzerinden ${formatRating(summary.average)}`} testId={`${testId}-stars`} />
      {showDistribution ? <ReviewDistribution summary={summary} /> : null}
    </div>
  );
}

/** Five bars, five stars first, each as a share of the count. */
export function ReviewDistribution({ summary }: { summary: ReviewSummary }) {
  const rows = (['5', '4', '3', '2', '1'] as const).map((star) => ({
    star,
    count: summary.distribution[star],
    share: summary.count > 0 ? Math.round((summary.distribution[star] / summary.count) * 100) : 0,
  }));

  return (
    <dl className="review-distribution" data-testid="review-distribution">
      {rows.map((row) => (
        <Fragment key={row.star}>
          <dt>{row.star} ★</dt>
          <dd className="databar" aria-hidden="true">
            <div className="databar-fill" style={{ width: `${row.share}%` }} />
          </dd>
          <dd>{row.count}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
