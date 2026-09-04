import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AdminMetricTone } from '../lib/dashboard-metrics';

type StatCardProps = {
  label: ReactNode;
  value: ReactNode;
  href?: string;
  /**
   * Already resolved by the caller — `neutral` renders no badge at all. The
   * card deliberately does not look at `value` to decide: whether a number is
   * worth a badge is a product rule, and it lives in `lib/dashboard-metrics.ts`
   * so every card answers it the same way.
   */
  tone?: AdminMetricTone;
  hint?: ReactNode;
  /** The metric this card shows, exposed as `data-metric` for the e2e suite. */
  metricKey?: string;
};

const toneToBadge: Record<AdminMetricTone, string> = {
  neutral: 'badge',
  success: 'badge badge-good',
  warning: 'badge badge-warn',
  error: 'badge badge-bad',
};

const toneToLabel: Record<AdminMetricTone, string> = {
  neutral: '',
  success: 'iyi',
  warning: 'dikkat',
  error: 'uyarı',
};

export function StatCard({ label, value, href, tone = 'neutral', hint, metricKey }: StatCardProps) {
  const inner = (
    <>
      <span className="stat-card-label">{label}</span>
      <span className="metric">{value}</span>
      {hint ? <span className="stat-card-hint">{hint}</span> : null}
      {tone !== 'neutral' ? (
        <span className={toneToBadge[tone]} data-testid="stat-card-badge">
          {toneToLabel[tone]}
        </span>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Link
        className="stat-card stat-card-link"
        href={href}
        data-testid="stat-card"
        data-metric={metricKey}
      >
        {inner}
      </Link>
    );
  }

  return (
    <div className="stat-card" data-testid="stat-card" data-metric={metricKey}>
      {inner}
    </div>
  );
}
