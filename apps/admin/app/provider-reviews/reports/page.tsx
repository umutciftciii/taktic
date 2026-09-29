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
  type ReviewReportQueueItem,
} from '../../../lib/api';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { CursorPagination } from '../../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../../components/tabs';
import { buildHref } from '../../../lib/list-query';

/**
 * Şikayet edilen yorumlar (#15), design `list:reviewReports` (paket 2
 * `34-sikayet-edilen-yorumlar`, ADMIN-DESIGN-001 Faz 3C).
 *
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
 *
 * Not drawn from the design: its Ara, Durum and Tarih filters (the API takes
 * only `state` and `cursor`), the customer's name under the comment (the
 * queue answer does not carry it; the review screen does), and "Kapanmış
 * şikayetleri göster" as a button — the "Çözülen" view is that list.
 */

export const dynamic = 'force-dynamic';

const PATH = '/provider-reviews/reports';

/**
 * The design's ⓘ, corrected against provider-review-moderation.service.ts:
 * the decision has three outcomes, not two, only a whole removal changes the
 * average, a removal mails the customer, and every decision can be put back.
 */
const SCREEN_INFO =
  'Hizmet verenler kendilerine yazılan bir değerlendirmeyi haksız bulduklarında bildirir. Karar değerlendirmenin kendi ekranında verilir. "Yorumu kaldır" yalnız metni profilden indirir, yıldız ortalamada kalır; "Değerlendirmeyi kaldır" yıldızı da indirir ve ortalama yeniden hesaplanır. İkisinde de müşteriye seçilen gerekçeyle e-posta gider ve kararı "Geri getir" ile geri alabilirsiniz. "Uygun bulundu" bildirimi kapatır, değerlendirme olduğu gibi kalır. Yorumun içeriği düzenlenemez.';

type QueueState = 'open' | 'resolved';

type ReviewReportsQueuePageProps = {
  searchParams: Promise<{ state?: string; cursor?: string }>;
};

/** In the design's order, with this queue's request column kept (K7). */
const COLUMNS: DataColumn[] = [
  { key: 'comment', label: 'Yorum' },
  { key: 'provider', label: 'İşletme' },
  { key: 'reason', label: 'Şikayet gerekçesi' },
  { key: 'rating', label: 'Puan', align: 'end' },
  { key: 'request', label: 'Talep' },
  { key: 'reportedAt', label: 'Bildirim' },
  { key: 'status', label: 'Durum' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

function normalizeState(value: string | undefined): QueueState {
  return value === 'resolved' ? 'resolved' : 'open';
}

export default async function ReviewReportsQueuePage({ searchParams }: ReviewReportsQueuePageProps) {
  const { can } = await requireAdmin('PROVIDER_REVIEWS_READ');
  const canReadRequests = can('REQUESTS_READ');
  const canReadProviders = can('PROVIDERS_READ_DETAIL');

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

  // A count only when this page is the whole list: the API returns pages of
  // 50 and no total, so a number on a paged view would be a guess.
  const views: TabItem[] = [
    { key: 'open', label: 'Açık', testId: 'review-report-view-open' },
    { key: 'resolved', label: 'Çözülen', testId: 'review-report-view-resolved' },
  ].map((view) => (view.key === state && !cursor && !queue.nextCursor ? { ...view, count: queue.items.length } : view));

  const onPage = queue.nextCursor || cursor ? 'Bu sayfada ' : '';
  const summary =
    state === 'open'
      ? queue.items.length === 0
        ? 'Karar bekleyen yorum yok'
        : `${onPage}${queue.items.length} yorum karar bekliyor · en eski bildirim başta`
      : queue.items.length === 0
        ? 'Henüz karar verilmiş bildirim yok'
        : `${onPage}${queue.items.length} bildirim hakkında karar verildi`;

  return (
    <main className="request-reports-page">
      <PageHeader title="Şikayet edilen yorumlar" subtitle={summary} info={SCREEN_INFO} />

      <SavedViewTabs
        label="Bildirim durumu"
        items={views}
        active={state}
        path={PATH}
        params={{}}
        param="state"
        defaultKey="open"
        testId="review-report-views"
      />

      <div className="data-list-card">
        {queue.items.length === 0 ? (
          <EmptyState
            title={state === 'open' ? 'Açık bildirim yok' : 'Çözülmüş bildirim yok'}
            description={
              state === 'open'
                ? 'Bir hizmet veren bir yorumu bildirdiğinde burada, en eski bildirim başta olacak şekilde listelenir.'
                : 'Açık bir bildirim hakkında karar verildiğinde burada kaydı kalır.'
            }
          />
        ) : (
          <DataTable caption="Şikayet edilen yorumlar" columns={COLUMNS} minWidth={1080} testId="review-report-queue">
            {queue.items.map((item) => (
              <QueueRow
                key={item.report.id}
                item={item}
                state={state}
                canReadRequests={canReadRequests}
                canReadProviders={canReadProviders}
              />
            ))}
          </DataTable>
        )}
        {queue.items.length > 0 ? (
          <CursorPagination
            count={queue.items.length}
            noun="bildirim"
            previousHref={null}
            nextHref={
              queue.nextCursor
                ? buildHref(PATH, { state: state === 'open' ? '' : state, cursor: queue.nextCursor })
                : null
            }
            summaryTestId="review-report-count"
          />
        ) : null}
      </div>
    </main>
  );
}

function QueueRow({
  item,
  state,
  canReadRequests,
  canReadProviders,
}: {
  item: ReviewReportQueueItem;
  state: QueueState;
  canReadRequests: boolean;
  canReadProviders: boolean;
}) {
  const requestRef = item.request.requestNumber ?? `#${item.request.id.slice(-8)}`;
  return (
    <tr data-testid="review-report-row" data-review-id={item.review.id}>
      <td>
        <div className="cell-stack">
          {item.review.commentExcerpt ? (
            <strong className="report-queue-excerpt cell-break">“{item.review.commentExcerpt}”</strong>
          ) : (
            <span className="cell-muted">Yorum yok, yalnız yıldız</span>
          )}
          <span className="cell-muted">değerlendirme {formatDateTime(item.review.createdAt)}</span>
        </div>
      </td>
      <td>
        {canReadProviders ? (
          <Link className="cell-link" href={`/providers/${item.provider.id}`}>
            {item.provider.businessName}
          </Link>
        ) : (
          item.provider.businessName
        )}
      </td>
      <td>
        <span className="badge badge-muted">{reviewReasonLabel(item.report.reason)}</span>
      </td>
      <td className="is-num">
        <strong aria-label={`5 üzerinden ${item.review.rating}`}>{item.review.rating},0</strong>
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
          {item.report.resolvedAt === null ? (
            <span className="badge badge-bad" data-testid="review-report-pending">
              Karar bekliyor
            </span>
          ) : null}
          {/* The review's own state, which a decision may since have changed again. */}
          <span className={reviewStateBadgeClass(item.review)}>{reviewStateLabel(item.review)}</span>
          {item.report.resolution && item.report.resolvedAt ? (
            <span className="cell-muted">
              {reviewResolutionLabel(item.report.resolution)} · {formatDateTime(item.report.resolvedAt)}
            </span>
          ) : null}
          {item.lastDecision && state === 'resolved' ? (
            <span className="cell-muted">son karar: {reviewModerationActionLabel(item.lastDecision.action)}</span>
          ) : null}
        </div>
      </td>
      <td className="col-actions">
        <Link
          className="btn btn-secondary btn-sm"
          href={`/provider-reviews/${item.review.id}`}
          aria-label={`Aç: ${item.provider.businessName} değerlendirmesi`}
        >
          Aç
        </Link>
      </td>
    </tr>
  );
}
