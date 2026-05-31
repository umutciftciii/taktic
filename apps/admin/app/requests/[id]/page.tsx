import Link from 'next/link';
import {
  apiFetch,
  Offer,
  QualityScoreBreakdown,
  ServiceRequest,
  formatBudgetRange,
  formatDate,
  formatDateTime,
  formatPrice,
  qualityBadgeClass,
  qualityBreakdownLabel,
  qualityLabel,
  requestStatusLabel,
  statusBadgeClass,
  statusLabel,
  urgencyLabel,
} from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { EmptyState } from '../../../components/empty-state';
import { recalculateRequestQualityAction, updateRequestStatusAction } from '../actions';

type RequestDetailPageProps = {
  params: Promise<{ id: string }>;
};

const RECENT_OFFERS_LIMIT = 3;

export default async function RequestDetailPage({ params }: RequestDetailPageProps) {
  const { id } = await params;
  const request = await apiFetch<ServiceRequest>(`/service-requests/${id}`);
  const offers = await apiFetch<Offer[]>(`/offers?requestId=${id}`).catch(() => [] as Offer[]);
  const recentOffers = offers.slice(0, RECENT_OFFERS_LIMIT);
  const shortId = request.id.slice(-8);
  const categoryName = request.category.name;
  const headerTitle = categoryName ? `${categoryName} Talebi` : 'Talep Detayı';
  const qualityFillPercent = Math.min(100, Math.max(0, request.qualityScore));

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
            <span className={statusBadgeClass(request.status)}>{requestStatusLabel(request.status)}</span>
            <span className={qualityBadgeClass(request.qualityLabel)}>
              {request.qualityScore}/100 · {qualityLabel(request.qualityLabel)}
            </span>
            <span className="muted">· {formatDateTime(request.submittedAt)}</span>
            <span className="muted">· #{shortId}</span>
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
          <p>Durum geçişleri anında uygulanır. Reddetme için gerekçe zorunludur.</p>
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
            <StatusQuickForm
              requestId={request.id}
              targetStatus="CANCELLED"
              currentStatus={request.status}
              label="İptal et"
              variant="ghost"
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
                  disabled={request.status === 'REJECTED'}
                />
              </label>
              <label className="status-reject-field">
                <span>Moderasyon notu (opsiyonel)</span>
                <textarea
                  name="moderationNote"
                  defaultValue={request.moderationNote ?? ''}
                  placeholder="Yalnızca admin görür"
                  disabled={request.status === 'REJECTED'}
                />
              </label>
              <button
                className="btn btn-danger btn-sm"
                type="submit"
                disabled={request.status === 'REJECTED'}
              >
                {request.status === 'REJECTED' ? 'Talep zaten reddedildi' : 'Talebi reddet'}
              </button>
            </form>
          </details>
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
              {recentOffers.map((offer) => (
                <li className="offer-mini-row" key={offer.id}>
                  <div className="offer-mini-main">
                    <Link className="offer-mini-title" href={`/offers/${offer.id}`}>
                      {offer.provider.businessName}
                    </Link>
                    <span className="offer-mini-meta">
                      {formatDateTime(offer.submittedAt)} · {offer.provider.city}/{offer.provider.district}
                    </span>
                  </div>
                  <div className="offer-mini-side">
                    <strong>{formatPrice(offer.priceAmount, offer.currency)}</strong>
                    <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
                  </div>
                </li>
              ))}
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
              <dt>Talep ID</dt>
              <dd><code>{request.id}</code></dd>
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

type StatusQuickFormProps = {
  requestId: string;
  targetStatus: 'IN_REVIEW' | 'APPROVED' | 'CANCELLED';
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
