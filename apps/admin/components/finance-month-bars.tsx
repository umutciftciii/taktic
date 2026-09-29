import type { CSSProperties } from 'react';

export type MonthBar = {
  key: string;
  /** "Eyl" */
  label: string;
  /** "Eylül 2026", for the screen reader and the tooltip. */
  longLabel: string;
  /** The bucket's own integer (kuruş); only compared, never divided for display here. */
  value: number;
  /** Short figure drawn above the bar ("184,3 B ₺"). */
  shortValue: string;
  /** The exact figure ("₺184.300,00"). */
  fullValue: string;
};

/**
 * "Aylık tahsilat": one bar per month from the finance analytics read
 * (`groupBy=month`), the current month in the accent colour — the prototype's
 * `finance` bar chart, on real buckets. Heights are relative to the tallest
 * month; a month with nothing sold is an empty track with a 0 above it.
 *
 * It is a list, not a picture: each month is an item whose text says the month
 * and the exact figure, so a screen reader hears the same numbers the bars
 * draw.
 */
export function FinanceMonthBars({ bars, label }: { bars: MonthBar[]; label: string }) {
  const peak = bars.reduce((max, bar) => Math.max(max, bar.value), 0);
  return (
    <ol className="finance-month-bars" aria-label={label} data-testid="finance-month-bars">
      {bars.map((bar, index) => {
        const ratio = peak > 0 ? bar.value / peak : 0;
        const isCurrent = index === bars.length - 1;
        return (
          <li
            key={bar.key}
            className={isCurrent ? 'finance-month-bar is-current' : 'finance-month-bar'}
            data-month={bar.key}
            data-value={bar.value}
            title={`${bar.longLabel}: ${bar.fullValue}`}
          >
            <span className="finance-month-bar-value" aria-hidden="true">
              {bar.shortValue}
            </span>
            <span className="finance-month-bar-track" aria-hidden="true">
              <span
                className="finance-month-bar-fill"
                style={{ '--bar-ratio': ratio.toFixed(4) } as CSSProperties}
              />
            </span>
            <span className="finance-month-bar-label" aria-hidden="true">
              {bar.label}
            </span>
            <span className="sr-only">{`${bar.longLabel}: ${bar.fullValue}`}</span>
          </li>
        );
      })}
    </ol>
  );
}
