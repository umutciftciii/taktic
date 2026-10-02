import { formatMinorAsTurkishLira } from '@taktic/shared';
import type { PackagePurchaseSummary } from '../../../lib/api';
import { formatCount } from '../../../lib/pagination';
import type { SummaryItem } from '../../../components/summary-strip';

/** The sales tab's page size: the newest sales first, ten to a page. */
export const SHOWCASE_SALES_PAGE_SIZE = 10;

/** `GET /package-purchases` and `/summary`, narrowed to one vitrin package on the server. */
export function showcasePackageSalesQuery(packageId: string, page?: number): string {
  const query = new URLSearchParams({ showcasePackageId: packageId });
  if (page !== undefined) {
    query.set('page', String(page));
    query.set('pageSize', String(SHOWCASE_SALES_PAGE_SIZE));
  }
  return query.toString();
}

/**
 * "Satış özeti", from the API's own count of this package's purchases
 * (`GET /package-purchases/summary?showcasePackageId=`, ADMIN-BACKEND-TRUTH-001).
 *
 * Every figure is the database's over the whole filtered set — not a sum over
 * the rows this page happened to fetch, which is what the tab used to draw
 * (the purchase list read whole and filtered here). The rights figure is the
 * rights' effective status as the API derives it; nothing is inferred from a
 * purchase "having no run".
 */
export function showcasePackageSalesFacts(summary: PackagePurchaseSummary, packageCurrency: string): SummaryItem[] {
  const revenue = summary.paidRevenue;
  const rights = summary.entitlements;
  return [
    {
      label: 'Toplam satış',
      value: formatCount(summary.total),
      note: `${formatCount(summary.byStatus.PAID)} ödenmiş · ${formatCount(summary.byStatus.PENDING)} bekleyen`,
      testId: 'showcase-sales-total',
    },
    {
      label: 'Toplam ciro',
      value:
        revenue.length === 0
          ? formatMinorAsTurkishLira(0, packageCurrency)
          : revenue.length === 1
            ? formatMinorAsTurkishLira(revenue[0]!.amount, revenue[0]!.currency)
            : 'Çoklu para birimi',
      note:
        revenue.length > 1
          ? revenue.map((entry) => formatMinorAsTurkishLira(entry.amount, entry.currency)).join(' · ')
          : 'ödenmiş satışlar',
      testId: 'showcase-sales-revenue',
    },
    {
      label: 'Şu an yayında',
      value: formatCount(summary.activeRuns),
      note: 'yayın süresi içinde',
      testId: 'showcase-sales-live',
    },
    {
      label: 'Kullanılabilir hak',
      value: formatCount(rights.AVAILABLE),
      note: `${formatCount(rights.RESERVED)} karta bağlı · ${formatCount(rights.CONSUMED)} kullanıldı · ${formatCount(rights.EXPIRED)} süresi doldu`,
      testId: 'showcase-sales-rights',
    },
  ];
}
