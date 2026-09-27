import type { ReactNode } from 'react';

export type SummaryItem = {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  testId?: string;
};

/**
 * A detail screen's summary strip: a handful of labelled figures under the
 * title card ("Kredi bakiyesi · Bu ay verdiği teklif · …"). A description list,
 * so each figure is read with its label; the cells wrap onto more rows rather
 * than widen the page, and a long value breaks instead of overflowing.
 */
export function SummaryStrip({ items, label }: { items: SummaryItem[]; label?: string }) {
  return (
    <dl className="summary-strip" aria-label={label}>
      {items.map((item, index) => (
        <div className="summary-strip-item" key={index} data-testid={item.testId}>
          <dt>{item.label}</dt>
          <dd className={`summary-strip-value tone-${item.tone ?? 'neutral'}`}>{item.value}</dd>
          {item.note ? <dd className="summary-strip-note">{item.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
