import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  reportReasonLabel,
  reportResolutionLabel,
  requestStatusLabel,
  requireAdmin,
  statusBadgeClass,
  type RequestReportQueue,
} from '../../../lib/api';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';

/**
 * The report queue: requests that providers have flagged, one row per request.
 *
 * A row is a *request*, not a report. Three providers reporting the same
 * request is one thing for an operator to decide, and the decision — dismiss
 * or remove — is taken once on the request detail, where the operator can read
 * what was reported before deciding about it. The queue itself is read-only.
 *
 * Oldest first report at the top: the request that has waited longest on a
 * decision is the one the operator should see first.
 *
 * Two tabs, by report state. "Açık" is the work; "Çözülen" is the record, and
 * it carries the last decision so a request that keeps coming back shows as
 * such. A request a report removed and an operator later put back reads
 * "Kaldırıldı → geri açıldı" — derived by the API from the last decision and
 * the request's current status, never stored.
 */

export const dynamic = 'force-dynamic';

type QueueState = 'open' | 'resolved';

type ReportQueuePageProps = {
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
  return `/requests/reports?${params.toString()}`;
}

export default async function RequestReportsQueuePage({ searchParams }: ReportQueuePageProps) {
  await requireAdmin('REQUEST_REPORTS_READ');

  const params = await searchParams;
  const state = normalizeState(params.state);
  const cursor = (params.cursor ?? '').trim();

  const queue = await apiFetch<RequestReportQueue>(
    `/service-requests/reports?${new URLSearchParams({
      state,
      ...(cursor ? { cursor } : {}),
      limit: '50',
    }).toString()}`,
  );

  return (
    <main className="request-reports-page">
      <PageHeader
        title="Talep bildirimleri"
        subtitle="Hizmet verenlerin bildirdiği talepler. Karar talep detayında verilir; en eski bildirim başta."
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Talepler', href: '/requests' },
          { label: 'Talep bildirimleri' },
        ]}
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
        title={state === 'open' ? 'Karar bekleyen talepler' : 'Karar verilmiş talepler'}
        subtitle={
          (queue.nextCursor ? 'Bu sayfada ' : '') +
          (state === 'open'
            ? `${queue.items.length} talep karar bekliyor.`
            : `${queue.items.length} talep hakkında karar verildi.`)
        }
        padded={false}
      >
        {queue.items.length === 0 ? (
          <EmptyState
            title={state === 'open' ? 'Açık bildirim yok' : 'Çözülmüş bildirim yok'}
            description={
              state === 'open'
                ? 'Hizmet verenlerden bekleyen bir talep bildirimi bulunmuyor.'
                : 'Henüz karar verilmiş bir talep bildirimi bulunmuyor.'
            }
          />
        ) : (
          <div className="table-scroll showcase-table-scroll">
            <table className="data-table" data-testid="report-queue">
              <thead>
                <tr>
                  <th>Talep</th>
                  <th>Kategori</th>
                  <th>Konum</th>
                  <th>Durum</th>
                  <th>İlk bildirim</th>
                  <th className="col-num">Bildirim</th>
                  <th>Nedenler</th>
                  <th>Bildirenler</th>
                  <th>Açıklama</th>
                </tr>
              </thead>
              <tbody>
                {queue.items.map((item) => {
                  const requestRef =
                    item.request.requestNumber ?? `#${item.request.id.slice(-8)}`;
                  return (
                    <tr key={item.request.id} data-testid="report-queue-row">
                      <td>
                        <div className="cell-stack">
                          <Link className="cell-link" href={`/requests/${item.request.id}`}>
                            <code className="display-number">{requestRef}</code>
                          </Link>
                          <span className="cell-muted">
                            {formatDateTime(item.request.submittedAt)}
                          </span>
                        </div>
                      </td>
                      <td>{item.request.categoryName}</td>
                      <td>
                        {item.request.city}/{item.request.district}
                      </td>
                      <td>
                        <div className="cell-stack">
                          <span className={statusBadgeClass(item.request.status)}>
                            {requestStatusLabel(item.request.status)}
                          </span>
                          {item.reopened ? (
                            <span className="badge badge-warn" data-testid="report-reopened">
                              Kaldırıldı → geri açıldı
                            </span>
                          ) : item.lastResolution && state === 'resolved' ? (
                            <span className="cell-muted">
                              {reportResolutionLabel(item.lastResolution.resolution)} ·{' '}
                              {formatDateTime(item.lastResolution.resolvedAt)}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td>{formatDateTime(item.firstReportedAt)}</td>
                      <td className="col-num">
                        <span className="badge badge-warn" data-testid="report-count">
                          {item.reportCount}
                        </span>
                      </td>
                      <td>
                        <div className="badge-row">
                          {item.reasons.map((reason) => (
                            <span className="badge badge-muted" key={reason}>
                              {reportReasonLabel(reason)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <div className="cell-stack">
                          {item.reporters.map((reporter) => (
                            <Link
                              className="cell-link"
                              href={`/providers/${reporter.id}`}
                              key={reporter.id}
                            >
                              {reporter.businessName}
                            </Link>
                          ))}
                        </div>
                      </td>
                      <td>
                        {item.request.descriptionExcerpt ? (
                          <span className="report-queue-excerpt">
                            {item.request.descriptionExcerpt}
                          </span>
                        ) : (
                          <span className="cell-muted">—</span>
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
