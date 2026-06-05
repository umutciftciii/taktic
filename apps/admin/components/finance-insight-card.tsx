import type { ReactNode } from 'react';

type Tone = 'neutral' | 'success' | 'warning' | 'danger';

type FinanceInsightCardProps = {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
};

const TONE_CLASS: Record<Tone, string> = {
  neutral: '',
  success: 'is-success',
  warning: 'is-warning',
  danger: 'is-danger',
};

export function FinanceInsightCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: FinanceInsightCardProps) {
  return (
    <div className={`finance-insight-card ${TONE_CLASS[tone]}`.trim()}>
      <div className="finance-insight-card-label">{label}</div>
      <div className="finance-insight-card-value">{value}</div>
      {hint ? <div className="finance-insight-card-hint">{hint}</div> : null}
    </div>
  );
}
