import Link from 'next/link';
import { apiFetch, requireAdmin, type OfferAllowanceReport, type OfferAllowanceReportGroupBy } from '../../../lib/api';
import { buildHref, parsePage, type QueryParams } from '../../../lib/list-query';
import { describeWindow } from '../../../lib/offer-allowance-report';
import { formatCount } from '../../../lib/pagination';
import { FilterBar, FilterField } from '../../../components/filter-bar';
import { PageHeader } from '../../../components/page-header';
import { Pagination } from '../../../components/pagination';
import { SectionCard } from '../../../components/section-card';
import {
  BREAKDOWN_LEGEND,
  BreakdownTable,
  CohortKpis,
  MethodologySection,
  PeriodTables,
  UsageKpis,
  ValueSection,
} from './report-sections';

/**
 * SHOWCASE-ALLOWANCE-002 — free vitrin offers, read as finance.
 *
 * Every figure comes from `GET /finance/offer-allowances` (FINANCE_READ) and
 * names the clock it reads: the grant cohort by run start, usage by time of
 * use, unplaced rights by the day they were granted. The indicative TL value
 * sits in its own card, never beside revenue.
 *
 * The package, category and provider filters are set from the breakdown rows
 * ("Filtrele"), because listing every package, category or provider would need
 * reads a FINANCE_READ-only role does not hold.
 */

const PATH = '/finance/offer-allowances';
const PAGE_SIZE = 25;
const DAY_GROUPING_MAX_DAYS = 370;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const SCREEN_INFO =
  'Vitrin paketleriyle verilen ücretsiz teklif haklarının ne kadarının tanımlandığını, kullanıldığını ve kaldığını gösterir. TL karşılığı gösterge niteliğindedir; gelir değildir.';

const GROUP_BY_LABEL: Record<OfferAllowanceReportGroupBy, string> = {
  day: 'Gün',
  month: 'Ay',
  year: 'Yıl',
};

type RawSearchParams = {
  from?: string;
  to?: string;
  groupBy?: string;
  packageId?: string;
  providerId?: string;
  categoryId?: string;
  page?: string;
};

function validDay(value: string | undefined): string | undefined {
  if (!value || !ISO_DAY.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? undefined : value;
}

function cleanId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= 64 ? trimmed : undefined;
}

/**
 * The window and grouping the API will accept, and why anything was dropped —
 * a hand-edited address shows a notice instead of an error page.
 */
function normalizeWindow(params: RawSearchParams): {
  from?: string;
  to?: string;
  groupBy: OfferAllowanceReportGroupBy;
  notice: string | null;
} {
  let from = validDay(params.from);
  let to = validDay(params.to);
  let notice: string | null = null;
  if ((params.from && !from) || (params.to && !to)) {
    notice = 'Geçersiz tarih yok sayıldı.';
  }
  if (from && to && from > to) {
    from = undefined;
    to = undefined;
    notice = 'Başlangıç bitişten sonra olamaz; tarih filtresi kaldırıldı.';
  }
  let groupBy: OfferAllowanceReportGroupBy =
    params.groupBy === 'day' || params.groupBy === 'year' ? params.groupBy : 'month';
  if (groupBy === 'day') {
    const end = to ? new Date(`${to}T00:00:00Z`) : new Date();
    const days = from ? (end.getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 : Infinity;
    if (days > DAY_GROUPING_MAX_DAYS) {
      groupBy = 'month';
      notice = `Günlük gruplama için en çok ${DAY_GROUPING_MAX_DAYS} günlük bir başlangıç–bitiş aralığı gerekir; aylık gösteriliyor.`;
    }
  }
  return { from, to, groupBy, notice };
}

export default async function OfferAllowanceReportPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  await requireAdmin('FINANCE_READ');
  const params = await searchParams;
  const { from, to, groupBy, notice } = normalizeWindow(params);
  const packageId = cleanId(params.packageId);
  const providerId = cleanId(params.providerId);
  const categoryId = cleanId(params.categoryId);
  const page = parsePage(params.page);

  const filterParams: QueryParams = {
    from,
    to,
    groupBy: groupBy === 'month' ? undefined : groupBy,
    packageId,
    providerId,
    categoryId,
  };
  const apiQuery = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filterParams, groupBy })) {
    if (value) apiQuery.set(key, String(value));
  }
  apiQuery.set('page', String(page));
  apiQuery.set('pageSize', String(PAGE_SIZE));

  const report = await apiFetch<OfferAllowanceReport>(`/finance/offer-allowances?${apiQuery.toString()}`);

  const hasFilters = Boolean(from || to || packageId || providerId || categoryId || groupBy !== 'month');
  const filterHref = (key: 'packageId' | 'categoryId' | 'providerId', id: string) =>
    buildHref(PATH, filterParams, { [key]: id, page: undefined });

  const activeFilters = [
    packageId
      ? {
          key: 'packageId',
          label: `Paket: ${report.byPackage.find((row) => row.package.id === packageId)?.package.name ?? packageId}`,
        }
      : null,
    categoryId
      ? {
          key: 'categoryId',
          label: `Kategori: ${report.byCategory.find((row) => row.category.id === categoryId)?.category.name ?? categoryId}`,
        }
      : null,
    providerId
      ? {
          key: 'providerId',
          label: `İşletme: ${
            report.byProvider.items.find((row) => row.provider.id === providerId)?.provider.businessName ?? providerId
          }`,
        }
      : null,
  ].filter((entry): entry is { key: string; label: string } => entry !== null);

  return (
    <main className="finance-list-page offer-allowance-report-page" data-testid="offer-allowance-report">
      <PageHeader
        title="Ücretsiz vitrin teklif hakları"
        subtitle={`${describeWindow(report.range)} · İstanbul saati · ${GROUP_BY_LABEL[groupBy].toLocaleLowerCase('tr-TR')} kırılımı`}
        info={SCREEN_INFO}
        actions={
          <Link className="btn btn-secondary btn-sm" href="/finance">
            Finans özeti
          </Link>
        }
      />

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        preserve={{ packageId, providerId, categoryId }}
        label="Ücretsiz hak raporu filtreleri"
        testId="offer-allowance-filters"
      >
        <FilterField label="Başlangıç" htmlFor="offer-allowance-from">
          <input id="offer-allowance-from" name="from" type="date" defaultValue={from ?? ''} />
        </FilterField>
        <FilterField label="Bitiş" htmlFor="offer-allowance-to">
          <input id="offer-allowance-to" name="to" type="date" defaultValue={to ?? ''} />
        </FilterField>
        <FilterField label="Kırılım" htmlFor="offer-allowance-group">
          <select id="offer-allowance-group" name="groupBy" defaultValue={groupBy}>
            <option value="day">Gün</option>
            <option value="month">Ay</option>
            <option value="year">Yıl</option>
          </select>
        </FilterField>
      </FilterBar>

      {notice ? (
        <p className="notice notice-warning" role="status" data-testid="offer-allowance-notice">
          {notice}
        </p>
      ) : null}

      {activeFilters.length > 0 ? (
        <p className="inline-actions" data-testid="offer-allowance-active-filters">
          {activeFilters.map((filter) => (
            <Link
              key={filter.key}
              className="btn btn-secondary btn-sm"
              href={buildHref(PATH, filterParams, { [filter.key]: undefined, page: undefined })}
              aria-label={`Filtreyi kaldır: ${filter.label}`}
            >
              {filter.label} ×
            </Link>
          ))}
        </p>
      ) : null}

      <CohortKpis cohort={report.cohort} />
      <UsageKpis usage={report.usage} unplaced={report.unplaced} />
      <ValueSection report={report} />

      <SectionCard title="Pakete göre" subtitle={BREAKDOWN_LEGEND} padded={false} testId="allowance-by-package">
        <BreakdownTable
          caption="Pakete göre ücretsiz haklar"
          firstColumn="Paket"
          testId="allowance-package-table"
          emptyTitle="Paket kırılımı yok."
          withUnplaced={report.unplaced !== null}
          rows={report.byPackage.map((row) => ({
            key: row.package.id,
            label: row.package.name ?? 'Silinmiş paket',
            cohort: row.cohort,
            usage: row.usage,
            unplacedPending: row.unplaced?.pendingRights,
            filterHref: packageId ? null : filterHref('packageId', row.package.id),
          }))}
        />
      </SectionCard>

      <SectionCard title="Kategoriye göre" subtitle={BREAKDOWN_LEGEND} padded={false} testId="allowance-by-category">
        <BreakdownTable
          caption="Kategoriye göre ücretsiz haklar"
          firstColumn="Kategori"
          testId="allowance-category-table"
          emptyTitle="Kategori kırılımı yok."
          rows={report.byCategory.map((row) => ({
            key: row.category.id,
            label: row.category.name ?? 'Bilinmeyen kategori',
            cohort: row.cohort,
            usage: row.usage,
            filterHref: categoryId ? null : filterHref('categoryId', row.category.id),
          }))}
        />
      </SectionCard>

      <SectionCard
        title="İşletmeye göre"
        subtitle={`${formatCount(report.byProvider.total)} işletme · ${BREAKDOWN_LEGEND}`}
        padded={false}
        testId="allowance-by-provider"
      >
        <BreakdownTable
          caption="İşletmeye göre ücretsiz haklar"
          firstColumn="İşletme"
          testId="allowance-provider-table"
          emptyTitle="İşletme kırılımı yok."
          rows={report.byProvider.items.map((row) => ({
            key: row.provider.id,
            label: row.provider.businessName ?? 'Bilinmeyen işletme',
            cohort: row.cohort,
            usage: row.usage,
            filterHref: providerId ? null : filterHref('providerId', row.provider.id),
          }))}
        />
        {report.byProvider.total > 0 ? (
          <Pagination
            path={PATH}
            params={filterParams}
            page={report.byProvider.page}
            pageSize={report.byProvider.pageSize}
            total={report.byProvider.total}
            hasNextPage={report.byProvider.hasNextPage}
            noun="işletme"
            summaryTestId="allowance-provider-page-summary"
          />
        ) : null}
      </SectionCard>

      <PeriodTables report={report} />
      <MethodologySection report={report} />
    </main>
  );
}
