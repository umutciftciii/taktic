import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  requireAdmin,
  reviewModerationActionLabel,
  reviewReasonLabel,
  reviewResolutionLabel,
  reviewStateBadgeClass,
  reviewStateLabel,
  type AdminReviewDetail,
} from '../../../lib/api';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { dismissReviewReportAction } from './actions';
import { ReviewModerationForm } from './moderation-form';

/**
 * One review, with everything the operator may know about it.
 *
 * Everything: the comment even after its removal (the operator has to be able
 * to read what was taken down, and why), the customer's name (this is the
 * one screen it appears on — no public or provider projection carries it),
 * every report with its note, and the append-only moderation log.
 *
 * Two decisions live here. "Uygun bulundu" closes the open report and
 * changes nothing about the review. The moderation form takes the comment
 * or the whole review down, or puts it back; each of those closes any open
 * report as a side effect on the API side, so a removal never leaves a
 * report waiting on a decision that was just taken.
 *
 * What is deliberately absent: a way to file a report on the provider's
 * behalf. A report is the business's own statement about a review of its
 * own work, and the API answers a SUPER_ADMIN with a 403 on that route.
 */

export const dynamic = 'force-dynamic';

type ReviewDetailPageProps = {
  params: Promise<{ reviewId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
};

const OK_MESSAGES: Record<string, string> = {
  REMOVE_COMMENT: 'Yorum kaldırıldı. Yıldız ortalamada kalır; müşteriye gerekçe bildirildi.',
  REMOVE_REVIEW: 'Değerlendirme kaldırıldı. Ortalama yeniden hesaplandı; müşteriye gerekçe bildirildi.',
  RESTORE: 'Değerlendirme geri getirildi.',
  DISMISSED: 'Bildirim uygun bulundu olarak kapatıldı; değerlendirme olduğu gibi kalır.',
};

const ERROR_MESSAGES: Record<string, string> = {
  action: 'Tanınmayan bir karar gönderildi.',
  reason: 'Kaldırmak için bir gerekçe seçilmelidir.',
  noop: 'Bu karar zaten uygulanmış; sayfa güncel durumu gösteriyor.',
  noOpen: 'Bu değerlendirmede kapatılacak açık bir bildirim yok.',
};

export default async function ReviewDetailPage({ params, searchParams }: ReviewDetailPageProps) {
  const { can } = await requireAdmin('PROVIDER_REVIEWS_READ');
  const canModerate = can('PROVIDER_REVIEWS_MODERATE');
  const canReadRequests = can('REQUESTS_READ');
  const canReadProviderDetail = can('PROVIDERS_READ_DETAIL');

  const { reviewId } = await params;
  const { ok, error } = await searchParams;

  const review = await fetchOrNotFound(() =>
    apiFetch<AdminReviewDetail>(`/provider-reviews/${encodeURIComponent(reviewId)}`),
  );

  const okMessage = ok ? (OK_MESSAGES[ok] ?? null) : null;
  const errorMessage = error ? (ERROR_MESSAGES[error] ?? null) : null;
  const openReport = review.reports.find((report) => report.resolvedAt === null) ?? null;
  const requestRef = review.request.requestNumber ?? `#${review.request.id.slice(-8)}`;

  return (
    <main className="request-detail-page">
      <p className="breadcrumbs">
        {can('DASHBOARD_READ') ? <Link href="/">Dashboard</Link> : <span>Dashboard</span>}
        <span aria-hidden="true">/</span>
        <Link href="/provider-reviews/reports">Değerlendirme bildirimleri</Link>
        <span aria-hidden="true">/</span>
        <span>Değerlendirme</span>
      </p>

      <PageHeader
        title={`${review.provider.businessName} — değerlendirme`}
        subtitle={
          <span className="request-header-meta">
            <span className={reviewStateBadgeClass(review)} data-testid="review-state">
              {reviewStateLabel(review)}
            </span>
            <span className="badge badge-muted" data-testid="review-rating" aria-label={`5 üzerinden ${review.rating}`}>
              ★ {review.rating}
            </span>
            <span className="muted">· {formatDateTime(review.createdAt)}</span>
          </span>
        }
      />

      {okMessage ? (
        <div className="notice notice-success" role="status" data-testid="review-ok" style={{ marginBottom: 12 }}>
          {okMessage}
        </div>
      ) : null}
      {errorMessage ? (
        <div className="notice notice-error" role="status" data-testid="review-error" style={{ marginBottom: 12 }}>
          {errorMessage}
        </div>
      ) : null}

      <div className="request-detail-card-grid">
        <SectionCard
          className="card-wide"
          title="Değerlendirme"
          subtitle="Müşterinin yıldızı ve yorumu. Kaldırılmış bir yorum burada okunmaya devam eder; dışarıda görünmez."
        >
          <dl className="info-grid info-grid-4">
            <div>
              <dt>Puan</dt>
              <dd>{review.rating} / 5</dd>
            </div>
            <div>
              <dt>Durum</dt>
              <dd>
                <span className={reviewStateBadgeClass(review)}>{reviewStateLabel(review)}</span>
              </dd>
            </div>
            <div>
              <dt>Yorum kaldırıldı</dt>
              <dd>{review.commentRemovedAt ? formatDateTime(review.commentRemovedAt) : '—'}</dd>
            </div>
            <div>
              <dt>Değerlendirme kaldırıldı</dt>
              <dd>{review.removedAt ? formatDateTime(review.removedAt) : '—'}</dd>
            </div>
          </dl>
          {review.comment ? (
            <p className="request-description" data-testid="review-comment">
              {review.comment}
            </p>
          ) : (
            <p className="cell-muted">Müşteri yorum yazmamış.</p>
          )}

          {canModerate ? (
            <ReviewModerationForm
              reviewId={review.id}
              hasLiveComment={review.comment !== null && !review.commentRemoved}
              removed={review.removed}
              commentRemoved={review.commentRemoved}
            />
          ) : null}
        </SectionCard>

        <SectionCard title="Talep" subtitle="Değerlendirilen iş.">
          <dl className="info-grid">
            <div>
              <dt>Talep</dt>
              <dd>
                {canReadRequests ? (
                  <Link className="cell-link" href={`/requests/${review.request.id}`}>
                    <code className="display-number">{requestRef}</code>
                  </Link>
                ) : (
                  <code className="display-number">{requestRef}</code>
                )}
              </dd>
            </div>
            <div>
              <dt>Kategori</dt>
              <dd>{review.request.categoryName}</dd>
            </div>
            <div>
              <dt>Konum</dt>
              <dd>
                {review.request.city}/{review.request.district}
              </dd>
            </div>
            <div>
              <dt>Müşteri</dt>
              <dd data-testid="review-customer-name">{review.request.customerName}</dd>
            </div>
          </dl>
        </SectionCard>

        <SectionCard title="Hizmet veren" subtitle="Değerlendirilen işletme.">
          <dl className="info-grid">
            <div>
              <dt>İşletme</dt>
              <dd>
                {canReadProviderDetail ? (
                  <Link className="cell-link" href={`/providers/${review.provider.id}`}>
                    {review.provider.businessName}
                  </Link>
                ) : (
                  review.provider.businessName
                )}
              </dd>
            </div>
          </dl>
        </SectionCard>

        <SectionCard
          className="card-wide"
          title="Bildirimler"
          subtitle="Hizmet verenin bu değerlendirme hakkındaki bildirimleri ve verilen kararlar. Not yalnız yönetici görür."
        >
          {review.reports.length === 0 ? (
            <EmptyState title="Bildirim yok." description="Bu değerlendirme hakkında bir bildirim gelmedi." />
          ) : (
            <ul className="report-list" data-testid="review-report-list">
              {review.reports.map((report) => (
                <li
                  className={report.resolvedAt ? 'report-item is-resolved' : 'report-item'}
                  key={report.id}
                  data-testid="review-report-item"
                >
                  <div className="report-item-head">
                    <span className="badge badge-muted">{reviewReasonLabel(report.reason)}</span>
                    {canReadProviderDetail ? (
                      <Link className="cell-link" href={`/providers/${report.reporter.id}`}>
                        {report.reporter.businessName}
                      </Link>
                    ) : (
                      <span>{report.reporter.businessName}</span>
                    )}
                    <span className="cell-muted">{formatDateTime(report.createdAt)}</span>
                  </div>
                  {report.note ? (
                    <p className="report-item-note">{report.note}</p>
                  ) : (
                    <p className="report-item-note cell-muted">Not yazılmamış.</p>
                  )}
                  <div className="report-item-resolution">
                    {report.resolvedAt && report.resolution ? (
                      <>
                        <span
                          className={
                            report.resolution === 'DISMISSED' ? 'badge badge-good' : 'badge badge-bad'
                          }
                        >
                          {reviewResolutionLabel(report.resolution)}
                        </span>
                        <span className="cell-muted">
                          {formatDateTime(report.resolvedAt)}
                          {report.resolvedBy?.name ? ` · ${report.resolvedBy.name}` : ''}
                        </span>
                        {report.resolutionNote ? (
                          <span className="report-item-resolution-note">{report.resolutionNote}</span>
                        ) : null}
                      </>
                    ) : (
                      <span className="badge badge-warn">Karar bekliyor</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {openReport && canModerate ? (
            <div className="report-decisions" data-testid="review-report-decisions">
              <p className="report-decisions-intro">
                Açık bir bildirim var. Yorumu ya da değerlendirmeyi kaldırmak bildirimi de kapatır;
                değerlendirme olduğu gibi kalacaksa aşağıdan uygun bulun.
              </p>
              <form action={dismissReviewReportAction} className="status-reject-form report-decision-form">
                <input type="hidden" name="reviewId" value={review.id} />
                <label className="status-reject-field">
                  <span>Not (opsiyonel, yalnız yönetici görür)</span>
                  <textarea name="resolutionNote" placeholder="Neden uygun bulundu?" />
                </label>
                <button className="btn btn-secondary btn-sm" type="submit" data-testid="review-dismiss">
                  Uygun bulundu
                </button>
              </form>
            </div>
          ) : null}
        </SectionCard>

        <SectionCard
          className="card-wide"
          title="Moderasyon günlüğü"
          subtitle="Bu değerlendirme üzerindeki her karar, kim tarafından ve ne zaman."
        >
          {review.moderation.length === 0 ? (
            <p className="cell-muted" style={{ margin: 0 }}>
              Henüz bir karar verilmedi.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="data-table" data-testid="review-moderation-log">
                <thead>
                  <tr>
                    <th>Karar</th>
                    <th>Gerekçe</th>
                    <th>Not</th>
                    <th>Yönetici</th>
                    <th>Zaman</th>
                  </tr>
                </thead>
                <tbody>
                  {review.moderation.map((entry) => (
                    <tr key={entry.id}>
                      <td>{reviewModerationActionLabel(entry.action)}</td>
                      <td>{entry.reason ? reviewReasonLabel(entry.reason) : '—'}</td>
                      <td>{entry.note ?? '—'}</td>
                      <td>{entry.performedBy.name ?? '-'}</td>
                      <td>{formatDateTime(entry.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>
    </main>
  );
}
