import type { ReactNode } from 'react';

type Tone = 'primary' | 'success' | 'warning' | 'neutral';

type FinanceProgressMetricProps = {
  label: ReactNode;
  value: ReactNode;
  /** Progress fill ratio. Use null when the ratio cannot be computed (e.g. divide-by-zero). */
  ratio: number | null;
  tone?: Tone;
  hint?: ReactNode;
};

const TONE_CLASS: Record<Tone, string> = {
  primary: 'is-primary',
  success: 'is-success',
  warning: 'is-warning',
  neutral: 'is-neutral',
};

export function FinanceProgressMetric({
  label,
  value,
  ratio,
  tone = 'primary',
  hint,
}: FinanceProgressMetricProps) {
  const pct =
    ratio === null || Number.isNaN(ratio)
      ? null
      : Math.max(0, Math.min(100, ratio * 100));

  return (
    <div className={`finance-progress-metric ${TONE_CLASS[tone]}`}>
      <div className="finance-progress-metric-row">
        <span className="finance-progress-metric-label">{label}</span>
        <span className="finance-progress-metric-value">{value}</span>
      </div>
      <div
        className="finance-progress-metric-track"
        aria-hidden={pct === null ? true : undefined}
      >
        <div
          className="finance-progress-metric-fill"
          style={{ width: pct === null ? '0%' : `${pct}%` }}
        />
      </div>
      {hint ? <div className="finance-progress-metric-hint">{hint}</div> : null}
    </div>
  );
}
