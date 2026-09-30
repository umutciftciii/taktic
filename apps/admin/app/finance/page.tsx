import { formatIsoDay } from '@taktic/shared';
import Link from 'next/link';
import {
  apiFetch,
  creditTxnTypeLabel,
  FinanceAnalyticsBucket,
  FinanceAnalyticsGroupBy,
  FinanceAnalyticsResponse,
  FinanceSummary,
  formatDateTime,
  formatPrice,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../lib/api';
import {
  formatLedgerSource,
  formatShortLira,
  formatSignedCount,
  gateLedgerSource,
} from '../../lib/finance-format';
import { formatCount } from '../../lib/pagination';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import {
  AnalyticsPeriod,
  FinanceAnalyticsToolbar,
} from '../../components/finance-analytics-toolbar';
import { FinanceKpiRow, type FinanceKpi } from '../../components/finance-kpi';
import { FinanceMonthBars, type MonthBar } from '../../components/finance-month-bars';
import {
  FinanceTrendPanel,
  FinanceTrendPoint,
} from '../../components/finance-trend-panel';
import {
  FinanceMiniSparkline,
  FinanceSparklinePoint,
} from '../../components/finance-mini-sparkline';
import { FinanceInsightCard } from '../../components/finance-insight-card';
import { FinanceProgressMetric } from '../../components/finance-progress-metric';
import {
  LedgerReasonCell,
  LedgerSourceCell,
  SignedCredits,
} from '../../components/ledger-cells';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';
import { StatCard } from '../../components/stat-card';

/**
 * The finance summary.
 *
 * ADMIN-DESIGN-001 Faz 3D (paket 2 `25-finans-ozeti`, prototip `finance`):
 * the design's hierarchy — four headline figures for the chosen period, a
 * monthly bar chart, and the most recent package sales — on real reads only.
 *
 * - The four figures are the analytics totals for the period in the toolbar.
 *   The fifth figure the old strip carried, "Satılan kredi", is not dropped
 *   (K7): it is the second figure's reference ("satılanın %…") and stays in
 *   "Kredi kullanımı".
 * - The bars are one more read of the same analytics endpoint, `groupBy=month`
 *   over the last six calendar months, so they do not move with the period.
 * - Everything the old screen showed is still below: the period trend with its
 *   three insights, package sales, credit use, manual intervention, all-time
 *   revenue and credit totals, the six package status counters, both recent
 *   tables and the quick links (K7).
 *
 * Not rendered: "Satılan kredi nereye gitti" (the API returns no breakdown of
 * spent credit by purpose) and "Rapor indir" (no export exists). The design's
 * "geçen aya göre +%18" is not drawn either: the analytics read has no
 * previous-period comparison, and a second read to invent one is not this
 * slice's to add.
 */

type RawSearchParams = {
  period?: string;
  from?: string;
  to?: string;
  groupBy?: string;
};

type AdminFinancePageProps = {
  searchParams: Promise<RawSearchParams>;
};

const GROUP_BY_LABEL: Record<FinanceAnalyticsGroupBy, string> = {
  day: 'günlük',
  month: 'aylık',
  year: 'yıllık',
};

const GROUP_BY_BUCKET_LABEL: Record<FinanceAnalyticsGroupBy, string> = {
  day: 'gün',
  month: 'ay',
  year: 'yıl',
};

// period → default groupBy. Only `custom` honors the user's groupBy override;
// preset periods always use a fixed groupBy so toolbar/URL stay coherent.
const PERIOD_DEFAULT_GROUP_BY: Record<AnalyticsPeriod, FinanceAnalyticsGroupBy> = {
  '7d': 'day',
  '30d': 'day',
  this_month: 'day',
  this_year: 'month',
  custom: 'day',
};

function normalizePeriod(value: string | undefined): AnalyticsPeriod {
  if (!value) return '30d';
  if (
    value === '7d' ||
    value === '30d' ||
    value === 'this_month' ||
    value === 'this_year' ||
    value === 'custom'
  ) {
    return value;
  }
  return '30d';
}

function normalizeGroupBy(value: string | undefined): FinanceAnalyticsGroupBy | undefined {
  if (value === 'day' || value === 'month' || value === 'year') return value;
  return undefined;
}

function normalizeIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined;
  return trimmed;
}

function istanbulTodayParts(): { year: number; month: number; day: number } {
  const [year = '1970', month = '01', day = '01'] = formatIsoDay(new Date()).split('-');
  return {
    year: Number.parseInt(year, 10),
    month: Number.parseInt(month, 10),
    day: Number.parseInt(day, 10),
  };
}

function formatIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDaysIso(iso: string, days: number): string {
  const [yStr, mStr, dStr] = iso.split('-');
  const t =
    Date.UTC(
      Number.parseInt(yStr ?? '1970', 10),
      Number.parseInt(mStr ?? '01', 10) - 1,
      Number.parseInt(dStr ?? '01', 10),
    ) +
    days * 86_400_000;
  const d = new Date(t);
  return formatIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

type ResolvedRange = {
  from: string;
  to: string;
  groupBy: FinanceAnalyticsGroupBy;
};

function resolveRange(params: {
  period: AnalyticsPeriod;
  customFrom?: string;
  customTo?: string;
  customGroupBy?: FinanceAnalyticsGroupBy;
}): ResolvedRange {
  const today = istanbulTodayParts();
  const todayIso = formatIsoDate(today.year, today.month, today.day);

  // Preset periods always use their canonical groupBy. Only `custom` honors
  // a user-provided groupBy.
  const groupBy =
    params.period === 'custom'
      ? params.customGroupBy ?? PERIOD_DEFAULT_GROUP_BY.custom
      : PERIOD_DEFAULT_GROUP_BY[params.period];

  switch (params.period) {
    case '7d':
      return { from: addDaysIso(todayIso, -6), to: todayIso, groupBy };
    case '30d':
      return { from: addDaysIso(todayIso, -29), to: todayIso, groupBy };
    case 'this_month':
      return { from: formatIsoDate(today.year, today.month, 1), to: todayIso, groupBy };
    case 'this_year':
      return {
        from: formatIsoDate(today.year, 1, 1),
        to: formatIsoDate(today.year, 12, 31),
        groupBy,
      };
    case 'custom': {
      const from = params.customFrom ?? addDaysIso(todayIso, -29);
      const to = params.customTo ?? todayIso;
      return { from, to, groupBy };
    }
  }
}

function bucketShortLabel(
  bucket: FinanceAnalyticsBucket,
  groupBy: FinanceAnalyticsGroupBy,
): string {
  if (groupBy === 'year') return bucket.label;
  if (groupBy === 'month') {
    const [, m] = bucket.key.split('-');
    return monthShortName(Number.parseInt(m ?? '1', 10));
  }
  const [, m, d] = bucket.key.split('-');
  return `${d}.${m}`;
}

function bucketLongLabel(
  bucket: FinanceAnalyticsBucket,
  groupBy: FinanceAnalyticsGroupBy,
): string {
  if (groupBy === 'year') return bucket.label;
  if (groupBy === 'month') {
    const [y, m] = bucket.key.split('-');
    return `${monthLongName(Number.parseInt(m ?? '1', 10))} ${y}`;
  }
  const [y, m, d] = bucket.key.split('-');
  return `${d}.${m}.${y}`;
}

const MONTH_SHORT = [
  'Oca',
  'Şub',
  'Mar',
  'Nis',
  'May',
  'Haz',
  'Tem',
  'Ağu',
  'Eyl',
  'Eki',
  'Kas',
  'Ara',
];

const MONTH_LONG = [
  'Ocak',
  'Şubat',
  'Mart',
  'Nisan',
  'Mayıs',
  'Haziran',
  'Temmuz',
  'Ağustos',
  'Eylül',
  'Ekim',
  'Kasım',
  'Aralık',
];

function monthShortName(month: number): string {
  return MONTH_SHORT[(month - 1 + 12) % 12] ?? String(month);
}

function monthLongName(month: number): string {
  return MONTH_LONG[(month - 1 + 12) % 12] ?? String(month);
}

function formatPercent(ratio: number | null, fractionDigits = 0): string {
  if (ratio === null || Number.isNaN(ratio) || !Number.isFinite(ratio)) return '—';
  return `%${(ratio * 100).toFixed(fractionDigits).replace('.', ',')}`;
}

function rangeSummaryText(range: ResolvedRange): string {
  return `${range.from} → ${range.to} · ${GROUP_BY_LABEL[range.groupBy]}`;
}

function toRevenueTrend(
  buckets: FinanceAnalyticsBucket[],
  groupBy: FinanceAnalyticsGroupBy,
): FinanceTrendPoint[] {
  return buckets.map((b) => ({
    key: b.key,
    label: bucketShortLabel(b, groupBy),
    longLabel: bucketLongLabel(b, groupBy),
    value: b.paidRevenue,
    displayValue: formatPrice(b.paidRevenue),
  }));
}

function toCountSparkline(
  buckets: FinanceAnalyticsBucket[],
  selector: (b: FinanceAnalyticsBucket) => number,
): FinanceSparklinePoint[] {
  return buckets.map((b) => ({ key: b.key, value: selector(b) }));
}

function pickPeak(
  buckets: FinanceAnalyticsBucket[],
  selector: (b: FinanceAnalyticsBucket) => number,
): { bucket: FinanceAnalyticsBucket; value: number } | null {
  if (buckets.length === 0) return null;
  let peak = buckets[0]!;
  let peakValue = selector(peak);
  for (let i = 1; i < buckets.length; i++) {
    const v = selector(buckets[i]!);
    if (v > peakValue) {
      peak = buckets[i]!;
      peakValue = v;
    }
  }
  if (peakValue <= 0) return null;
  return { bucket: peak, value: peakValue };
}


/** The design's ⓘ, corrected: package sales are credit packages *and* vitrin packages. */
const SCREEN_INFO =
  'Platformun geliri paket satışıdır: hizmet verenler kredi paketi ya da vitrin paketi alır, teklif verirken kredi harcar. Bu ekran parayı üç açıdan gösterir — ne kadar tahsil edildi, satılan kredinin ne kadarı harcandı, ne kadarı geri verildi. Tutarlar yalnız ödemesi onaylanmış satışlardan gelir.';

/** The last six calendar months, this one included, in Istanbul time. */
function lastSixMonthsRange(): { from: string; to: string } {
  const today = istanbulTodayParts();
  const monthIndex = today.year * 12 + (today.month - 1) - 5;
  const fromYear = Math.floor(monthIndex / 12);
  const fromMonth = (monthIndex % 12) + 1;
  return {
    from: formatIsoDate(fromYear, fromMonth, 1),
    to: formatIsoDate(today.year, today.month, today.day),
  };
}

function toMonthBars(buckets: FinanceAnalyticsBucket[]): MonthBar[] {
  return buckets.map((bucket) => ({
    key: bucket.key,
    label: bucketShortLabel(bucket, 'month'),
    longLabel: bucketLongLabel(bucket, 'month'),
    value: bucket.paidRevenue,
    shortValue: formatShortLira(bucket.paidRevenue),
    fullValue: formatPrice(bucket.paidRevenue),
  }));
}

const RECENT_PURCHASE_COLUMNS: DataColumn[] = [
  { key: 'number', label: 'Satın alma no' },
  { key: 'date', label: 'Tarih' },
  { key: 'provider', label: 'İşletme' },
  { key: 'package', label: 'Paket' },
  { key: 'credits', label: 'Kredi', align: 'end' },
  { key: 'amount', label: 'Tutar', align: 'end' },
  { key: 'status', label: 'Ödeme' },
  { key: 'reference', label: 'Ödeme referansı' },
];

const RECENT_TRANSACTION_COLUMNS: DataColumn[] = [
  { key: 'date', label: 'Tarih' },
  { key: 'provider', label: 'İşletme' },
  { key: 'type', label: 'Tip' },
  { key: 'amount', label: 'Kredi', align: 'end' },
  { key: 'balance', label: 'Bakiye', align: 'end' },
  { key: 'reason', label: 'Sebep' },
  { key: 'source', label: 'İlişkili kayıt' },
];

export default async function AdminFinanceDashboardPage({
  searchParams,
}: AdminFinancePageProps) {
  const { can } = await requireAdmin('FINANCE_READ');
  // Every link below leads to a screen with its own gate; each is shown only
  // when this session would get past it (the target page's requireAdmin).
  const canOpenLedger = can('FINANCE_LEDGER_READ');
  const canOpenPurchases = can('PACKAGE_PURCHASES_READ');
  const canOpenRefundScan = can('OFFER_REFUND_SCAN_READ');
  const canOpenManualAdjustments = can('FINANCE_LEDGER_READ');
  const canOpenCreditPackages = can('CREDIT_PACKAGES_READ');
  const canOpenProviders = can('PROVIDERS_READ');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const purchasesHref = (status: string) =>
    canOpenPurchases ? `/package-purchases?status=${status}` : undefined;

  const params = await searchParams;
  const period = normalizePeriod(params.period);
  const customGroupBy = normalizeGroupBy(params.groupBy);
  const customFrom = normalizeIsoDate(params.from);
  const customTo = normalizeIsoDate(params.to);
  const range = resolveRange({ period, customFrom, customTo, customGroupBy });

  const analyticsQuery = new URLSearchParams({
    from: range.from,
    to: range.to,
    groupBy: range.groupBy,
  });
  const monthsRange = lastSixMonthsRange();
  const monthsQuery = new URLSearchParams({ ...monthsRange, groupBy: 'month' });

  const [summary, analytics, months] = await Promise.all([
    apiFetch<FinanceSummary>('/finance/summary'),
    apiFetch<FinanceAnalyticsResponse>(`/finance/analytics?${analyticsQuery.toString()}`),
    apiFetch<FinanceAnalyticsResponse>(`/finance/analytics?${monthsQuery.toString()}`),
  ]);

  const { revenue, packagePurchases, credits, recentTransactions, recentPurchases } = summary;
  const { totals, buckets } = analytics;

  const revenueTrend = toRevenueTrend(buckets, range.groupBy);
  const packageSparkline = toCountSparkline(buckets, (b) => b.paidPackageCount);
  const soldCreditsSparkline = toCountSparkline(buckets, (b) => b.soldCredits);
  const monthBars = toMonthBars(months.buckets);

  const peakRevenue = pickPeak(buckets, (b) => b.paidRevenue);
  const peakPackage = pickPeak(buckets, (b) => b.paidPackageCount);

  const creditUsageRatio =
    totals.soldCredits > 0 ? totals.spentCredits / totals.soldCredits : null;
  const refundRatio =
    totals.spentCredits > 0 ? totals.refundedCredits / totals.spentCredits : null;
  const manualNetCredits = totals.adminGrantedCredits - totals.adminDeductedCredits;
  const manualGrossActivity =
    totals.adminGrantedCredits + totals.adminDeductedCredits;

  const bucketUnit = GROUP_BY_BUCKET_LABEL[range.groupBy];

  const kpis: FinanceKpi[] = [
    {
      label: 'Tahsilat',
      value: formatPrice(totals.paidRevenue),
      delta: `${formatCount(totals.paidPackageCount)} paket ödendi`,
      deltaTone: totals.paidRevenue > 0 ? 'success' : 'neutral',
      hint:
        totals.paidPackageCount > 0
          ? `Paket başına ortalama ${formatPrice(Math.round(totals.paidRevenue / totals.paidPackageCount))}`
          : 'Bu dönemde ödenmiş paket yok',
      testId: 'finance-kpi-revenue',
    },
    {
      label: 'Harcanan kredi',
      value: formatCount(totals.spentCredits),
      delta:
        creditUsageRatio === null
          ? 'Bu dönemde kredi satılmadı'
          : `Satılanın ${formatPercent(creditUsageRatio)}'i`,
      hint: `Satılan kredi: ${formatCount(totals.soldCredits)}`,
      testId: 'finance-kpi-spent',
    },
    {
      label: 'İade edilen kredi',
      value: formatCount(totals.refundedCredits),
      delta:
        refundRatio === null ? 'Bu dönemde harcama yok' : `Harcananın ${formatPercent(refundRatio)}'i`,
      deltaTone: totals.refundedCredits > 0 ? 'warning' : 'neutral',
      hint: 'Teklif iadesiyle bakiyeye dönen kredi',
      testId: 'finance-kpi-refunded',
    },
    {
      label: 'Elle yapılan düzeltme',
      value: `${formatSignedCount(manualNetCredits)} kredi`,
      delta:
        manualGrossActivity > 0
          ? `+${formatCount(totals.adminGrantedCredits)} eklendi · -${formatCount(totals.adminDeductedCredits)} düşüldü`
          : 'Manuel işlem yok',
      deltaTone: manualNetCredits > 0 ? 'success' : manualNetCredits < 0 ? 'warning' : 'neutral',
      hint: 'Yönetici eliyle eklenen / düşülen',
      testId: 'finance-kpi-manual',
    },
  ];

  return (
    <main className="finance-summary-page">
      <PageHeader
        title="Finans"
        subtitle={rangeSummaryText(range)}
        info={SCREEN_INFO}
        actions={
          canOpenLedger || canOpenPurchases || canOpenRefundScan ? (
            <>
              {canOpenLedger ? (
                <Link className="btn btn-secondary btn-sm" href="/finance/credit-ledger">
                  Kredi hareketleri
                </Link>
              ) : null}
              {canOpenPurchases ? (
                <Link className="btn btn-secondary btn-sm" href="/package-purchases">
                  Paket satışları
                </Link>
              ) : null}
              {canOpenRefundScan ? (
                <Link className="btn btn-secondary btn-sm" href="/refund-scan">
                  İade kontrolü
                </Link>
              ) : null}
            </>
          ) : undefined
        }
      />

      <FinanceAnalyticsToolbar
        initialPeriod={period}
        initialFrom={range.from}
        initialTo={range.to}
        initialGroupBy={range.groupBy}
        summary={rangeSummaryText(range)}
      />

      <FinanceKpiRow items={kpis} label={`Dönem özeti (${range.from} → ${range.to})`} />

      <div className="finance-headline-grid">
        <SectionCard
          title="Aylık tahsilat"
          subtitle={`Son 6 ay · ${months.range.from} → ${months.range.to}`}
          className="finance-month-card"
        >
          {monthBars.every((bar) => bar.value === 0) ? (
            <p className="detail-muted-note">Son altı ayda ödenmiş paket yok.</p>
          ) : null}
          <FinanceMonthBars bars={monthBars} label="Aylık tahsilat, son 6 ay" />
        </SectionCard>

        <SectionCard title="Kredi kullanımı" subtitle="Satılan kredinin harcama ve iade akışı.">
          <div className="finance-progress-stack">
            <FinanceProgressMetric
              label="Kullanım oranı"
              value={formatPercent(creditUsageRatio)}
              ratio={creditUsageRatio}
              tone="primary"
              hint={`Harcanan ${formatCount(totals.spentCredits)} / Satılan ${formatCount(totals.soldCredits)}`}
            />
            <FinanceProgressMetric
              label="İade oranı"
              value={formatPercent(refundRatio)}
              ratio={refundRatio}
              tone="warning"
              hint={`İade edilen ${formatCount(totals.refundedCredits)} / Harcanan ${formatCount(totals.spentCredits)}`}
            />
            <div className="finance-mini-sparkline-row">
              <div className="finance-mini-sparkline-row-label">Satılan kredi trendi</div>
              <FinanceMiniSparkline
                data={soldCreditsSparkline}
                tone="success"
                ariaLabel="Satılan kredi mini trend"
              />
            </div>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Son paket satışları"
        subtitle={`En son ${recentPurchases.length} kayıt`}
        padded={false}
        actions={
          canOpenPurchases ? (
            <Link className="btn btn-link btn-sm" href="/package-purchases">
              Tümünü gör
            </Link>
          ) : undefined
        }
      >
        {recentPurchases.length === 0 ? (
          <EmptyState
            title="Henüz paket satın alma yok"
            description="Hizmet verenler paket aldıkça burada görünür."
          />
        ) : (
          <DataTable
            caption="Son paket satışları"
            columns={RECENT_PURCHASE_COLUMNS}
            minWidth={980}
            testId="finance-recent-purchases"
          >
            {recentPurchases.map((purchase) => {
              const purchaseRef = purchase.purchaseNumber ?? `#${purchase.id.slice(-8)}`;
              return (
                <tr key={purchase.id}>
                  <td>
                    {canOpenPurchases ? (
                      <Link href={`/package-purchases/${purchase.id}`}>
                        <code className="display-number">{purchaseRef}</code>
                      </Link>
                    ) : (
                      <code className="display-number">{purchaseRef}</code>
                    )}
                  </td>
                  <td className="cell-nowrap">{formatDateTime(purchase.createdAt)}</td>
                  <td className="cell-break">
                    {canOpenProvider ? (
                      <Link href={`/providers/${purchase.providerId}`}>
                        <strong>{purchase.provider.businessName}</strong>
                      </Link>
                    ) : (
                      <strong>{purchase.provider.businessName}</strong>
                    )}
                  </td>
                  <td className="cell-break">
                    {canOpenPurchases ? (
                      <Link href={`/package-purchases/${purchase.id}`}>{purchase.packageNameSnapshot}</Link>
                    ) : (
                      purchase.packageNameSnapshot
                    )}
                  </td>
                  <td className="is-num">{formatCount(purchase.creditAmountSnapshot)}</td>
                  <td className="is-num cell-nowrap">
                    <strong>{formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}</strong>
                  </td>
                  <td>
                    <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span>
                  </td>
                  <td className="cell-muted cell-break">{purchase.mockPaymentReference ?? '—'}</td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </SectionCard>

      <SectionCard padded={false} className="finance-trend-section">
        <FinanceTrendPanel
          title="Tahsilat trendi"
          subtitle={`${rangeSummaryText(range)} · ${buckets.length} ${bucketUnit}`}
          total={formatPrice(totals.paidRevenue)}
          data={revenueTrend}
          tone="success"
          emptyMessage="Bu dönem için tahsilat yok."
          footer={
            <div className="finance-trend-insights">
              <FinanceInsightCard
                label={`En yüksek ${bucketUnit}`}
                value={peakRevenue ? formatPrice(peakRevenue.value) : '—'}
                hint={
                  peakRevenue
                    ? bucketLongLabel(peakRevenue.bucket, range.groupBy)
                    : 'Tahsilat kaydı yok'
                }
                tone={peakRevenue ? 'success' : 'neutral'}
              />
              <FinanceInsightCard
                label="Toplam paket"
                value={formatCount(totals.paidPackageCount)}
                hint={
                  peakPackage
                    ? `Zirve: ${bucketLongLabel(peakPackage.bucket, range.groupBy)} (${formatCount(peakPackage.value)})`
                    : 'Bu dönemde paket satışı yok'
                }
              />
              <FinanceInsightCard
                label="Ortalama / bucket"
                value={
                  buckets.length > 0
                    ? formatPrice(Math.round(totals.paidRevenue / buckets.length))
                    : '—'
                }
                hint={`${buckets.length} ${bucketUnit} ortalaması`}
              />
            </div>
          }
        />
      </SectionCard>

      <div className="finance-two-col">
        <SectionCard
          title="Paket satışları"
          subtitle="Dönem boyunca ödenmiş paket adetleri."
        >
          <div className="finance-mini-section">
            <div className="finance-mini-stat">
              <div className="finance-mini-stat-label">Toplam paket</div>
              <div className="finance-mini-stat-value">
                {formatCount(totals.paidPackageCount)}
              </div>
              <div className="finance-mini-stat-hint">
                {peakPackage
                  ? `Zirve: ${bucketLongLabel(peakPackage.bucket, range.groupBy)} · ${formatCount(peakPackage.value)}`
                  : 'Bu dönemde paket satışı yok'}
              </div>
            </div>
            <FinanceMiniSparkline
              data={packageSparkline}
              tone="primary"
              ariaLabel="Paket satışları mini trend"
            />
          </div>
        </SectionCard>

        <SectionCard
          title="Operasyonel müdahale"
          subtitle="Adminlerin manuel kredi eklemesi ve düşmesi."
        >
          <div className="finance-manual-grid">
            <FinanceInsightCard
              label="Eklenen kredi"
              value={formatCount(totals.adminGrantedCredits)}
              tone={totals.adminGrantedCredits > 0 ? 'success' : 'neutral'}
              hint="Manuel olarak provider bakiyesine eklendi"
            />
            <FinanceInsightCard
              label="Düşülen kredi"
              value={formatCount(totals.adminDeductedCredits)}
              tone={totals.adminDeductedCredits > 0 ? 'warning' : 'neutral'}
              hint="Manuel olarak provider bakiyesinden düşüldü"
            />
            <FinanceInsightCard
              label="Manuel net etki"
              value={formatSignedCount(manualNetCredits)}
              tone={
                manualNetCredits > 0
                  ? 'success'
                  : manualNetCredits < 0
                    ? 'warning'
                    : 'neutral'
              }
              hint={
                manualGrossActivity === 0
                  ? 'Bu dönemde manuel işlem yok'
                  : manualNetCredits === 0
                    ? 'Ekleme ve düşme dengeli'
                    : manualNetCredits > 0
                      ? 'Sisteme net kredi eklendi'
                      : 'Sistemden net kredi düşüldü'
              }
            />
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Tahsilat" subtitle="Ödenmiş paketlerden gelen toplam gelir.">
        <div className="stat-grid">
          <StatCard label="Toplam tahsilat" value={formatPrice(revenue.totalRevenuePaid)} />
          <StatCard label="Bugünkü tahsilat" value={formatPrice(revenue.todayRevenuePaid)} />
          <StatCard label="Bu ay tahsilat" value={formatPrice(revenue.monthRevenuePaid)} />
        </div>
      </SectionCard>

      <SectionCard title="Kredi hareketleri" subtitle="Tüm zaman toplamları ve sistem geneli aktif bakiye.">
        <div className="stat-grid">
          <StatCard label="Satılan kredi" value={formatCount(credits.totalCreditsSold)} />
          <StatCard label="Harcanan kredi" value={formatCount(credits.totalCreditsSpent)} />
          <StatCard
            label="İade edilen kredi"
            value={formatCount(credits.totalCreditsRefunded)}
            tone={credits.totalCreditsRefunded > 0 ? 'warning' : 'neutral'}
          />
          <StatCard
            label="Manuel eklenen kredi"
            value={formatCount(credits.totalCreditsAdminGranted)}
          />
          <StatCard
            label="Manuel düşülen kredi"
            value={formatCount(credits.totalCreditsAdminDeducted)}
            tone={credits.totalCreditsAdminDeducted > 0 ? 'warning' : 'neutral'}
          />
          <StatCard
            label="Aktif provider kredi bakiyesi"
            value={formatCount(credits.totalActiveProviderCreditBalance)}
            hint="Tüm hizmet verenlerin son bakiyelerinin toplamı"
            tone="success"
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Paket talep durumları"
        subtitle={`Toplam ${formatCount(packagePurchases.totalPackagePurchases)} kayıt`}
      >
        <div className="stat-grid">
          <StatCard
            label="Ödenmiş"
            value={formatCount(packagePurchases.paidPackagePurchases)}
            href={purchasesHref('PAID')}
            tone="success"
          />
          <StatCard
            label="Bekleyen"
            value={formatCount(packagePurchases.pendingPackagePurchases)}
            href={purchasesHref('PENDING')}
            tone={packagePurchases.pendingPackagePurchases > 0 ? 'warning' : 'neutral'}
          />
          <StatCard
            label="İptal"
            value={formatCount(packagePurchases.cancelledPackagePurchases)}
            href={purchasesHref('CANCELLED')}
          />
          <StatCard
            label="Başarısız"
            value={formatCount(packagePurchases.failedPackagePurchases)}
            href={purchasesHref('FAILED')}
            tone={packagePurchases.failedPackagePurchases > 0 ? 'error' : 'neutral'}
          />
          <StatCard
            label="Süresi dolmuş"
            value={formatCount(packagePurchases.expiredPackagePurchases)}
            href={purchasesHref('EXPIRED')}
          />
          <StatCard
            label="İade edilmiş"
            value={formatCount(packagePurchases.refundedPackagePurchases)}
            href={purchasesHref('REFUNDED')}
            tone={packagePurchases.refundedPackagePurchases > 0 ? 'warning' : 'neutral'}
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Son kredi hareketleri"
        subtitle={`En son ${recentTransactions.length} işlem`}
        padded={false}
        actions={
          canOpenLedger ? (
            <Link className="btn btn-link btn-sm" href="/finance/credit-ledger">
              Tümünü gör
            </Link>
          ) : undefined
        }
      >
        {recentTransactions.length === 0 ? (
          <EmptyState
            title="Henüz kredi hareketi yok"
            description="Paket ödendiğinde, teklif gönderildiğinde veya manuel işlem yapıldığında burada görünür."
          />
        ) : (
          <DataTable
            caption="Son kredi hareketleri"
            columns={RECENT_TRANSACTION_COLUMNS}
            minWidth={960}
            testId="finance-recent-transactions"
          >
            {recentTransactions.map((transaction) => {
              const source = gateLedgerSource(
                formatLedgerSource(
                  transaction.referenceType,
                  transaction.referenceId,
                  transaction.sourceNumber,
                ),
                can,
              );
              return (
                <tr key={transaction.id}>
                  <td className="cell-nowrap">{formatDateTime(transaction.createdAt)}</td>
                  <td className="cell-break">
                    {canOpenLedger ? (
                      <Link href={`/providers/${transaction.providerId}/credits`}>
                        {transaction.provider.businessName}
                      </Link>
                    ) : (
                      transaction.provider.businessName
                    )}
                  </td>
                  <td>{creditTxnTypeLabel(transaction.type)}</td>
                  <td className="is-num">
                    <SignedCredits amount={transaction.amount} />
                  </td>
                  <td className="is-num">{formatCount(transaction.balanceAfter)}</td>
                  <td>
                    <LedgerReasonCell reason={transaction.reason} />
                  </td>
                  <td>
                    <LedgerSourceCell source={source} />
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </SectionCard>

      <SectionCard title="Hızlı bağlantılar" subtitle="Sık kullanılan finans ekranları.">
        <div className="inline-actions">
          {canOpenLedger ? (
            <Link className="btn btn-secondary btn-sm" href="/finance/credit-ledger">
              Kredi hareketleri
            </Link>
          ) : null}
          {canOpenManualAdjustments ? (
            <Link className="btn btn-secondary btn-sm" href="/finance/manual-adjustments">
              Elle kredi işlemleri
            </Link>
          ) : null}
          <Link className="btn btn-secondary btn-sm" href="/finance/providers">
            İşletme bakiyeleri
          </Link>
          {canOpenPurchases ? (
            <Link className="btn btn-secondary btn-sm" href="/package-purchases">
              Paket satışları
            </Link>
          ) : null}
          {canOpenRefundScan ? (
            <Link className="btn btn-secondary btn-sm" href="/refund-scan">
              İade kontrolü
            </Link>
          ) : null}
          {canOpenCreditPackages ? (
            <Link className="btn btn-secondary btn-sm" href="/credit-packages">
              Kredi paketleri
            </Link>
          ) : null}
          {canOpenProviders ? (
            <Link className="btn btn-secondary btn-sm" href="/providers">
              Hizmet verenler
            </Link>
          ) : null}
        </div>
      </SectionCard>
    </main>
  );
}
