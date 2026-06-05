import type { ReactNode } from 'react';

export type FinanceBarChartDatum = {
  key: string;
  label: string;
  value: number;
  displayValue?: string;
  tooltip?: string;
};

type FinanceBarChartProps = {
  data: FinanceBarChartDatum[];
  emptyMessage?: ReactNode;
  tone?: 'primary' | 'success' | 'warning' | 'danger' | 'muted';
  maxLabels?: number;
  valueFormatter?: (value: number) => string;
};

const TONE_TO_CLASS: Record<NonNullable<FinanceBarChartProps['tone']>, string> = {
  primary: 'finance-bar-chart-bar-primary',
  success: 'finance-bar-chart-bar-success',
  warning: 'finance-bar-chart-bar-warning',
  danger: 'finance-bar-chart-bar-danger',
  muted: 'finance-bar-chart-bar-muted',
};

export function FinanceBarChart({
  data,
  emptyMessage = 'Bu dönem için veri yok.',
  tone = 'primary',
  maxLabels = 6,
  valueFormatter,
}: FinanceBarChartProps) {
  const max = data.reduce((acc, d) => Math.max(acc, d.value), 0);

  if (data.length === 0 || max === 0) {
    return <div className="finance-bar-chart-empty">{emptyMessage}</div>;
  }

  // Label thinning: only show every Nth label so dense bucket sets stay legible.
  const labelStep = Math.max(1, Math.ceil(data.length / maxLabels));
  const toneClass = TONE_TO_CLASS[tone];

  return (
    <div className="finance-bar-chart">
      <div className="finance-bar-chart-bars" role="list">
        {data.map((d, index) => {
          const ratio = Math.round((d.value / max) * 100);
          const pct = d.value > 0 ? Math.max(2, ratio) : 0;
          const showLabel = index % labelStep === 0 || index === data.length - 1;
          const display =
            d.displayValue ?? (valueFormatter ? valueFormatter(d.value) : String(d.value));
          return (
            <div
              key={d.key}
              className="finance-bar-chart-column"
              role="listitem"
              title={d.tooltip ?? `${d.label}: ${display}`}
            >
              <div className="finance-bar-chart-bar-wrapper">
                <span className="finance-bar-chart-bar-value">{display}</span>
                <div
                  className={`finance-bar-chart-bar ${toneClass}`}
                  style={
                    d.value > 0
                      ? { height: `${pct}%` }
                      : { height: 0, minHeight: 0 }
                  }
                  aria-label={`${d.label}: ${display}`}
                />
              </div>
              <div
                className={`finance-bar-chart-label ${
                  showLabel ? '' : 'finance-bar-chart-label-hidden'
                }`}
              >
                {d.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
