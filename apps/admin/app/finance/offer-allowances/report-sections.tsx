import Link from 'next/link';
import type {
  OfferAllowanceCohortFigures,
  OfferAllowanceReport,
  OfferAllowanceUsageFigures,
} from '../../../lib/api';
import { formatCount } from '../../../lib/pagination';
import {
  describeIndicativeValue,
  formatBucket,
  formatMinorOrNa,
  formatPerCredit,
} from '../../../lib/offer-allowance-report';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { FinanceKpiRow, type FinanceKpi } from '../../../components/finance-kpi';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';

/**
 * SHOWCASE-ALLOWANCE-002 — the pieces of the free vitrin offer report. Kept
 * apart from the page so what they promise (N/A is never ₺0, the list price is
 * only a reference, each figure names its clock) is rendered and tested
 * without a session.
 */

export const VALUE_SECTION_TITLE = 'Ücretsiz tekliflerin gösterge niteliğindeki TL karşılığı';

export const VALUE_DISCLAIMER =
  'Bu tutar gerçekleşmiş bir tahsilat, gelir ya da kesin gelir kaybı değildir; finans özetindeki gelir rakamlarına eklenmez. Kullanılan ücretsiz tekliflerin kategori kredi karşılığının, kullanım ayında ödenmiş kredi paketi satışlarından hesaplanan ağırlıklı kredi başı fiyatla çarpılmış hâlidir.';

export const LIST_PRICE_DISCLAIMER =
  'Bugünkü aktif kredi paketlerinin kredi başı fiyat aralığıyla hesaplanan bir referanstır. Geçmiş kullanımları yeniden değerlemez, tahsilat ya da gelir kaybı olarak okunmamalıdır.';

export function CohortKpis({ cohort }: { cohort: OfferAllowanceCohortFigures }) {
  const items: FinanceKpi[] = [
    {
      label: 'Tanımlanan hak',
      value: formatCount(cohort.defined),
      delta: `${formatCount(cohort.grants)} yayın`,
      hint: 'Yayın başlangıcı pencerede olan haklar',
      testId: 'allowance-kpi-defined',
    },
    {
      label: 'Kullanılan hak',
      value: formatCount(cohort.usedTracked + cohort.usedLegacy),
      delta: `${formatCount(cohort.usedTracked)} izlenen · ${formatCount(cohort.usedLegacy)} eski kayıt`,
      hint: 'Eski kayıtların kategori ve kredi bilgisi yoktur',
      testId: 'allowance-kpi-used',
    },
    {
      label: 'Kalan · kullanılabilir',
      value: formatCount(cohort.remainingUsable),
      delta:
        cohort.remainingUsableViaOpenLeads > 0
          ? `${formatCount(cohort.remainingUsableViaOpenLeads)} tanesi süresi biten yayının açık talebi için`
          : undefined,
      deltaTone: 'success',
      hint: 'Yayın sürüyor ya da cevap bekleyen talep var',
      testId: 'allowance-kpi-usable',
    },
    {
      label: 'Kalan · kullanılamaz',
      value: formatCount(cohort.remainingUnusable),
      // SHOWCASE-ALLOWANCE-004: the voided part, always named — inside the
      // unusable figure, never added to it.
      delta: `${formatCount(cohort.remainingVoided)} tanesi süper yönetici tarafından iptal edildi`,
      deltaTone: 'warning',
      hint: 'Yayın bitti, iptal edildi ya da hak geçersiz',
      testId: 'allowance-kpi-unusable',
    },
  ];
  return <FinanceKpiRow items={items} label="Hak kohortu (yayın başlangıcına göre)" />;
}

export function UsageKpis({
  usage,
  unplaced,
}: {
  usage: OfferAllowanceUsageFigures;
  unplaced: OfferAllowanceReport['unplaced'];
}) {
  const items: FinanceKpi[] = [
    {
      label: 'Dönemde kullanılan',
      value: formatCount(usage.usages),
      hint: 'Kullanım tarihine göre',
      testId: 'allowance-kpi-period-usages',
    },
    {
      label: 'Kategori kredi karşılığı',
      value: `${formatCount(usage.credits)} kredi`,
      hint: 'Kullanım anındaki kategori fiyatıyla',
      testId: 'allowance-kpi-credits',
    },
    {
      label: 'Satılmış, yerleşmemiş hak',
      value: unplaced ? formatCount(unplaced.pendingRights) : '—',
      delta: unplaced ? `${formatCount(unplaced.pendingFreeOffers)} ücretsiz teklif bekliyor` : undefined,
      hint: unplaced
        ? `Tanımlanan hakka eklenmez · ${formatCount(unplaced.expiredRights)} hak yerleşmeden doldu`
        : 'Kategori filtresinde gösterilmez: hak henüz bir kategoriye bağlı değil',
      testId: 'allowance-kpi-unplaced',
    },
  ];
  return <FinanceKpiRow items={items} label="Kullanım (kullanım tarihine göre)" />;
}

export function ValueSection({ report }: { report: OfferAllowanceReport }) {
  const indicative = describeIndicativeValue(report.usage);
  const reference = report.valuation.listPriceReference;

  return (
    <SectionCard title={VALUE_SECTION_TITLE} subtitle={VALUE_DISCLAIMER} testId="allowance-value-section">
      <KeyValueList
        items={[
          {
            label: 'Gösterge niteliğindeki TL karşılığı',
            value: (
              <span>
                <strong data-testid="allowance-indicative-value">{indicative.value}</strong>
                {indicative.note ? <span className="cell-muted"> · {indicative.note}</span> : null}
              </span>
            ),
          },
          {
            label: 'Değerlenen / değerlenemeyen kredi',
            value: `${formatCount(report.usage.valuedCredits)} / ${formatCount(report.usage.unvaluedCredits)}`,
          },
          {
            label: 'Güncel liste fiyatı referansı',
            value: reference ? (
              <span data-testid="allowance-list-price-reference">
                {formatMinorOrNa(reference.lowValueMinor)} – {formatMinorOrNa(reference.highValueMinor)}
                <span className="cell-muted">
                  {' '}
                  · kredi başı {formatPerCredit(reference.minPerCreditMinor)} – {formatPerCredit(reference.maxPerCreditMinor)},{' '}
                  {formatCount(reference.packages)} aktif paket
                </span>
              </span>
            ) : (
              'Aktif kredi paketi yok'
            ),
          },
        ]}
      />
      <p className="detail-muted-note">{LIST_PRICE_DISCLAIMER}</p>
      {report.valuation.months.length > 0 ? (
        <DataTable caption="Aylık değerleme oranı" columns={MONTH_COLUMNS} minWidth={640} testId="allowance-rate-table">
          {report.valuation.months.map((month) => (
            <tr key={month.month}>
              <td>{formatBucket(month.month, 'month')}</td>
              <td className="is-num">{formatCount(month.credits)}</td>
              <td className="is-num">{formatCount(month.purchases)}</td>
              <td className="is-num">{formatPerCredit(month.perCreditMinor)}</td>
            </tr>
          ))}
        </DataTable>
      ) : null}
    </SectionCard>
  );
}

const MONTH_COLUMNS: DataColumn[] = [
  { key: 'month', label: 'Kullanım ayı' },
  { key: 'credits', label: 'Kullanılan kredi', align: 'end' },
  { key: 'purchases', label: 'Ödenmiş kredi paketi', align: 'end' },
  { key: 'rate', label: 'Kredi başı TL', align: 'end' },
];

const FIGURE_COLUMNS: DataColumn[] = [
  { key: 'defined', label: 'Tanımlanan', align: 'end' },
  { key: 'tracked', label: 'Kullanılan', align: 'end' },
  { key: 'legacy', label: 'Eski kayıt', align: 'end' },
  { key: 'usable', label: 'Kalan · kullanılabilir', align: 'end' },
  { key: 'unusable', label: 'Kalan · kullanılamaz', align: 'end' },
  { key: 'voided', label: 'İçinden iptal edilen', align: 'end' },
  { key: 'usages', label: 'Dönemde kullanım', align: 'end' },
  { key: 'credits', label: 'Kredi karşılığı', align: 'end' },
  { key: 'value', label: 'Gösterge TL', align: 'end' },
];

export const BREAKDOWN_LEGEND =
  'İlk altı sütun yayın başlangıcı pencerede olan haklara, son üç sütun pencerede yapılan kullanımlara aittir. “İçinden iptal edilen”, kullanılamaz kalanın süper yönetici tarafından iptal edilen kısmıdır; toplama ayrıca eklenmez.';

function FigureCells({ cohort, usage }: { cohort: OfferAllowanceCohortFigures; usage: OfferAllowanceUsageFigures }) {
  const value = describeIndicativeValue(usage);
  return (
    <>
      <td className="is-num">{formatCount(cohort.defined)}</td>
      <td className="is-num">{formatCount(cohort.usedTracked)}</td>
      <td className="is-num">{cohort.usedLegacy ? formatCount(cohort.usedLegacy) : <span className="cell-muted">0</span>}</td>
      <td className="is-num">{formatCount(cohort.remainingUsable)}</td>
      <td className="is-num">{formatCount(cohort.remainingUnusable)}</td>
      <td className="is-num">{formatCount(cohort.remainingVoided)}</td>
      <td className="is-num">{formatCount(usage.usages)}</td>
      <td className="is-num">{formatCount(usage.credits)}</td>
      <td className="is-num cell-nowrap" title={value.note ?? undefined}>
        {value.value}
      </td>
    </>
  );
}

export type BreakdownRow = {
  key: string;
  label: string;
  cohort: OfferAllowanceCohortFigures;
  usage: OfferAllowanceUsageFigures;
  /** Packages only: rights sold and not yet placed. */
  unplacedPending?: number;
  filterHref?: string | null;
};

export function BreakdownTable({
  caption,
  firstColumn,
  rows,
  withUnplaced = false,
  testId,
  emptyTitle,
}: {
  caption: string;
  firstColumn: string;
  rows: BreakdownRow[];
  withUnplaced?: boolean;
  testId: string;
  emptyTitle: string;
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description="Seçilen pencere ve filtrelerde kayıt yok." />;
  }
  const columns: DataColumn[] = [
    { key: 'name', label: firstColumn },
    ...FIGURE_COLUMNS,
    ...(withUnplaced ? [{ key: 'unplaced', label: 'Yerleşmemiş hak', align: 'end' as const }] : []),
    { key: 'actions', label: 'İşlem', srOnly: true },
  ];
  return (
    <DataTable caption={caption} columns={columns} minWidth={withUnplaced ? 1360 : 1240} testId={testId}>
      {rows.map((row) => (
        <tr key={row.key} data-testid={`${testId}-row`}>
          <td>
            <div className="cell-stack cell-break">
              <strong>{row.label}</strong>
            </div>
          </td>
          <FigureCells cohort={row.cohort} usage={row.usage} />
          {withUnplaced ? <td className="is-num">{formatCount(row.unplacedPending ?? 0)}</td> : null}
          <td className="col-actions">
            {row.filterHref ? (
              <Link className="btn btn-ghost btn-sm" href={row.filterHref} aria-label={`Bu satıra göre filtrele: ${row.label}`}>
                Filtrele
              </Link>
            ) : (
              <span className="cell-muted">—</span>
            )}
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

const COHORT_PERIOD_COLUMNS: DataColumn[] = [
  { key: 'bucket', label: 'Yayın başlangıcı' },
  { key: 'grants', label: 'Yayın', align: 'end' },
  { key: 'defined', label: 'Tanımlanan', align: 'end' },
  { key: 'tracked', label: 'Kullanılan', align: 'end' },
  { key: 'legacy', label: 'Eski kayıt', align: 'end' },
  { key: 'usable', label: 'Kalan · kullanılabilir', align: 'end' },
  { key: 'unusable', label: 'Kalan · kullanılamaz', align: 'end' },
  { key: 'voided', label: 'İçinden iptal edilen', align: 'end' },
];

const USAGE_PERIOD_COLUMNS: DataColumn[] = [
  { key: 'bucket', label: 'Kullanım tarihi' },
  { key: 'usages', label: 'Kullanım', align: 'end' },
  { key: 'credits', label: 'Kredi karşılığı', align: 'end' },
  { key: 'value', label: 'Gösterge TL', align: 'end' },
];

export function PeriodTables({ report }: { report: OfferAllowanceReport }) {
  const groupBy = report.range.groupBy;
  return (
    <div className="finance-two-col">
      <SectionCard
        title="Yayın başlangıcına göre"
        subtitle="Haklar, yayının başladığı İstanbul gününe göre gruplanır."
        padded={false}
        testId="allowance-cohort-period"
      >
        {report.cohortByPeriod.length === 0 ? (
          <EmptyState title="Bu pencerede başlayan yayın yok." />
        ) : (
          <DataTable caption="Yayın başlangıcına göre haklar" columns={COHORT_PERIOD_COLUMNS} minWidth={720}>
            {report.cohortByPeriod.map((row) => (
              <tr key={row.bucket}>
                <td className="cell-nowrap">{formatBucket(row.bucket, groupBy)}</td>
                <td className="is-num">{formatCount(row.grants)}</td>
                <td className="is-num">{formatCount(row.defined)}</td>
                <td className="is-num">{formatCount(row.usedTracked)}</td>
                <td className="is-num">{formatCount(row.usedLegacy)}</td>
                <td className="is-num">{formatCount(row.remainingUsable)}</td>
                <td className="is-num">{formatCount(row.remainingUnusable)}</td>
                <td className="is-num">{formatCount(row.remainingVoided)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </SectionCard>
      <SectionCard
        title="Kullanım tarihine göre"
        subtitle="Kullanımlar, teklifin verildiği İstanbul gününe göre gruplanır."
        padded={false}
        testId="allowance-usage-period"
      >
        {report.usageByPeriod.length === 0 ? (
          <EmptyState title="Bu pencerede kullanım yok." />
        ) : (
          <DataTable caption="Kullanım tarihine göre" columns={USAGE_PERIOD_COLUMNS} minWidth={480}>
            {report.usageByPeriod.map((row) => (
              <tr key={row.bucket}>
                <td className="cell-nowrap">{formatBucket(row.bucket, groupBy)}</td>
                <td className="is-num">{formatCount(row.usages)}</td>
                <td className="is-num">{formatCount(row.credits)}</td>
                <td className="is-num cell-nowrap">{describeIndicativeValue(row).value}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </SectionCard>
    </div>
  );
}

export function MethodologySection({ report }: { report: OfferAllowanceReport }) {
  const { integrity } = report;
  return (
    <SectionCard title="Yöntem ve veri bütünlüğü" testId="allowance-methodology">
      <KeyValueList
        items={[
          {
            label: 'Tanımlanan / kullanılan / kalan',
            value:
              'Yayın başlangıcı (hakkın geçerlilik tarihi) pencerede olan haklar. Her hak tam olarak kullanılan + eski kayıt + kalan kullanılabilir + kalan kullanılamaz olarak bölünür.',
          },
          {
            label: 'Eski kayıt',
            value:
              'Hak sistemi devreye girmeden verilmiş, kullanım satırı olmayan cevaplar. Kategori ve kredi bilgisi olmadığı için kredi ya da TL karşılığı hesaplanmaz.',
          },
          {
            label: 'Kalan · kullanılabilir',
            value:
              'Yayın sürüyorsa (veya askıdaysa) kalan hakların tamamı; yayın bittiyse yalnız sahibinin cevabını bekleyen her vitrin talebi için bir hak.',
          },
          {
            label: 'Dönemde kullanım ve kredi',
            value:
              'Pencerede verilmiş ücretsiz teklifler; kredi karşılığı teklif anında kayıtlı kategori fiyatıdır, sonradan değişen fiyat geçmişi etkilemez.',
          },
          {
            label: 'TL değerleme',
            value:
              'Her kullanım, kendi İstanbul ayında ödenmiş tek seferlik kredi paketi satışlarının ağırlıklı kredi başı fiyatıyla değerlenir ve kuruşa bir kez yuvarlanır; bu yüzden kırılımlar toplamla birebir tutar. O ay satış yoksa değer N/A kalır.',
          },
          {
            label: 'Yerleşmemiş haklar',
            value: 'Satın alınmış, henüz yayına bağlanmamış vitrin hakları; hakkın verildiği tarihe göre sayılır ve tanımlanan hakka eklenmez.',
          },
          {
            label: '0 ücretsiz teklifli yayın',
            value: `${formatCount(integrity.zeroAllowancePlacements)} yayın 0 ücretsiz teklifle satıldı; hak kaydı olmaması beklenen durumdur.`,
            testId: 'allowance-integrity-zero',
          },
          {
            label: 'Hak kaydı olmayan eski yayın',
            value: `${formatCount(integrity.placementsWithoutGrant)} yayın hak sisteminden önce bitmişti; rapora dahil değildir.`,
            testId: 'allowance-integrity-without-grant',
          },
          {
            label: 'Geçersiz kılınmış hak',
            value: `${formatCount(integrity.voidGrants)} hak kaydı süper yönetici tarafından iptal edildi; kalanı kullanılamaz sayılır ve “İçinden iptal edilen” olarak ayrıca gösterilir. Kullanılmış haklar ve verilen teklifler iptalden etkilenmez.`,
            testId: 'allowance-integrity-void',
          },
        ]}
      />
    </SectionCard>
  );
}
