import { PROVIDER_REVIEW_PUBLIC_MIN_COUNT } from '../../common/provider-review-limits';

export type ReviewSummary = {
  count: number;
  /** Two decimals; null when there is nothing to average. */
  average: number | null;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
};

/** null = fewer than PROVIDER_REVIEW_PUBLIC_MIN_COUNT live reviews. */
export type PublicReviewSummary = { count: number; average: number } | null;

/** Folds `groupBy rating` rows into the provider-facing summary. */
export function toReviewSummary(
  rows: ReadonlyArray<{ rating: number; count: number }>,
): ReviewSummary {
  const distribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } as ReviewSummary['distribution'];
  let count = 0;
  let sum = 0;
  for (const row of rows) {
    distribution[String(row.rating) as keyof typeof distribution] += row.count;
    count += row.count;
    sum += row.rating * row.count;
  }
  return {
    count,
    average: count === 0 ? null : Math.round((sum / count) * 100) / 100,
    distribution,
  };
}

export function toPublicSummary(summary: ReviewSummary): PublicReviewSummary {
  return summary.count >= PROVIDER_REVIEW_PUBLIC_MIN_COUNT && summary.average !== null
    ? { count: summary.count, average: summary.average }
    : null;
}
