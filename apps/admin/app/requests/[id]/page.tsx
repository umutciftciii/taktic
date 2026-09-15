import Link from 'next/link';
import {
  ApiError,
  apiFetch,
  type CustomerReviewState,
  ContactRevealDetail,
  fetchOrNotFound,
  Offer,
  QualityScoreBreakdown,
  REMOVAL_REASON_CUSTOMER_LABELS,
  REPORT_REASON_ADMIN_LABELS,
  REPORT_REASON_KEYS,
  RequestReport,
  ServiceRequest,
  formatBudgetRange,
  formatDate,
  formatDateTime,
  formatPrice,
  qualityBadgeClass,
  qualityBreakdownLabel,
  qualityLabel,
  reportReasonLabel,
  reportResolutionLabel,
  reviewStateBadgeClass,
  reviewStateLabel,
  requestStatusLabel,
  statusBadgeClass,
  statusLabel,
  urgencyLabel,
} from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { EmptyState } from '../../../components/empty-state';
import {
  cancelRequestAction,
  completeRequestAction,
  recalculateRequestQualityAction,
  reopenRequestAction,
  resolveReportsAction,
  updateRequestStatusAction,
} from '../actions';

type RequestDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ statusError?: string; reportError?: string }>;
};

/**
 * The statuses a report can take a request down from. A matched request is
 * out of the marketplace already and has a provider on it; removing it is the
 * lifecycle's "İptal et", not a report decision. The API enforces the same
 * list (REQUEST_NOT_REMOVABLE); this only decides whether the button is live.
 */
const REMOVABLE_STATUSES: ReadonlySet<string> = new Set(['APPROVED', 'IN_REVIEW', 'SUBMITTED']);

const REPORT_ERROR_MESSAGES: Record<string, string> = {
  notRemovable:
    'Talep kaldırılmadı. Talep eşleşmiş ya da zaten kapanmış durumda; eşleşmiş talep için "İptal et" kullanın.',
  noOpen: 'Karar kaydedilmedi. Bu talebin açık bildirimi kalmamış; sayfa yenilendi.',
  reasonRequired: 'Talebi kaldırmak için gerekçe seçilmelidir.',
  notReopenable:
    'Talep geri açılmadı. Yalnız bir bildirim sonucu kaldırılmış ve hâlâ reddedilmiş durumdaki talep geri açılabilir.',
};

const RECENT_OFFERS_LIMIT = 3;

/** An approved request stays open for 14 days from its approval moment. */
const REQUEST_OPEN_DAYS = 14;

/**
 * When the expiry scheduler would close this request, or null when there is
 * nothing to project: the request is not open any more, or it was approved
 * before approvedAt existed and is therefore never picked up by the scheduler.
 */
function plannedExpiry(request: ServiceRequest): string | null {
  if (request.status !== 'APPROVED' || !request.approvedAt) {
    return null;
  }

  const approved = new Date(request.approvedAt);
  if (Number.isNaN(approved.getTime())) {
    return null;
  }

  return new Date(approved.getTime() + REQUEST_OPEN_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export default async function RequestDetailPage({
  params,
  searchParams,
}: RequestDetailPageProps) {
  const { id } = await params;
  const { statusError, reportError } = await searchParams;
  const request = await fetchOrNotFound(() =>
    apiFetch<ServiceRequest>(`/service-requests/${id}`),
  );
  const [offers, reportsResult, reviewState] = await Promise.all([
    apiFetch<Offer[]>(`/offers?requestId=${id}`).catch(() => [] as Offer[]),
    // Operator-only: a reporter's note is shown here and nowhere the customer
    // or another provider can see. A failed load is kept apart from an empty
    // list: "no reports" must not be said about a request whose reports could
    // not be read, and no decision form may be offered on it.
    apiFetch<RequestReport[]>(`/service-requests/${id}/reports`).then(
      (reports) => ({ reports, failed: false as const }),
      () => ({ reports: [] as RequestReport[], failed: true as const }),
    ),
    // The customer's review of the matched provider, read the way the
    // customer's own screen reads it (a SUPER_ADMIN may look). Null hides
    // the card rather than the screen; the review has its own page.
    apiFetch<CustomerReviewState>(`/service-requests/${id}/review`).catch((error: unknown) => {
      if (error instanceof ApiError) return null;
      throw error;
    }),
  ]);
  const reports = reportsResult.reports;
  const reportsFailed = reportsResult.failed;
  // Audit only: this panel reports whether contact details were opened and
  // under which disclosure version. It renders no contact value — the operator
  // already has the customer and provider panels for that, and this feature
  // adds nothing to what they show.
  const contactReveal = await apiFetch<ContactRevealDetail>(
    `/service-requests/${id}/contact-reveal`,
  ).catch(() => null);
  const recentOffers = offers.slice(0, RECENT_OFFERS_LIMIT);
  const matchedOffer = request.matchedOfferId
    ? (offers.find((offer) => offer.id === request.matchedOfferId) ?? null)
    : null;
  const requestRef = request.requestNumber ?? `#${request.id.slice(-8)}`;
  const categoryName = request.category.name;
  const headerTitle = categoryName ? `${categoryName} Talebi` : 'Talep Detayı';
  const qualityFillPercent = Math.min(100, Math.max(0, request.qualityScore));
  const openReports = reports.filter((report) => report.resolvedAt === null);
  // Both the moderation "Reddet" and a report's "Talebi kaldır" arrive at
  // the same API gate, so one flag governs both forms.
  const canRemove = REMOVABLE_STATUSES.has(request.status);
  // Derived, not stored: the request is down *because of a report* only when
  // it is REJECTED and some report's decision was the removal.
  const canReopen =
    !reportsFailed &&
    request.status === 'REJECTED' &&
    reports.some((report) => report.resolution === 'REQUEST_REMOVED');
  const reportErrorMessage = reportError ? (REPORT_ERROR_MESSAGES[reportError] ?? null) : null;

  return (
    <main className="request-detail-page">
      <p className="breadcrumbs">
        <Link href="/">Dashboard</Link>
        <span aria-hidden="true">/</span>
        <Link href="/requests">Talepler</Link>
        <span aria-hidden="true">/</span>
        <span>Detay</span>
      </p>

      <PageHeader
        title={headerTitle}
        subtitle={
          <span className="request-header-meta">
            <span className={statusBadgeClass(request.status)} data-testid="request-status">
              {requestStatusLabel(request.status)}
            </span>
            <span className={qualityBadgeClass(request.qualityLabel)}>
              {request.qualityScore}/100 · {qualityLabel(request.qualityLabel)}
            </span>
            <span className="muted">· {formatDateTime(request.submittedAt)}</span>
            <span className="muted">· <code>{requestRef}</code></span>
          </span>
        }
        actions={
          <div className="inline-actions">
            <Link className="btn btn-secondary btn-sm" href={`/offers?requestId=${request.id}`}>
              Teklifleri görüntüle
            </Link>
            <form action={recalculateRequestQualityAction} style={{ display: 'inline' }}>
              <input type="hidden" name="id" value={request.id} />
              <button className="btn btn-ghost btn-sm" type="submit">
                Kaliteyi yeniden hesapla
              </button>
            </form>
          </div>
        }
      />

      <div className="request-detail-top-grid">
        <div className="admin-action-panel status-action-panel">
          <div className="panel-head">
            <h3>Durum Yönetimi</h3>
            <span className={statusBadgeClass(request.status)}>
              {requestStatusLabel(request.status)}
            </span>
          </div>
          <p>
            İnceleme geçişleri anında uygulanır. Reddetme için gerekçe zorunludur. Eşleşme,
            tamamlanma ve süre dolumu buradan yazılamaz: süre dolumunu yalnızca zamanlayıcı
            yazar ve onaydan {REQUEST_OPEN_DAYS} gün sonra uygular.
          </p>

          {statusError === 'phoneNotVerified' ? (
            <div className="status-action-error" role="alert" data-testid="status-error">
              <strong>Durum değiştirilmedi.</strong> Telefon doğrulaması zorunlu olduğu için
              doğrulanmamış bir talep onaylanamaz. Müşteri numarasını doğruladıktan sonra tekrar
              deneyin; açık (yayında, incelemede, yeni) bir talep reddedilebilir, iptal her
              durumda mümkündür.
            </div>
          ) : null}
          {statusError === 'notRemovable' ? (
            <div className="status-action-error" role="alert" data-testid="status-error">
              <strong>Durum değiştirilmedi.</strong> Bu talep mevcut durumundan reddedilemez;
              eşleşmiş veya kapanmış talep için &apos;İptal et&apos; kullanın.
            </div>
          ) : null}

          <p className="status-verification-note">
            <strong>Telefon doğrulaması:</strong>{' '}
            {request.phoneVerifiedAt ? (
              <>Doğrulandı · {formatDateTime(request.phoneVerifiedAt)}</>
            ) : (
              <>
                Doğrulanmadı. Telefon doğrulaması zorunlu hale getirildiğinde bu talep onaylanamaz
                ve hizmet verenlere gösterilmez. Reddetme yalnız açık (yayında, incelemede, yeni)
                talep için mümkündür ve aktif teklifleri kapatıp kredileri iade eder; iptal her
                durumda mümkündür.
              </>
            )}
          </p>
          <div className="status-action-list">
            <StatusQuickForm
              requestId={request.id}
              targetStatus="IN_REVIEW"
              currentStatus={request.status}
              label="İncelemeye al"
              variant="secondary"
            />
            <StatusQuickForm
              requestId={request.id}
              targetStatus="APPROVED"
              currentStatus={request.status}
              label="Onayla"
              variant="primary"
            />
          </div>

          <div className="status-action-list">
            <LifecycleForm
              requestId={request.id}
              action={completeRequestAction}
              label="Hizmeti tamamlandı işaretle"
              variant="primary"
              disabled={request.status !== 'MATCHED'}
              hint={
                request.status === 'MATCHED'
                  ? null
                  : 'Yalnız eşleşmiş talep tamamlanabilir.'
              }
            />
            <LifecycleForm
              requestId={request.id}
              action={cancelRequestAction}
              label="İptal et"
              variant="ghost"
              disabled={isTerminalStatus(request.status)}
              hint={isTerminalStatus(request.status) ? 'Talep kapanmış durumda.' : null}
            />
          </div>

          <details
            className="status-reject-block"
            open={request.status === 'REJECTED'}
          >
            <summary>
              Reddet
              {request.status === 'REJECTED' ? (
                <span className="status-current-tag">Mevcut durum</span>
              ) : null}
            </summary>
            <p className="status-reject-note">
              Reddetme yalnız açık (yayında, incelemede, yeni) talep için mümkündür; aktif
              teklifleri kapatır ve harcanan kredileri iade eder.
            </p>
            <form action={updateRequestStatusAction} className="status-reject-form">
              <input type="hidden" name="id" value={request.id} />
              <input type="hidden" name="status" value="REJECTED" />
              <label className="status-reject-field">
                <span>Ret gerekçesi (zorunlu)</span>
                <textarea
                  name="rejectionReason"
                  required
                  defaultValue={request.rejectionReason ?? ''}
                  placeholder="Müşteriye gösterilecek gerekçe"
                  disabled={!canRemove}
                />
              </label>
              <label className="status-reject-field">
                <span>Moderasyon notu (opsiyonel)</span>
                <textarea
                  name="moderationNote"
                  defaultValue={request.moderationNote ?? ''}
                  placeholder="Yalnızca admin görür"
                  disabled={!canRemove}
                />
              </label>
              <button
                className="btn btn-danger btn-sm"
                type="submit"
                disabled={!canRemove}
                aria-disabled={!canRemove}
                data-testid="status-reject"
              >
                {request.status === 'REJECTED' ? 'Talep zaten reddedildi' : 'Talebi reddet'}
              </button>
              {canRemove ? null : (
                <p className="status-reject-note" role="note" data-testid="status-reject-hint">
                  {request.status === 'REJECTED'
                    ? 'Talep zaten reddedilmiş; yayında değil.'
                    : "Eşleşmiş veya kapanmış talep için 'İptal et' kullanın."}
                </p>
              )}
            </form>
          </details>
        </div>

        <div className="admin-action-panel request-offers-panel">
          <div className="panel-head">
            <h3>Eşleşme</h3>
            <span className={statusBadgeClass(request.status)}>
              {requestStatusLabel(request.status)}
            </span>
          </div>
          {request.matchedOfferId ? (
            <dl className="panel-dl">
              <div>
                <dt>Seçilen teklif</dt>
                <dd>
                  <Link href={`/offers/${request.matchedOfferId}`}>
                    {matchedOffer
                      ? matchedOffer.provider.businessName
                      : `#${request.matchedOfferId.slice(-8)}`}
                  </Link>
                </dd>
              </div>
              <div>
                <dt>Teklif kimliği</dt>
                <dd>
                  <code>{request.matchedOfferId}</code>
                </dd>
              </div>
              <div>
                <dt>Eşleşme zamanı</dt>
                <dd>{formatDateTime(request.matchedAt)}</dd>
              </div>
              {request.completedAt ? (
                <div>
                  <dt>Tamamlanma</dt>
                  <dd>{formatDateTime(request.completedAt)}</dd>
                </div>
              ) : null}
              {request.cancelledAt ? (
                <div>
                  <dt>İptal</dt>
                  <dd>{formatDateTime(request.cancelledAt)}</dd>
                </div>
              ) : null}
              {/*
                Read-only audit. There is no action here on purpose: the reveal
                is written once inside the accept transaction, and nothing in
                the product may repeat, edit or undo it.
              */}
              <div data-testid="contact-reveal-audit">
                <dt>İletişim paylaşımı</dt>
                <dd>
                  {contactReveal?.event ? (
                    <>
                      {formatDateTime(contactReveal.event.revealedAt)}
                      <span className="muted">
                        {' '}
                        · metin sürümü <code>{contactReveal.event.disclosureVersion}</code>
                      </span>
                      {contactReveal.event.offerId !== request.matchedOfferId ? (
                        <span className="badge badge-bad" style={{ marginLeft: 6 }}>
                          Eşleşme ile tutarsız
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="muted">Kayıt yok</span>
                  )}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="request-offers-empty">Bu talep henüz bir teklifle eşleşmedi.</p>
          )}
        </div>

        <div className="admin-action-panel request-offers-panel">
          <div className="panel-head">
            <h3>İlgili Teklifler</h3>
            <span className="request-offers-count">Toplam {offers.length}</span>
          </div>
          {offers.length === 0 ? (
            <p className="request-offers-empty">Bu talebe henüz teklif verilmemiş.</p>
          ) : (
            <ul className="offer-mini-list">
              {recentOffers.map((offer) => {
                const offerRef = offer.offerNumber ?? `#${offer.id.slice(-8)}`;
                return (
                <li className="offer-mini-row" key={offer.id}>
                  <div className="offer-mini-main">
                    <Link className="offer-mini-title" href={`/offers/${offer.id}`}>
                      {offer.provider.businessName}
                    </Link>
                    <span className="offer-mini-meta">
                      <code>{offerRef}</code> · {formatDateTime(offer.submittedAt)} ·{' '}
                      {offer.provider.city}/{offer.provider.district}
                    </span>
                  </div>
                  <div className="offer-mini-side">
                    <strong>{formatPrice(offer.priceAmount, offer.currency)}</strong>
                    <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
                  </div>
                </li>
                );
              })}
              {offers.length > RECENT_OFFERS_LIMIT ? (
                <li className="offer-mini-more">
                  <Link href={`/offers?requestId=${request.id}`}>
                    + {offers.length - RECENT_OFFERS_LIMIT} teklif daha
                  </Link>
                </li>
              ) : null}
            </ul>
          )}
          <div className="panel-row request-offers-actions">
            <Link className="btn btn-secondary btn-sm" href={`/offers?requestId=${request.id}`}>
              Tüm teklifleri görüntüle
            </Link>
          </div>
        </div>

        <div className="admin-action-panel request-meta-panel">
          <div className="panel-head">
            <h3>Kalite &amp; Hızlı Bilgiler</h3>
            <span className={qualityBadgeClass(request.qualityLabel)}>
              {qualityLabel(request.qualityLabel)}
            </span>
          </div>
          <div className="quality-mini">
            <div className="quality-mini-score">
              <strong>{request.qualityScore}</strong>
              <span>/100</span>
            </div>
            <div className="request-quality-bar" role="presentation">
              <span
                className={`request-quality-bar-fill request-quality-bar-fill-${request.qualityLabel.toLowerCase()}`}
                style={{ width: `${qualityFillPercent}%` }}
              />
            </div>
          </div>
          <dl className="request-quickfacts">
            <div>
              <dt>Talep No</dt>
              <dd>
                <code>{requestRef}</code>
                {request.requestNumber ? (
                  <details className="muted" style={{ marginTop: 4, fontSize: 11 }}>
                    <summary>Teknik ID</summary>
                    <code style={{ fontSize: 11 }}>{request.id}</code>
                  </details>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Kategori</dt>
              <dd>
                {categoryName}
                {request.category.slug ? (
                  <span className="cell-muted"> · {request.category.slug}</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Oluşturuldu</dt>
              <dd>{formatDateTime(request.createdAt)}</dd>
            </div>
            <div>
              <dt>Güncellendi</dt>
              <dd>{formatDateTime(request.updatedAt)}</dd>
            </div>
            <div>
              <dt>Teklif sayısı</dt>
              <dd>{offers.length}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="request-detail-card-grid">
        <SectionCard
          className="card-wide"
          title="Talep Özeti"
          subtitle="Kategori, zaman ve moderasyon bilgileri."
        >
          <dl className="info-grid info-grid-4">
            <div>
              <dt>Kategori</dt>
              <dd>{categoryName}</dd>
            </div>
            <div>
              <dt>Durum</dt>
              <dd>
                <span className={statusBadgeClass(request.status)}>
                  {requestStatusLabel(request.status)}
                </span>
              </dd>
            </div>
            <div>
              <dt>Gönderim</dt>
              <dd>{formatDateTime(request.submittedAt)}</dd>
            </div>
            <div>
              <dt>Moderasyon</dt>
              <dd>{request.moderatedAt ? formatDateTime(request.moderatedAt) : <span className="cell-muted">—</span>}</dd>
            </div>
            <div>
              <dt>Onay</dt>
              <dd>
                {request.approvedAt ? (
                  formatDateTime(request.approvedAt)
                ) : request.status === 'APPROVED' ? (
                  <span className="cell-muted">Kayıtlı değil</span>
                ) : (
                  <span className="cell-muted">—</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Süre bitişi</dt>
              <dd>
                {request.expiredAt ? (
                  formatDateTime(request.expiredAt)
                ) : plannedExpiry(request) ? (
                  <span className="cell-muted">{formatDateTime(plannedExpiry(request))} (planlanan)</span>
                ) : (
                  <span className="cell-muted">—</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Hatırlatma</dt>
              <dd>
                {request.reminderSentAt ? (
                  formatDateTime(request.reminderSentAt)
                ) : (
                  <span className="cell-muted">Gönderilmedi</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Aciliyet</dt>
              <dd>{urgencyLabel(request.urgency)}</dd>
            </div>
            <div>
              <dt>Tercih tarihi</dt>
              <dd>{request.preferredDate ? formatDate(request.preferredDate) : <span className="cell-muted">—</span>}</dd>
            </div>
            <div>
              <dt>Bütçe</dt>
              <dd>{formatBudgetRange(request.budgetMin, request.budgetMax)}</dd>
            </div>
            <div>
              <dt>Kalite skoru</dt>
              <dd>{request.qualityScore}/100 · {qualityLabel(request.qualityLabel)}</dd>
            </div>
            <div className="info-grid-full">
              <dt>Açıklama</dt>
              <dd>
                {request.description ? (
                  <p className="request-description">{request.description}</p>
                ) : (
                  <span className="cell-muted">Açıklama girilmemiş.</span>
                )}
              </dd>
            </div>
            {request.moderationNote ? (
              <div className="info-grid-full">
                <dt>Moderasyon notu</dt>
                <dd>
                  <p className="request-description">{request.moderationNote}</p>
                </dd>
              </div>
            ) : null}
            {request.rejectionReason ? (
              <div className="info-grid-full">
                <dt>Ret gerekçesi</dt>
                <dd>
                  <p className="request-description">{request.rejectionReason}</p>
                </dd>
              </div>
            ) : null}
          </dl>
        </SectionCard>

        <SectionCard
          className="card-wide"
          id="bildirimler"
          title="Bildirimler"
          subtitle="Hizmet verenlerin bu talep hakkındaki bildirimleri ve verilen kararlar. Bildiren ve notu yalnız yönetici görür."
        >
          {reportErrorMessage ? (
            <div className="status-action-error" role="alert" data-testid="report-error">
              {reportErrorMessage}
            </div>
          ) : null}

          {reportsFailed ? (
            <p className="status-action-error" role="alert" data-testid="report-load-error">
              Bildirimler yüklenemedi. Sayfayı yenileyin.
            </p>
          ) : reports.length === 0 ? (
            <EmptyState
              title="Bildirim yok."
              description="Bu talep hakkında hizmet verenlerden bir bildirim gelmedi."
            />
          ) : (
            <ul className="report-list" data-testid="report-list">
              {reports.map((report) => (
                <li
                  className={report.resolvedAt ? 'report-item is-resolved' : 'report-item'}
                  key={report.id}
                  data-testid="report-item"
                >
                  <div className="report-item-head">
                    <span className="badge badge-muted">{reportReasonLabel(report.reason)}</span>
                    <Link className="cell-link" href={`/providers/${report.reporter.id}`}>
                      {report.reporter.businessName}
                    </Link>
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
                            report.resolution === 'REQUEST_REMOVED'
                              ? 'badge badge-bad'
                              : 'badge badge-good'
                          }
                        >
                          {reportResolutionLabel(report.resolution)}
                        </span>
                        <span className="cell-muted">
                          {formatDateTime(report.resolvedAt)}
                          {report.resolvedBy?.name ? ` · ${report.resolvedBy.name}` : ''}
                        </span>
                        {report.resolutionNote ? (
                          <span className="report-item-resolution-note">
                            {report.resolutionNote}
                          </span>
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

          {openReports.length > 0 ? (
            <div className="report-decisions" data-testid="report-decisions">
              <p className="report-decisions-intro">
                {openReports.length} açık bildirim var. Karar tüm açık bildirimleri birlikte
                kapatır.
              </p>

              <form action={resolveReportsAction} className="status-reject-form report-decision-form">
                <input type="hidden" name="id" value={request.id} />
                <input type="hidden" name="resolution" value="DISMISSED" />
                <label className="status-reject-field">
                  <span>Not (opsiyonel, yalnız yönetici görür)</span>
                  <textarea name="resolutionNote" placeholder="Neden uygun bulundu?" />
                </label>
                <button className="btn btn-secondary btn-sm" type="submit" data-testid="report-dismiss">
                  Uygun bulundu
                </button>
              </form>

              {/*
                Open by default: the operator came here from the queue to
                decide, and the required reason select is the guard against a
                careless removal, not the fold. The fold is still there to
                collapse the form once read.
              */}
              <details className="status-reject-block report-remove-block" open>
                <summary data-testid="report-remove-toggle">Talebi kaldır</summary>
                <form action={resolveReportsAction} className="status-reject-form report-decision-form">
                  <input type="hidden" name="id" value={request.id} />
                  <input type="hidden" name="resolution" value="REQUEST_REMOVED" />
                  <fieldset className="report-remove-fieldset" disabled={!canRemove}>
                    <legend>Talebi kaldır</legend>
                    <label className="status-reject-field">
                      <span>Gerekçe (zorunlu; müşteriye gösterilecek metin yanında)</span>
                      <select name="removalReason" required defaultValue="">
                        <option value="" disabled>
                          Gerekçe seçin
                        </option>
                        {REPORT_REASON_KEYS.map((key) => (
                          <option key={key} value={key}>
                            {REPORT_REASON_ADMIN_LABELS[key]} — “{REMOVAL_REASON_CUSTOMER_LABELS[key]}”
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="status-reject-field">
                      <span>Not (opsiyonel, yalnız yönetici görür)</span>
                      <textarea name="resolutionNote" placeholder="Karar gerekçesi" />
                    </label>
                    <p className="report-decision-hint">
                      Kaldırma talebi reddeder, aktif teklifleri kapatır ve harcanan kredileri
                      iade eder. Müşteriye yalnız seçilen gerekçe gösterilir.
                    </p>
                    <button
                      className="btn btn-danger btn-sm"
                      type="submit"
                      disabled={!canRemove}
                      aria-disabled={!canRemove}
                      data-testid="report-remove"
                    >
                      Talebi kaldır
                    </button>
                  </fieldset>
                  {canRemove ? null : (
                    <p className="report-decision-hint" role="note">
                      Bu talep mevcut durumundan kaldırılamaz; eşleşmiş talep için &apos;İptal
                      et&apos; kullanın, kapanmış talep zaten yayında değil.
                    </p>
                  )}
                </form>
              </details>
            </div>
          ) : null}

          {canReopen ? (
            <form action={reopenRequestAction} className="status-reject-form report-decision-form">
              <input type="hidden" name="id" value={request.id} />
              <p className="report-decisions-intro">
                Bu talep bir bildirim sonucu kaldırıldı. Geri açılırsa yeniden onaylı duruma
                geçer ve eşleşen hizmet verenlere gösterilir.
              </p>
              <label className="status-reject-field">
                <span>Moderasyon notu (opsiyonel)</span>
                <textarea name="moderationNote" placeholder="Yalnızca admin görür" />
              </label>
              <p className="report-decision-hint" role="note">
                Kapatılan teklifler geri açılmaz; iadeler geri alınmaz.
              </p>
              <button className="btn btn-primary btn-sm" type="submit" data-testid="report-reopen">
                Talebi geri aç
              </button>
            </form>
          ) : null}
        </SectionCard>

        <SectionCard title="Müşteri" subtitle="İletişim bilgileri ve bağlı hesap.">
          <dl className="info-list">
            <div>
              <dt>Ad soyad</dt>
              <dd>{request.customerName}</dd>
            </div>
            <div>
              <dt>Telefon</dt>
              <dd>
                {request.customerPhone ? (
                  <a className="cell-link" href={`tel:${request.customerPhone}`}>
                    {request.customerPhone}
                  </a>
                ) : (
                  <span className="cell-muted">—</span>
                )}
              </dd>
            </div>
            <div>
              <dt>E-posta</dt>
              <dd>
                {request.customerEmail ? (
                  <a className="cell-link" href={`mailto:${request.customerEmail}`}>
                    {request.customerEmail}
                  </a>
                ) : (
                  <span className="cell-muted">—</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Bağlı hesap</dt>
              <dd>
                {request.customer ? (
                  <span>
                    {request.customer.name ?? request.customer.email ?? request.customer.phone ?? request.customer.id}
                    {request.customer.email ? (
                      <span className="cell-muted"> · {request.customer.email}</span>
                    ) : null}
                  </span>
                ) : (
                  <span className="cell-muted">Bağlı hesap yok</span>
                )}
              </dd>
            </div>
          </dl>
        </SectionCard>

        <SectionCard title="Konum" subtitle="Hizmetin verileceği yer bilgisi.">
          <dl className="info-list">
            <div>
              <dt>İl / ilçe</dt>
              <dd>{request.city}/{request.district}</dd>
            </div>
            <div>
              <dt>Mahalle</dt>
              <dd>{request.neighborhood ?? <span className="cell-muted">—</span>}</dd>
            </div>
            <div>
              <dt>Adres notu</dt>
              <dd>
                {request.addressNote ? (
                  <p className="request-description">{request.addressNote}</p>
                ) : (
                  <span className="cell-muted">Adres notu yok.</span>
                )}
              </dd>
            </div>
          </dl>
        </SectionCard>

        <SectionCard
          className="card-wide"
          title="Kalite Kırılımı"
          subtitle="Skorun hangi bileşenlerden geldiğini gösterir."
        >
          <div className="quality-summary">
            <div className="quality-summary-head">
              <span className={qualityBadgeClass(request.qualityLabel)}>
                {request.qualityScore}/100 · {qualityLabel(request.qualityLabel)}
              </span>
              <div className="request-quality-bar" role="presentation">
                <span
                  className={`request-quality-bar-fill request-quality-bar-fill-${request.qualityLabel.toLowerCase()}`}
                  style={{ width: `${qualityFillPercent}%` }}
                />
              </div>
            </div>
            {request.qualityScoreBreakdown ? (
              <div className="quality-breakdown-grid">
                {Object.entries(request.qualityScoreBreakdown).map(([key, component]) => (
                  <QualityBreakdownItem key={key} keyName={key} component={component} />
                ))}
              </div>
            ) : (
              <p className="cell-muted">Kalite kırılımı henüz hesaplanmadı.</p>
            )}
          </div>
        </SectionCard>

        <SectionCard
          className="card-wide"
          title="Dinamik Yanıtlar"
          subtitle="Müşterinin kategori sorularına verdiği yanıtlar."
        >
          {(request.answers ?? []).length === 0 ? (
            <EmptyState
              title="Dinamik yanıt yok."
              description="Bu kategoride zorunlu soru bulunmuyor ya da müşteri opsiyonel soruları yanıtlamamış."
            />
          ) : (
            <div className="answer-card-grid">
              {(request.answers ?? []).map((answer) => (
                <div className="answer-card" key={answer.id}>
                  <div className="answer-card-head">
                    <span className="answer-card-label">{answer.questionLabel}</span>
                    <span className="answer-card-meta">
                      <code>{answer.questionKey}</code>
                      <span>·</span>
                      <span>{answer.questionType}</span>
                    </span>
                  </div>
                  <div className="answer-card-value">{formatAnswer(answer.value)}</div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Değerlendirme"
          subtitle="Müşterinin, kabul ettiği teklifin hizmet vereni hakkındaki değerlendirmesi."
        >
          {reviewState?.review ? (
            <dl className="info-grid" data-testid="request-review">
              <div>
                <dt>Puan</dt>
                <dd>
                  <span className="badge badge-muted" aria-label={`5 üzerinden ${reviewState.review.rating}`}>
                    ★ {reviewState.review.rating}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Durum</dt>
                <dd>
                  <span
                    className={reviewStateBadgeClass({
                      removed: reviewState.review.removed,
                      commentRemoved: reviewState.review.commentRemoved,
                    })}
                  >
                    {reviewStateLabel({
                      removed: reviewState.review.removed,
                      commentRemoved: reviewState.review.commentRemoved,
                    })}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Hizmet veren</dt>
                <dd>
                  {reviewState.provider ? (
                    <Link className="cell-link" href={`/providers/${reviewState.provider.id}`}>
                      {reviewState.provider.businessName}
                    </Link>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div>
                <dt>Tarih</dt>
                <dd>{formatDateTime(reviewState.review.createdAt)}</dd>
              </div>
              <div className="info-grid-full">
                <dt>Detay</dt>
                <dd>
                  <Link className="btn btn-ghost btn-sm" href={`/provider-reviews/${reviewState.review.id}`}>
                    Değerlendirmeyi aç
                  </Link>
                </dd>
              </div>
            </dl>
          ) : (
            <p className="cell-muted" style={{ margin: 0 }} data-testid="request-review-none">
              {reviewState?.eligibility === 'disabled'
                ? 'Değerlendirme özelliği kapalı.'
                : 'Değerlendirme yok.'}
            </p>
          )}
        </SectionCard>
      </div>
    </main>
  );
}

function QualityBreakdownItem({
  keyName,
  component,
}: {
  keyName: string;
  component: QualityScoreBreakdown[string];
}) {
  return (
    <div className={`quality-breakdown-item ${component.passed ? 'is-passed' : 'is-missing'}`}>
      <div className="quality-breakdown-item-head">
        <span className="quality-breakdown-item-label">{qualityBreakdownLabel(keyName)}</span>
        <span className="quality-breakdown-item-score">
          {component.points}/{component.max}
        </span>
      </div>
      <span className={component.passed ? 'badge badge-good' : 'badge badge-muted'}>
        {component.passed ? 'Tamam' : 'Eksik'}
      </span>
    </div>
  );
}

function isTerminalStatus(status: string) {
  return (
    status === 'COMPLETED' ||
    status === 'CANCELLED' ||
    status === 'EXPIRED' ||
    status === 'REJECTED'
  );
}

type LifecycleFormProps = {
  requestId: string;
  action: (formData: FormData) => Promise<void>;
  label: string;
  variant: 'primary' | 'secondary' | 'ghost';
  disabled: boolean;
  hint: string | null;
};

function LifecycleForm({ requestId, action, label, variant, disabled, hint }: LifecycleFormProps) {
  return (
    <form action={action} className="status-quick-form">
      <input type="hidden" name="id" value={requestId} />
      <button
        className={`btn btn-${variant} btn-sm status-action-btn`}
        type="submit"
        disabled={disabled}
        aria-disabled={disabled}
        title={hint ?? undefined}
      >
        <span className="status-action-label">{label}</span>
      </button>
    </form>
  );
}

type StatusQuickFormProps = {
  requestId: string;
  targetStatus: 'IN_REVIEW' | 'APPROVED';
  currentStatus: string;
  label: string;
  variant: 'primary' | 'secondary' | 'ghost';
};

function StatusQuickForm({
  requestId,
  targetStatus,
  currentStatus,
  label,
  variant,
}: StatusQuickFormProps) {
  const isCurrent = currentStatus === targetStatus;
  const buttonClass = isCurrent
    ? 'btn btn-sm status-action-btn is-current'
    : `btn btn-${variant} btn-sm status-action-btn`;
  return (
    <form action={updateRequestStatusAction} className="status-quick-form">
      <input type="hidden" name="id" value={requestId} />
      <input type="hidden" name="status" value={targetStatus} />
      <button
        className={buttonClass}
        type="submit"
        disabled={isCurrent}
        aria-disabled={isCurrent}
      >
        <span className="status-action-label">{label}</span>
        {isCurrent ? <span className="status-current-tag">Mevcut</span> : null}
      </button>
    </form>
  );
}

function formatAnswer(value: unknown) {
  if (value === null || value === undefined) return '-';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  return String(value);
}
