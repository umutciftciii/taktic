import Link from 'next/link';
import { apiFetch, formatDateTime, requireAdmin } from '../../lib/api';
import { parsePage, type QueryParams } from '../../lib/list-query';
import { formatCount } from '../../lib/pagination';
import {
  RELIABILITY_LEVEL_LABELS,
  RELIABILITY_REVIEW_STATUS_LABELS,
  reliabilityLevelBadgeClass,
  reliabilityNotice,
  reviewStatusBadgeClass,
  type ReliabilityQueueResponse,
} from '../../lib/service-incidents';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { Pagination } from '../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../components/tabs';
import { acknowledgeReliabilityReviewAction, resolveReliabilityReviewAction } from './actions';
import { ReviewActions } from './review-actions';

type PageProps = { searchParams: Promise<{ filter?: string; page?: string; reliability?: string }> };

const PATH = '/provider-reliability';
const PAGE_SIZE = 25;
const FILTERS = ['WARNING', 'ADMIN_REVIEW_REQUIRED', 'review'] as const;
type Filter = (typeof FILTERS)[number];

const SCREEN_INFO =
  'Son 90 günde doğrulanmış aksaklığı uyarı eşiğine (2) ya da yönetici incelemesi eşiğine (3) ulaşan hizmet verenler ve çözülmemiş güvenilirlik incelemeleri. Seviye her okumada geçerli kararlardan hesaplanır. İnceleme yalnız bir iç iş akışıdır: hizmet verenin hesabını askıya almaz; askıya alma hizmet verenin kendi sayfasındaki durum yönetiminden yapılır.';

const COLUMNS: DataColumn[] = [
  { key: 'provider', label: 'Hizmet veren' },
  { key: 'confirmed', label: '90g doğrulanmış aksaklık', align: 'end' },
  { key: 'level', label: 'Seviye' },
  { key: 'review', label: 'İnceleme' },
  { key: 'actions', label: 'İşlem' },
];

/**
 * REL-002 Faz 4 — the reliability queue (`GET /admin/provider-reliability`):
 * providers at WARNING or ADMIN_REVIEW_REQUIRED now, and providers with an
 * unresolved review whatever their level now (a correction may have lowered
 * it). Highest count first, as the API orders it.
 *
 * PROVIDER_RELIABILITY_READ opens it; Üstlen / Sonuçlandır need
 * PROVIDER_RELIABILITY_MANAGE. No suspension control: the provider link leads
 * to the existing moderation flow.
 */
export default async function ProviderReliabilityPage({ searchParams }: PageProps) {
  const { can } = await requireAdmin('PROVIDER_RELIABILITY_READ');
  const canManage = can('PROVIDER_RELIABILITY_MANAGE');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const params = await searchParams;
  const filter: Filter | '' = FILTERS.includes(params.filter as Filter) ? (params.filter as Filter) : '';
  const page = parsePage(params.page);

  const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (filter) query.set('filter', filter);
  const response = await apiFetch<ReliabilityQueueResponse>(`/admin/provider-reliability?${query.toString()}`);
  const filterParams: QueryParams = { filter };
  const notice = reliabilityNotice(params.reliability);

  const views: TabItem[] = [
    { key: '', label: 'Tümü', testId: 'reliability-view-all' },
    { key: 'ADMIN_REVIEW_REQUIRED', label: RELIABILITY_LEVEL_LABELS.ADMIN_REVIEW_REQUIRED, testId: 'reliability-view-review-required' },
    { key: 'WARNING', label: RELIABILITY_LEVEL_LABELS.WARNING, testId: 'reliability-view-warning' },
    { key: 'review', label: 'Çözülmemiş inceleme', testId: 'reliability-view-open-review' },
  ].map((view) => (view.key === filter ? { ...view, count: response.total } : view));

  const summary =
    response.total === 0 ? 'Takip gerektiren hizmet veren yok' : `${formatCount(response.total)} hizmet veren takipte`;

  return (
    <main className="finance-list-page">
      <PageHeader title="Hizmet veren güvenilirliği" subtitle={summary} info={SCREEN_INFO} />

      {notice ? (
        <div
          className={notice.tone === 'success' ? 'notice notice-success detail-notice' : 'notice notice-error detail-notice'}
          role={notice.tone === 'success' ? 'status' : 'alert'}
          data-testid="reliability-notice"
        >
          {notice.text}
        </div>
      ) : null}

      <SavedViewTabs
        label="Güvenilirlik görünümleri"
        items={views}
        active={filter}
        path={PATH}
        params={filterParams}
        param="filter"
        testId="reliability-views"
      />

      <div className="data-list-card">
        <span className="sr-only" data-testid="reliability-count" data-total={response.total}>
          {response.total} hizmet veren
        </span>
        {response.items.length === 0 ? (
          <EmptyState
            title={filter ? 'Bu görünümde hizmet veren yok' : 'Takip gerektiren hizmet veren yok'}
            description="Bir hizmet verenin son 90 gündeki doğrulanmış aksaklığı 2'ye ulaştığında burada görünür."
            action={
              filter || response.total > 0 ? (
                <Link className="btn btn-secondary btn-sm" href={PATH}>
                  {filter ? 'Tümü' : 'İlk sayfaya dön'}
                </Link>
              ) : null
            }
          />
        ) : (
          <DataTable caption="Hizmet veren güvenilirliği" columns={COLUMNS} minWidth={980} testId="reliability-table">
            {response.items.map((item) => {
              const name = item.provider.businessName ?? 'İsimsiz hizmet veren';
              return (
                <tr key={item.provider.id} data-testid="reliability-row" data-provider-id={item.provider.id} data-level={item.level}>
                  <td>
                    {canOpenProvider ? (
                      <Link className="cell-link" href={`/providers/${item.provider.id}#guvenilirlik`}>
                        <strong className="cell-break">{name}</strong>
                      </Link>
                    ) : (
                      <strong className="cell-break">{name}</strong>
                    )}
                  </td>
                  <td className="is-num" data-testid="reliability-confirmed-count">
                    {item.confirmed90d}
                  </td>
                  <td>
                    <span className={reliabilityLevelBadgeClass(item.level)} data-testid="reliability-level">
                      {RELIABILITY_LEVEL_LABELS[item.level]}
                    </span>
                  </td>
                  <td>
                    {item.review ? (
                      <div className="cell-stack">
                        <span className={reviewStatusBadgeClass(item.review.status)} data-testid="reliability-review-status">
                          {RELIABILITY_REVIEW_STATUS_LABELS[item.review.status]}
                        </span>
                        <span className="cell-muted cell-nowrap">açılış {formatDateTime(item.review.openedAt)}</span>
                        {item.review.acknowledgedBy ? (
                          <span className="cell-muted">üstlenen: {item.review.acknowledgedBy.name ?? 'İsimsiz'}</span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="cell-muted">İnceleme yok</span>
                    )}
                  </td>
                  <td>
                    {canManage && item.review ? (
                      <ReviewActions
                        review={item.review}
                        providerName={name}
                        from="queue"
                        filter={filter || undefined}
                        formActions={{
                          acknowledge: acknowledgeReliabilityReviewAction,
                          resolve: resolveReliabilityReviewAction,
                        }}
                      />
                    ) : canOpenProvider ? (
                      <Link className="btn btn-secondary btn-sm" href={`/providers/${item.provider.id}#guvenilirlik`}>
                        Hizmet vereni aç
                      </Link>
                    ) : (
                      <span className="cell-muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
        {response.total > 0 ? (
          <Pagination
            path={PATH}
            params={filterParams}
            page={response.page}
            pageSize={response.pageSize}
            total={response.total}
            hasNextPage={response.hasNextPage}
            noun="hizmet veren"
            summaryTestId="reliability-page-summary"
          />
        ) : null}
      </div>
    </main>
  );
}
