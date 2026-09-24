import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  requireAdmin,
  reviewModerationActionLabel,
  reviewReasonLabel,
  reviewResolutionLabel,
  reviewStateBadgeClass,
  reviewStateLabel,
  type ReviewReportQueue,
} from '../../../lib/api';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';

/**
 * The review report queue: comments providers have flagged, one row per
 * report, oldest first in the requested state.
 *
 * A row is a *report*, unlike the request queue where a row is a request.
 * A review has at most one open report at a time (the reviewed provider is
 * the only one who may file one, and a second open report is refused), so
 * the two readings coincide for open reports; for resolved ones the history
 * reads report by report, which is what an operator looking back wants.
 *
 * The decision is taken on the review's own screen, where the operator can
 * read the whole comment, the note and the log before deciding. The queue
 * itself is read-only.
 */

export const dynamic = 'force-dynamic';

type QueueState = 'open' | 'resolved';

type ReviewReportsQueuePageProps = {
  searchParams: Promise<{ state?: string; cursor?: string }>;
};

const STATE_TABS: Array<{ value: QueueState; label: string }> = [
  { value: 'open', label: 'Açık' },
  { value: 'resolved', label: 'Çözülen' },
];

function normalizeState(value: string | undefined): QueueState {
  return value === 'resolved' ? 'resolved' : 'open';
}

function queueHref(state: QueueState, cursor?: string | null): string {
  const params = new URLSearchParams({ state });
  if (cursor) params.set('cursor', cursor);
  return `/provider-reviews/reports?${params.toString()}`;
}

export default async function ReviewReportsQueuePage({ searchParams }: ReviewReportsQueuePageProps) {
  const { can } = await requireAdmin('PROVIDER_REVIEWS_READ');
  const canReadRequests = can('REQUESTS_READ');

  const params = await searchParams;
  const state = normalizeState(params.state);
  const cursor = (params.cursor ?? '').trim();

  const queue = await apiFetch<ReviewReportQueue>(
    `/provider-reviews/reports?${new URLSearchParams({
      state,
      ...(cursor ? { cursor } : {}),
      limit: '50',
    }).toString()}`,
  );

  return (
    <main className="request-reports-page">
      <PageHeader
        title="Değerlendirme bildirimleri"
        subtitle="Hizmet verenlerin bildirdiği müşteri yorumları. Karar değerlendirme detayında verilir; en eski bildirim başta."
        breadcrumbs={[{ label: 'Dashboard', href: can('DASHBOARD_READ') ? '/' : undefined }, { label: 'Değerlendirme bildirimleri' }]}
      />

      <nav className="inline-actions report-queue-tabs" aria-label="Bildirim durumu">
        {STATE_TABS.map((tab) => {
          const active = tab.value === state;
          return (
            <Link
              key={tab.value}
              className={active ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              href={queueHref(tab.value)}
              aria-current={active ? 'page' : undefined}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <SectionCard
        title={state === 'open' ? 'Karar bekleyen bildirimler' : 'Karar verilmiş bildirimler'}
        subtitle={
          (queue.nextCursor ? 'Bu sayfada ' : '') +
          (state === 'open'
            ? `${queue.items.length} bildirim karar bekliyor.`
            : `${queue.items.length} bildirim hakkında karar verildi.`)
        }
        padded={false}
      >
        {queue.items.length === 0 ? (
          <EmptyState
            title={state === 'open' ? 'Açık bildirim yok' : 'Çözülmüş bildirim yok'}
            description={
              state === 'open'
                ? 'Hizmet verenlerden bekleyen bir yorum bildirimi bulunmuyor.'
                : 'Henüz karar verilmiş bir yorum bildirimi bulunmuyor.'
            }
          />
        ) : (
          <div className="table-scroll showcase-table-scroll">
            <table className="data-table" data-testid="review-report-queue">
              <thead>
                <tr>
                  <th>Hizmet veren</th>
                  <th>Puan</th>
                  <th>Yorum</th>
                  <th>Neden</th>
                  <th>Talep</th>
                  <th>Bildirim</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {queue.items.map((item) => {
                  const requestRef = item.request.requestNumber ?? `#${item.request.id.slice(-8)}`;
                  return (
                    <tr
                      key={item.report.id}
                      data-testid="review-report-row"
                      data-review-id={item.review.id}
                    >
                      <td>
                        <div className="cell-stack">
                          <Link className="cell-link" href={`/provider-reviews/${item.review.id}`}>
                            {item.provider.businessName}
                          </Link>
                          <span className="cell-muted">
                            değerlendirme {formatDateTime(item.review.createdAt)}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="badge badge-muted" aria-label={`5 üzerinden ${item.review.rating}`}>
                          ★ {item.review.rating}
                        </span>
                      </td>
                      <td>
                        {item.review.commentExcerpt ? (
                          <span className="report-queue-excerpt">{item.review.commentExcerpt}</span>
                        ) : (
                          <span className="cell-muted">—</span>
                        )}
                      </td>
                      <td>
                        <span className="badge badge-muted">{reviewReasonLabel(item.report.reason)}</span>
                      </td>
                      <td>
                        <div className="cell-stack">
                          {canReadRequests ? (
                            <Link className="cell-link" href={`/requests/${item.request.id}`}>
                              <code className="display-number">{requestRef}</code>
                            </Link>
                          ) : (
                            <code className="display-number">{requestRef}</code>
                          )}
                          <span className="cell-muted">{item.request.categoryName}</span>
                        </div>
                      </td>
                      <td>{formatDateTime(item.report.createdAt)}</td>
                      <td>
                        <div className="cell-stack">
                          <span className={reviewStateBadgeClass(item.review)}>
                            {reviewStateLabel(item.review)}
                          </span>
                          {item.report.resolution && item.report.resolvedAt ? (
                            <span className="cell-muted">
                              {reviewResolutionLabel(item.report.resolution)} ·{' '}
                              {formatDateTime(item.report.resolvedAt)}
                            </span>
                          ) : null}
                          {item.lastDecision && state === 'resolved' ? (
                            <span className="cell-muted">
                              son karar: {reviewModerationActionLabel(item.lastDecision.action)}
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {queue.nextCursor ? (
        <div className="inline-actions" style={{ marginTop: 12 }}>
          <Link className="btn btn-secondary btn-sm" href={queueHref(state, queue.nextCursor)}>
            Sonraki sayfa
          </Link>
        </div>
      ) : null}
    </main>
  );
}
