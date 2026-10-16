import type { OfferAllowanceReport, OfferAllowanceReportGroupBy, OfferAllowanceUsageFigures } from './api';

/**
 * SHOWCASE-ALLOWANCE-002 — how the free vitrin offer report writes its figures.
 *
 * Pure functions, so the rules that matter — an unvalued figure is "N/A", never
 * ₺0; a list price is a reference, never a value — are tested without a page.
 */

const tryFormat = new Intl.NumberFormat('tr-TR', {
  style: 'currency',
  currency: 'TRY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const NOT_AVAILABLE = 'N/A';

/** Kuruş as lira; `null` (no rate for the month) is N/A, never ₺0,00. */
export function formatMinorOrNa(amountMinor: number | null): string {
  return amountMinor === null ? NOT_AVAILABLE : tryFormat.format(amountMinor / 100);
}

/** The indicative TL value of a usage figure, with the unvalued part named. */
export function describeIndicativeValue(usage: OfferAllowanceUsageFigures): { value: string; note: string | null } {
  if (usage.credits === 0) {
    return { value: tryFormat.format(0), note: null };
  }
  if (usage.indicativeValueMinor === null) {
    return { value: NOT_AVAILABLE, note: 'Kullanım ayında ödenmiş kredi paketi satışı yok' };
  }
  if (usage.unvaluedCredits > 0) {
    return {
      value: tryFormat.format(usage.indicativeValueMinor / 100),
      note: `${usage.unvaluedCredits} kredi değerlenemedi (N/A)`,
    };
  }
  return { value: tryFormat.format(usage.indicativeValueMinor / 100), note: null };
}

const monthFormat = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** `2026-10` → "Ekim 2026"; `2026-10-01` → "01.10.2026"; a year stays as it is. */
export function formatBucket(bucket: string, groupBy: OfferAllowanceReportGroupBy): string {
  if (groupBy === 'year') return bucket;
  const [year, month, day] = bucket.split('-');
  if (groupBy === 'month') {
    const formatted = monthFormat.format(new Date(Date.UTC(Number(year), Number(month) - 1, 1)));
    return formatted.charAt(0).toLocaleUpperCase('tr-TR') + formatted.slice(1);
  }
  return `${day}.${month}.${year}`;
}

export function formatIsoDayTr(isoDay: string): string {
  const [year, month, day] = isoDay.split('-');
  return `${day}.${month}.${year}`;
}

/** The report window in words. Both ends are Istanbul civil days. */
export function describeWindow(range: OfferAllowanceReport['range']): string {
  if (range.from && range.to) return `${formatIsoDayTr(range.from)} – ${formatIsoDayTr(range.to)}`;
  if (range.from) return `${formatIsoDayTr(range.from)} ve sonrası`;
  if (range.to) return `${formatIsoDayTr(range.to)} ve öncesi`;
  return 'Tüm zamanlar';
}

/** Kuruş per credit with its two decimals, as lira. */
export function formatPerCredit(perCreditMinor: number | null): string {
  return perCreditMinor === null ? NOT_AVAILABLE : tryFormat.format(perCreditMinor / 100);
}
