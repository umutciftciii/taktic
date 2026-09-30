import Link from 'next/link';
import { apiFetch, formatDateTime, requireAdmin } from '../../lib/api';
import {
  ELIGIBILITY_DECISION_LABELS,
  ELIGIBILITY_TRIGGER_LABELS,
  eligibilitySignalLabel,
  type PromotionEligibilityHoldView,
} from '../../lib/business-registration';
import { formatCount } from '../../lib/pagination';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { SavedViewTabs, type TabItem } from '../../components/tabs';

type PageProps = { searchParams: Promise<{ filter?: string }> };

const PATH = '/promotion-eligibility';

/**
 * The API returns at most this many holds per view, oldest first while open,
 * and has no page or cursor (promotion-eligibility-reviews.service.ts).
 */
const ELIGIBILITY_LIST_LIMIT = 100;

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
 * verilen" became saved views on the same `?filter=decided` parameter; only
 * the open view's count is shown, because it is the only one this request
 * holds. Nothing on this screen decides — the decision is on the detail.
 */
export default async function PromotionEligibilityPage({ searchParams }: PageProps) {
  const { can } = await requireAdmin('PROMOTION_ELIGIBILITY_REVIEW');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const filter = (await searchParams).filter === 'decided' ? 'decided' : 'open';
  const { items } = await apiFetch<{ items: PromotionEligibilityHoldView[] }>(
    `/admin/promotion-eligibility/holds?filter=${filter}`,
  );
  const truncated = items.length >= ELIGIBILITY_LIST_LIMIT;

  const views: TabItem[] = [
    { key: '', label: 'Bekleyen', count: filter === 'open' && !truncated ? items.length : null, testId: 'eligibility-view-open' },
    { key: 'decided', label: 'Karar verilen', testId: 'eligibility-view-decided' },
  ];

  const subtitle =
    filter === 'open'
      ? items.length === 0
        ? 'Karar bekleyen inceleme yok'
        : `${truncated ? `En eski ${formatCount(items.length)}` : formatCount(items.length)} inceleme karar bekliyor`
      : items.length === 0
        ? 'Henüz karar verilmedi'
        : `Son ${formatCount(items.length)} karar`;

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
          <EmptyState
            title={filter === 'open' ? 'Bekleyen inceleme yok' : 'Henüz karar verilmedi'}
            description="Kampanya motoru bir giriş promosyonunu incelemeye aldığında burada görünür."
          />
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
        {items.length > 0 ? (
          <nav className="pagination" aria-label="Liste sonu">
            <p className="pagination-summary" data-testid="eligibility-list-summary">
              {truncated
                ? `İlk ${formatCount(items.length)} inceleme gösteriliyor; liste bu sayıda kesilir ve sayfalanmaz.`
                : `${formatCount(items.length)} inceleme, tamamı gösteriliyor`}
            </p>
          </nav>
        ) : null}
      </div>
    </main>
  );
}
