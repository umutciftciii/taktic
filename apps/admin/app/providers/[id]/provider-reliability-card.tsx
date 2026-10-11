import Link from 'next/link';
import { formatDateTime } from '../../../lib/api';
import {
  INCIDENT_DECISION_LABELS,
  PROVIDER_INCIDENT_STATUS_LABELS,
  RELIABILITY_LEVEL_LABELS,
  RELIABILITY_REVIEW_STATUS_LABELS,
  formatRatio,
  incidentStatusBadgeClass,
  reliabilityLevelBadgeClass,
  reliabilityNotice,
  reviewStatusBadgeClass,
  type ProviderReliabilityView,
} from '../../../lib/service-incidents';
import { SectionCard } from '../../../components/section-card';
import { KeyValueList } from '../../../components/key-value-list';
import { ReviewActions, type ReviewFormActions } from '../../provider-reliability/review-actions';

/**
 * REL-002 Faz 4 — the provider's "Güvenilirlik" card (`#guvenilirlik`), from
 * `GET /admin/providers/:providerId/reliability` (PROVIDER_RELIABILITY_READ;
 * the page renders this only for a session that holds it).
 *
 * Internal only. The banner at ADMIN_REVIEW_REQUIRED never blocks anything and
 * there is no suspension control here: the page's own "Durum yönetimi" card
 * is where a provider's status changes.
 */
export function ProviderReliabilityCard({
  view,
  canManage,
  canOpenIncidents,
  noticeCode,
  formActions,
}: {
  view: ProviderReliabilityView;
  canManage: boolean;
  canOpenIncidents: boolean;
  /** The `?reliability=` code a review action left behind. */
  noticeCode?: string;
  formActions: ReviewFormActions;
}) {
  const { summary, incidents, reviews } = view;
  const notice = reliabilityNotice(noticeCode);
  const openReview = summary.openReview;

  return (
    <SectionCard
      title="Güvenilirlik"
      subtitle={`Son ${summary.windowDays} gün, geçerli kararlardan hesaplanır. Yalnız iç kullanım içindir.`}
      className="is-wide"
      id="guvenilirlik"
      testId="provider-reliability-card"
      actions={
        <span className={reliabilityLevelBadgeClass(summary.level)} data-testid="reliability-level" data-level={summary.level}>
          {RELIABILITY_LEVEL_LABELS[summary.level]}
        </span>
      }
    >
      {notice ? (
        <p
          className={notice.tone === 'success' ? 'notice notice-success' : 'notice notice-error'}
          role={notice.tone === 'success' ? 'status' : 'alert'}
          data-testid="reliability-notice"
        >
          {notice.text}
        </p>
      ) : null}

      {summary.level === 'ADMIN_REVIEW_REQUIRED' ? (
        <p className="notice notice-warning" data-testid="reliability-review-banner">
          {summary.thresholds.reviewAt} veya daha fazla doğrulanmış aksaklık — yönetici incelemesi gerekli.
        </p>
      ) : null}

      <KeyValueList
        items={[
          {
            label: `${summary.windowDays}g doğrulanmış aksaklık`,
            value: <strong data-testid="reliability-confirmed-count">{summary.confirmed}</strong>,
          },
          { label: `${summary.windowDays}g reddedilen`, value: String(summary.dismissed), testId: 'reliability-dismissed-count' },
          { label: 'Karar bekleyen', value: String(summary.pending), testId: 'reliability-pending-count' },
          {
            label: 'Yanıt oranı',
            value: `${formatRatio(summary.responseRate)} (${summary.responded}/${summary.total})`,
          },
          {
            label: 'Geç / süresi geçmiş yanıt',
            value: `${summary.lateResponses} / ${summary.overdueResponses}`,
          },
          {
            label: 'Eşikler',
            value: `${summary.thresholds.warningAt} → Uyarı · ${summary.thresholds.reviewAt} → Yönetici incelemesi`,
          },
          {
            label: 'Açık inceleme',
            value: openReview ? (
              <span className="cell-stack">
                <span className={reviewStatusBadgeClass(openReview.status)} data-testid="reliability-review-status">
                  {RELIABILITY_REVIEW_STATUS_LABELS[openReview.status]}
                </span>
                <span className="cell-muted">açılış {formatDateTime(openReview.openedAt)}</span>
              </span>
            ) : (
              'Yok'
            ),
          },
        ]}
      />

      {openReview && canManage ? (
        <ReviewActions
          review={openReview}
          providerName={view.provider.businessName}
          from="provider"
          formActions={formActions}
        />
      ) : null}

      <h3 className="form-section-title">Bildirimler</h3>
      {incidents.length === 0 ? (
        <p className="detail-muted-note" data-testid="reliability-incidents-empty">
          Bu hizmet veren için hizmet aksaklığı bildirimi yok.
        </p>
      ) : (
        <ol className="timeline" data-testid="reliability-incidents">
          {incidents.map((incident) => {
            const effective = incident.adjudications.find((entry) => entry.effective) ?? null;
            const corrected = incident.adjudications.some((entry) => entry.kind === 'CORRECTION');
            return (
              <li key={incident.id} className="timeline-item" data-testid="reliability-incident" data-status={incident.status}>
                <time className="timeline-when" dateTime={incident.reportedAt}>
                  {formatDateTime(incident.reportedAt)}
                </time>
                <div className="timeline-body">
                  <p className="timeline-title">
                    {canOpenIncidents ? (
                      <Link className="cell-link" href={`/service-incidents/${incident.id}`}>
                        <code>{incident.incidentNumber}</code>
                      </Link>
                    ) : (
                      <code>{incident.incidentNumber}</code>
                    )}{' '}
                    · {incident.reasonLabel}{' '}
                    <span className={incidentStatusBadgeClass(incident.status)}>
                      {PROVIDER_INCIDENT_STATUS_LABELS[incident.status] ?? incident.status}
                    </span>
                  </p>
                  <p className="timeline-meta">
                    {incident.roundNumber}. tur · {incident.request.requestNumber ?? `#${incident.request.id.slice(-8)}`}
                    {effective ? ` · ${INCIDENT_DECISION_LABELS[effective.decision]}${corrected ? ' (düzeltildi)' : ''}` : ' · Karar bekliyor'}
                    {incident.inWindow ? '' : ' · 90 gün dışında'}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <h3 className="form-section-title">İnceleme geçmişi</h3>
      {reviews.length === 0 ? (
        <p className="detail-muted-note" data-testid="reliability-reviews-empty">
          Güvenilirlik incelemesi açılmadı.
        </p>
      ) : (
        <ol className="timeline" data-testid="reliability-reviews">
          {reviews.map((review) => (
            <li key={review.id} className="timeline-item" data-testid="reliability-review" data-status={review.status}>
              <time className="timeline-when" dateTime={review.openedAt}>
                {formatDateTime(review.openedAt)}
              </time>
              <div className="timeline-body">
                <p className="timeline-title">
                  <span className={reviewStatusBadgeClass(review.status)}>
                    {RELIABILITY_REVIEW_STATUS_LABELS[review.status]}
                  </span>{' '}
                  {review.openedBySystem ? 'Sistem açtı' : 'Açıldı'}
                  {review.triggerIncident ? ` · tetikleyen ${review.triggerIncident.incidentNumber}` : ''}
                </p>
                {review.acknowledgedAt ? (
                  <p className="timeline-meta">
                    Üstlenen: {review.acknowledgedBy?.name ?? 'İsimsiz'} · {formatDateTime(review.acknowledgedAt)}
                  </p>
                ) : null}
                {review.resolvedAt ? (
                  <p className="timeline-meta">
                    Sonuçlandıran: {review.resolvedBy?.name ?? 'İsimsiz'} · {formatDateTime(review.resolvedAt)}
                  </p>
                ) : null}
                {review.note ? <p className="timeline-meta detail-prose">{review.note}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}
