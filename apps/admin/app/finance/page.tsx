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
import { formatLedgerReason, formatLedgerSource } from '../../lib/finance-format';
import { EmptyState } from '../../components/empty-state';
import {
  AnalyticsPeriod,
  FinanceAnalyticsToolbar,
} from '../../components/finance-analytics-toolbar';
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
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';
import { StatCard } from '../../components/stat-card';

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
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [year = '1970', month = '01', day = '01'] = formatter.format(new Date()).split('-');
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

const COUNT_FORMATTER = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });

function formatCount(value: number): string {
  return COUNT_FORMATTER.format(value);
}

function formatPercent(ratio: number | null, fractionDigits = 0): string {
  if (ratio === null || Number.isNaN(ratio) || !Number.isFinite(ratio)) return '—';
  return `%${(ratio * 100).toFixed(fractionDigits).replace('.', ',')}`;
}

function formatSignedCount(value: number): string {
  if (value > 0) return `+${formatCount(value)}`;
  return formatCount(value);
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

export default async function AdminFinanceDashboardPage({
  searchParams,
}: AdminFinancePageProps) {
  await requireAdmin();

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

  const [summary, analytics] = await Promise.all([
    apiFetch<FinanceSummary>('/finance/summary'),
    apiFetch<FinanceAnalyticsResponse>(
      `/finance/analytics?${analyticsQuery.toString()}`,
    ),
  ]);

  const { revenue, packagePurchases, credits, recentTransactions, recentPurchases } = summary;
  const { totals, buckets } = analytics;

  const revenueTrend = toRevenueTrend(buckets, range.groupBy);
  const packageSparkline = toCountSparkline(buckets, (b) => b.paidPackageCount);
  const soldCreditsSparkline = toCountSparkline(buckets, (b) => b.soldCredits);

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

  return (
    <main>
      <PageHeader
        title="Finans"
        subtitle="Tahsilat, kredi hareketleri ve paket talep durumlarına dair özet."
        actions={
          <>
            <Link className="btn btn-secondary btn-sm" href="/finance/credit-ledger">
              Kredi Hareketleri
            </Link>
            <Link className="btn btn-secondary btn-sm" href="/package-purchases">
              Paket Satın Almaları
            </Link>
            <Link className="btn btn-ghost btn-sm" href="/refund-scan">
              İade Taraması
            </Link>
          </>
        }
      />

      <FinanceAnalyticsToolbar
        initialPeriod={period}
        initialFrom={range.from}
        initialTo={range.to}
        initialGroupBy={range.groupBy}
        summary={rangeSummaryText(range)}
      />

      <SectionCard
        title="Dönem özeti"
        subtitle={`Seçilen aralık (${range.from} → ${range.to}) için toplamlar.`}
      >
        <div className="stat-grid">
          <StatCard
            label="Toplam tahsilat"
            value={formatPrice(totals.paidRevenue)}
            hint={`${formatCount(totals.paidPackageCount)} paket`}
            tone={totals.paidRevenue > 0 ? 'success' : 'neutral'}
          />
          <StatCard label="Satılan kredi" value={formatCount(totals.soldCredits)} />
          <StatCard label="Harcanan kredi" value={formatCount(totals.spentCredits)} />
          <StatCard
            label="İade edilen kredi"
            value={formatCount(totals.refundedCredits)}
            tone={totals.refundedCredits > 0 ? 'warning' : 'neutral'}
          />
          <StatCard
            label="Manuel net kredi"
            value={formatSignedCount(manualNetCredits)}
            hint={
              manualGrossActivity > 0
                ? `+${formatCount(totals.adminGrantedCredits)} / -${formatCount(totals.adminDeductedCredits)}`
                : 'Manuel işlem yok'
            }
            tone={
              manualNetCredits > 0
                ? 'success'
                : manualNetCredits < 0
                  ? 'warning'
                  : 'neutral'
            }
          />
        </div>
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
                value={
                  peakRevenue ? formatPrice(peakRevenue.value) : '—'
                }
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
          title="Kredi kullanımı"
          subtitle="Satılan kredinin harcama ve iade akışı."
        >
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
            href="/package-purchases?status=PAID"
            tone="success"
          />
          <StatCard
            label="Bekleyen"
            value={formatCount(packagePurchases.pendingPackagePurchases)}
            href="/package-purchases?status=PENDING"
            tone={packagePurchases.pendingPackagePurchases > 0 ? 'warning' : 'neutral'}
          />
          <StatCard
            label="İptal"
            value={formatCount(packagePurchases.cancelledPackagePurchases)}
            href="/package-purchases?status=CANCELLED"
          />
          <StatCard
            label="Başarısız"
            value={formatCount(packagePurchases.failedPackagePurchases)}
            href="/package-purchases?status=FAILED"
            tone={packagePurchases.failedPackagePurchases > 0 ? 'error' : 'neutral'}
          />
          <StatCard
            label="Süresi dolmuş"
            value={formatCount(packagePurchases.expiredPackagePurchases)}
            href="/package-purchases?status=EXPIRED"
          />
          <StatCard
            label="İade edilmiş"
            value={formatCount(packagePurchases.refundedPackagePurchases)}
            href="/package-purchases?status=REFUNDED"
            tone={packagePurchases.refundedPackagePurchases > 0 ? 'warning' : 'neutral'}
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Son kredi hareketleri"
        subtitle={`En son ${recentTransactions.length} işlem`}
        padded={false}
      >
        {recentTransactions.length === 0 ? (
          <EmptyState
            title="Henüz kredi hareketi yok"
            description="Paket ödendiğinde, teklif gönderildiğinde veya manuel işlem yapıldığında burada görünür."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Hizmet Veren</th>
                  <th>Tip</th>
                  <th className="col-num">Kredi</th>
                  <th className="col-num">Bakiye</th>
                  <th>Sebep</th>
                  <th>İlişkili Kayıt</th>
                </tr>
              </thead>
              <tbody>
                {recentTransactions.map((transaction) => {
                  const reason = formatLedgerReason(transaction.reason);
                  const source = formatLedgerSource(
                    transaction.referenceType,
                    transaction.referenceId,
                  );
                  return (
                    <tr key={transaction.id}>
                      <td>{formatDateTime(transaction.createdAt)}</td>
                      <td>
                        <Link href={`/providers/${transaction.providerId}/credits`}>
                          {transaction.provider.businessName}
                        </Link>
                      </td>
                      <td>{creditTxnTypeLabel(transaction.type)}</td>
                      <td className="col-num">
                        <strong>
                          {transaction.amount > 0 ? `+${transaction.amount}` : transaction.amount}
                        </strong>
                      </td>
                      <td className="col-num">{transaction.balanceAfter}</td>
                      <td>
                        {reason ? (
                          <div className="cell-stack">
                            <span>{reason.label}</span>
                            {reason.note ? (
                              <span className="cell-muted" style={{ fontSize: 12 }}>
                                Not: {reason.note}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td>
                        {source.isSystem ? (
                          <span className="muted" style={{ fontSize: 12 }}>
                            {source.label}
                          </span>
                        ) : source.href ? (
                          <Link href={source.href}>
                            <span className="cell-stack">
                              <span>{source.label}</span>
                              {source.shortId ? (
                                <span className="cell-muted" style={{ fontSize: 11 }}>
                                  Kısa ID: {source.shortId}
                                </span>
                              ) : null}
                            </span>
                          </Link>
                        ) : (
                          <div className="cell-stack">
                            <span>{source.label}</span>
                            {source.shortId ? (
                              <span className="cell-muted" style={{ fontSize: 11 }}>
                                Kısa ID: {source.shortId}
                              </span>
                            ) : null}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Son paket satın almaları"
        subtitle={`En son ${recentPurchases.length} kayıt`}
        padded={false}
      >
        {recentPurchases.length === 0 ? (
          <EmptyState
            title="Henüz paket satın alma yok"
            description="Hizmet verenler paket aldıkça burada görünür."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Hizmet Veren</th>
                  <th>Paket</th>
                  <th className="col-num">Kredi</th>
                  <th className="col-num">Tutar</th>
                  <th>Durum</th>
                  <th>Ödeme Referansı</th>
                </tr>
              </thead>
              <tbody>
                {recentPurchases.map((purchase) => (
                  <tr key={purchase.id}>
                    <td>{formatDateTime(purchase.createdAt)}</td>
                    <td>
                      <Link href={`/providers/${purchase.providerId}`}>
                        {purchase.provider.businessName}
                      </Link>
                    </td>
                    <td>
                      <Link href={`/package-purchases/${purchase.id}`}>
                        {purchase.packageNameSnapshot}
                      </Link>
                    </td>
                    <td className="col-num">{purchase.creditAmountSnapshot}</td>
                    <td className="col-num">
                      {formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}
                    </td>
                    <td>
                      <span className={statusBadgeClass(purchase.status)}>
                        {statusLabel(purchase.status)}
                      </span>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {purchase.mockPaymentReference ?? '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Hızlı bağlantılar" subtitle="Sık kullanılan finans ekranları.">
        <div className="inline-actions">
          <Link className="btn btn-primary btn-sm" href="/finance/credit-ledger">
            Kredi Hareketleri
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/finance/manual-adjustments">
            Manuel İşlemler
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/finance/providers">
            Provider Finans Bakiyeleri
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/package-purchases">
            Paket Satın Almaları
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/refund-scan">
            İade Taraması
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/credit-packages">
            Kredi Paketleri
          </Link>
          <Link className="btn btn-ghost btn-sm" href="/providers">
            Hizmet Verenler
          </Link>
        </div>
      </SectionCard>
    </main>
  );
}
