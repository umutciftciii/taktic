import type { ReactNode } from 'react';

export type FinanceKpi = {
  label: ReactNode;
  value: ReactNode;
  /** The coloured line under the figure — a ratio or a split, never a guess. */
  delta?: ReactNode;
  deltaTone?: 'neutral' | 'success' | 'warning' | 'danger';
  hint?: ReactNode;
  testId?: string;
};

/**
 * The finance summary's four headline figures (ADMIN-DESIGN-001 Faz 3D,
 * prototip `finance`): label, a large figure, one coloured line and one muted
 * line. A description list, so each figure is read with its label; the cards
 * wrap onto more rows rather than widen the page.
 */
export function FinanceKpiRow({ items, label }: { items: FinanceKpi[]; label: string }) {
  return (
    <dl className="finance-kpi-row" aria-label={label}>
      {items.map((item, index) => (
        <div className="finance-kpi" key={index} data-testid={item.testId}>
          <dt className="finance-kpi-label">{item.label}</dt>
          <dd className="finance-kpi-value">{item.value}</dd>
          {item.delta ? (
            <dd className={`finance-kpi-delta tone-${item.deltaTone ?? 'neutral'}`}>{item.delta}</dd>
          ) : null}
          {item.hint ? <dd className="finance-kpi-hint">{item.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
