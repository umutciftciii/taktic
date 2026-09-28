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
  type RequestReportQueueItem,
} from '../../../lib/api';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { CursorPagination } from '../../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../../components/tabs';
import { buildHref } from '../../../lib/list-query';

/**
 * Şikayet edilen talepler (#4), design `list:complaints` (ADMIN-DESIGN-001 Faz 3A).
 *
 * A row is a *request*, not a report. Three providers reporting the same
 * request is one thing for an operator to decide, and the decision — dismiss
 * or remove — is taken once on the request detail's "Şikayet" tab, where the
 * operator can read what was reported before deciding about it. The queue
 * itself is read-only.
 *
 * Oldest first report at the top: the request that has waited longest on a
 * decision is the one the operator should see first.
 *
 * Two saved views, by report state. "Açık" is the work; "Çözülen" is the
 * record, and it carries the last decision so a request that keeps coming back
 * shows as such. A request a report removed and an operator later put back
 * reads "Kaldırıldı → geri açıldı" — derived by the API from the last decision
 * and the request's current status, never stored.
 *
 * The design's "Harcanan kredi" column is not drawn: the queue API does not
 * carry the reporters' spend, and a guessed figure would be worse than none.
 */

export const dynamic = 'force-dynamic';

const PATH = '/requests/reports';

/**
 * The design's ⓘ, corrected: a decision here does not refund only the
 * reporter — removing the request closes every active offer on it and
 * refunds each one (request-report-flow.spec.ts), and dismissing it leaves
 * the request and every credit where they were.
 */
const SCREEN_INFO =
  'Hizmet veren bir talebe teklif verdikten sonra "müşteriye ulaşamadım", "adres yanlış" veya "iş zaten yapılmış" diyebilir. Karar talep detayının Şikayet sekmesinde verilir. "Talebi kaldır" talebi yayından indirir, üzerindeki açık teklifleri kapatır ve harcanan kredileri iade eder; "Uygun bulundu" talebi ve kredileri olduğu gibi bırakır. Karar vermeden önce talebi açıp müşteri bilgilerine bakmanız beklenir.';

type QueueState = 'open' | 'resolved';

type ReportQueuePageProps = {
  searchParams: Promise<{ state?: string; cursor?: string }>;
};

/** In the design's order (`08-sikayet-edilen-talepler`), with this queue's own count and excerpt. */
const COLUMNS: DataColumn[] = [
  { key: 'request', label: 'Talep' },
  { key: 'reporters', label: 'Şikayeti eden' },
  { key: 'reasons', label: 'Gerekçe' },
  { key: 'firstReportedAt', label: 'İlk bildirim' },
  { key: 'count', label: 'Bildirim', align: 'end' },
  { key: 'status', label: 'Durum' },
  { key: 'excerpt', label: 'Açıklama' },
  { key: 'actions', label: 'İşlemler', srOnly: true },
];

function normalizeState(value: string | undefined): QueueState {
  return value === 'resolved' ? 'resolved' : 'open';
}

export default async function RequestReportsQueuePage({ searchParams }: ReportQueuePageProps) {
  const { can } = await requireAdmin('REQUEST_REPORTS_READ');
  const canOpenRequests = can('REQUESTS_READ');
  const canOpenProviders = can('PROVIDERS_READ_DETAIL');

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

  // Only the open view's rows are on this page; the other view has no count.
  const views: TabItem[] = [
    { key: 'open', label: 'Açık', testId: 'report-view-open' },
    { key: 'resolved', label: 'Çözülen', testId: 'report-view-resolved' },
  ].map((view) => (view.key === state && !cursor && !queue.nextCursor ? { ...view, count: queue.items.length } : view));

  const summary =
    state === 'open'
      ? queue.items.length === 0
        ? 'Karar bekleyen talep yok'
        : `${queue.nextCursor ? 'Bu sayfada ' : ''}${queue.items.length} talep karar bekliyor · en eski bildirim başta`
      : queue.items.length === 0
        ? 'Henüz karar verilmiş talep yok'
        : `${queue.nextCursor ? 'Bu sayfada ' : ''}${queue.items.length} talep hakkında karar verildi`;

  return (
    <main className="request-reports-page">
      <PageHeader title="Şikayet edilen talepler" subtitle={summary} info={SCREEN_INFO} />

      <SavedViewTabs
        label="Bildirim durumu"
        items={views}
        active={state}
        path={PATH}
        params={{}}
        param="state"
        defaultKey="open"
        testId="report-views"
      />

      <div className="data-list-card">
        {queue.items.length === 0 ? (
          <EmptyState
            title={state === 'open' ? 'Açık bildirim yok' : 'Çözülmüş bildirim yok'}
            description={
              state === 'open'
                ? 'Bir hizmet veren bir talebi bildirdiğinde burada, en eski bildirim başta olacak şekilde listelenir.'
                : 'Açık bir bildirim hakkında karar verildiğinde burada kaydı kalır.'
            }
          />
        ) : (
          <DataTable caption="Şikayet edilen talepler" columns={COLUMNS} minWidth={1080} testId="report-queue">
            {queue.items.map((item) => (
              <QueueRow
                key={item.request.id}
                item={item}
                state={state}
                canOpenRequests={canOpenRequests}
                canOpenProviders={canOpenProviders}
              />
            ))}
          </DataTable>
        )}
        {queue.items.length > 0 ? (
          <CursorPagination
            count={queue.items.length}
            noun="talep"
            // The API pages forward only and hands out no cursor for the page
            // before; the browser's Back is the way there, as it always was.
            previousHref={null}
            nextHref={
              queue.nextCursor
                ? buildHref(PATH, { state: state === 'open' ? '' : state, cursor: queue.nextCursor })
                : null
            }
            summaryTestId="report-queue-count"
          />
        ) : null}
      </div>
    </main>
  );
}

function QueueRow({
  item,
  state,
  canOpenRequests,
  canOpenProviders,
}: {
  item: RequestReportQueueItem;
  state: QueueState;
  canOpenRequests: boolean;
  canOpenProviders: boolean;
}) {
  const requestRef = item.request.requestNumber ?? `#${item.request.id.slice(-8)}`;
  return (
    <tr data-testid="report-queue-row" data-request-id={item.request.id}>
      <td>
        <div className="cell-stack">
          {canOpenRequests ? (
            <Link
              className="cell-link"
              href={`/requests/${item.request.id}?tab=sikayet`}
              aria-label={`Talebi aç: ${requestRef}`}
            >
              <code className="display-number">{requestRef}</code>
            </Link>
          ) : (
            <code className="display-number">{requestRef}</code>
          )}
          <span>
            {item.request.categoryName} · {item.request.city}/{item.request.district}
          </span>
          <span className="cell-muted">{formatDateTime(item.request.submittedAt)}</span>
        </div>
      </td>
      <td>
        <div className="cell-stack">
          {item.reporters.map((reporter) =>
            canOpenProviders ? (
              <Link className="cell-link" href={`/providers/${reporter.id}`} key={reporter.id}>
                {reporter.businessName}
              </Link>
            ) : (
              <span key={reporter.id}>{reporter.businessName}</span>
            ),
          )}
        </div>
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
      <td>{formatDateTime(item.firstReportedAt)}</td>
      <td className="is-num">
        <span className="badge badge-warn" data-testid="report-count">
          {item.reportCount}
        </span>
      </td>
      <td>
        <div className="cell-stack">
          <span className={statusBadgeClass(item.request.status)}>{requestStatusLabel(item.request.status)}</span>
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
      <td>
        {item.request.descriptionExcerpt ? (
          <span className="report-queue-excerpt">{item.request.descriptionExcerpt}</span>
        ) : (
          <span className="cell-muted">—</span>
        )}
      </td>
      <td className="col-actions">
        {/* The design's "Aç": to the Şikayet tab, where the decision is taken. */}
        {canOpenRequests ? (
          <Link
            className="btn btn-secondary btn-sm"
            href={`/requests/${item.request.id}?tab=sikayet`}
            aria-label={`Aç: ${requestRef}`}
          >
            Aç
          </Link>
        ) : null}
      </td>
    </tr>
  );
}
