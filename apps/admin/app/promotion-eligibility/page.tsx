import Link from 'next/link';
import { apiFetch, formatDateTime, requireAdmin } from '../../lib/api';
import {
  ELIGIBILITY_DECISION_LABELS,
  ELIGIBILITY_TRIGGER_LABELS,
  eligibilitySignalLabel,
  type PromotionEligibilityHoldView,
} from '../../lib/business-registration';
import { parsePage, type QueryParams } from '../../lib/list-query';
import { formatCount } from '../../lib/pagination';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { Pagination } from '../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../components/tabs';

type PageProps = { searchParams: Promise<{ filter?: string; page?: string }> };

const PATH = '/promotion-eligibility';

/** Holds per page; the API pages the queue and counts the whole view (ADMIN-BACKEND-TRUTH-002). */
const PAGE_SIZE = 50;

type HoldPage = {
  items: PromotionEligibilityHoldView[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
};

const SCREEN_INFO =
  'Giriş promosyonu için incelemeye alınan hizmet verenler. Kampanya motoru, kapının incelemeye aldığı olayı kendiliğinden yeniden denemez; olay burada gerekçeyle, bir kez ve kesin olarak karara bağlanır. Aynı IP tek başına hiçbir zaman ret gerekçesi değildir.';

const COLUMNS: DataColumn[] = [
  { key: 'provider', label: 'Hizmet veren' },
  { key: 'trigger', label: 'Tetikleyici' },
  { key: 'signals', label: 'Gerekçeler' },
  { key: 'held', label: 'İncelemeye alınma' },
  { key: 'decision', label: 'Karar' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

/**
 * CMP-006 PR-C — the promotion eligibility queue: introductory promotion
 * events the gate held for a person. A held event is never retried by the
 * worker; it waits here until someone decides it, once, with a reason.
 *
 * ADMIN-DESIGN-001 Faz 3E: the shared list template. "Bekleyen / Karar
 * verilen" became saved views on the same `?filter=decided` parameter.
 * Nothing on this screen decides — the decision is on the detail.
 *
 * ADMIN-BACKEND-TRUTH-002: the queue is paged on the server with each view's
 * real `total`, so no hold sits unreachable past a fixed cut-off. Both tabs
 * carry their count (the other view's is a one-row read of its `total`), and
 * switching view goes back to page 1.
 */
export default async function PromotionEligibilityPage({ searchParams }: PageProps) {
  const { can } = await requireAdmin('PROMOTION_ELIGIBILITY_REVIEW');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const params = await searchParams;
  const filter = params.filter === 'decided' ? 'decided' : 'open';
  const otherFilter = filter === 'open' ? 'decided' : 'open';
  const page = parsePage(params.page);
  const [response, other] = await Promise.all([
    apiFetch<HoldPage>(`/admin/promotion-eligibility/holds?filter=${filter}&page=${page}&pageSize=${PAGE_SIZE}`),
    apiFetch<HoldPage>(`/admin/promotion-eligibility/holds?filter=${otherFilter}&page=1&pageSize=1`),
  ]);
  const { items } = response;
  const openTotal = filter === 'open' ? response.total : other.total;
  const decidedTotal = filter === 'decided' ? response.total : other.total;
  const filterParams: QueryParams = { filter: filter === 'decided' ? 'decided' : '' };

  const views: TabItem[] = [
    { key: '', label: 'Bekleyen', count: openTotal, testId: 'eligibility-view-open' },
    { key: 'decided', label: 'Karar verilen', count: decidedTotal, testId: 'eligibility-view-decided' },
  ];

  const subtitle =
    filter === 'open'
      ? openTotal === 0
        ? 'Karar bekleyen inceleme yok'
        : `${formatCount(openTotal)} inceleme karar bekliyor · en eski başta`
      : decidedTotal === 0
        ? 'Henüz karar verilmedi'
        : `${formatCount(decidedTotal)} karar · en yeni başta`;

  return (
    <main className="eligibility-list-page">
      <PageHeader title="Kampanya uygunluk incelemesi" subtitle={subtitle} info={SCREEN_INFO} />

      <SavedViewTabs
        label="İnceleme görünümleri"
        items={views}
        active={filter === 'decided' ? 'decided' : ''}
        path={PATH}
        param="filter"
        testId="eligibility-views"
      />

      <div className="data-list-card">
        {items.length === 0 ? (
          response.total > 0 ? (
            <EmptyState
              title="Bu sayfada inceleme yok"
              description="Liste bu sayfaya kadar uzanmıyor; kararlar verildikçe sayfa sayısı azalır."
              action={
                <Link className="btn btn-secondary btn-sm" href={filter === 'decided' ? `${PATH}?filter=decided` : PATH}>
                  İlk sayfaya dön
                </Link>
              }
            />
          ) : (
            <EmptyState
              title={filter === 'open' ? 'Bekleyen inceleme yok' : 'Henüz karar verilmedi'}
              description="Kampanya motoru bir giriş promosyonunu incelemeye aldığında burada görünür."
            />
          )
        ) : (
          <DataTable caption={filter === 'open' ? 'Bekleyen incelemeler' : 'Karar verilen incelemeler'} columns={COLUMNS} minWidth={900} testId="eligibility-table">
            {items.map((item) => (
              <tr key={item.eventId} data-testid="eligibility-row" data-event={item.eventId}>
                <td>
                  {canOpenProvider ? (
                    <Link className="cell-link" href={`/providers/${item.provider.id}`}>
                      <strong className="cell-break">{item.provider.businessName}</strong>
                    </Link>
                  ) : (
                    <strong className="cell-break">{item.provider.businessName}</strong>
                  )}
                </td>
                <td>{ELIGIBILITY_TRIGGER_LABELS[item.trigger] ?? item.trigger}</td>
                <td>
                  <div className="cell-stack">
                    {item.snapshot.signals.map((signal) => (
                      <span key={signal.code}>{eligibilitySignalLabel(signal.code)}</span>
                    ))}
                  </div>
                </td>
                <td className="cell-nowrap">{formatDateTime(item.heldAt)}</td>
                <td>
                  {item.review ? (
                    <span className={item.review.decision === 'ELIGIBLE' ? 'badge badge-good' : 'badge badge-bad'}>
                      {ELIGIBILITY_DECISION_LABELS[item.review.decision]}
                    </span>
                  ) : (
                    <span className="badge badge-warn">Karar bekliyor</span>
                  )}
                </td>
                <td className="col-actions">
                  <Link
                    className="btn btn-secondary btn-sm"
                    href={`/promotion-eligibility/${item.eventId}`}
                    aria-label={`Aç: ${item.provider.businessName}`}
                  >
                    Aç
                  </Link>
                </td>
              </tr>
            ))}
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
            noun="inceleme"
            summaryTestId="eligibility-list-summary"
          />
        ) : null}
      </div>
    </main>
  );
}
