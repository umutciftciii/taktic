import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  getCurrentUser,
  ProviderRequestDetail,
  RequestQualityBreakdownComponent,
  formatPrice,
  formatDate,
  formatDateTime,
  qualityLabel,
  statusLabel,
  urgencyLabel,
  refundActionLabel,
} from '../../../../../lib/api';
import { ProviderShell } from '../../../provider-shell';
import {
  providerQualityBadgeClass,
  providerStatusBadgeClass,
  providerRefundBadgeClass,
  formatBudgetRange,
} from '../../../provider-ui';
import { createOfferAction } from './actions';

type ProviderRequestDetailPageProps = {
  params: Promise<{ id: string; requestId: string }>;
};

export default async function ProviderRequestDetailPage({ params }: ProviderRequestDetailPageProps) {
  const { id, requestId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/requests/${requestId}`);
  }

  const request = await apiFetch<ProviderRequestDetail>(`/providers/${id}/requests/${requestId}`);
  const creditBalance = request.providerCreditBalance ?? 0;

  return (
    <ProviderShell user={user} providerId={id} active="requests">
      <p className="pdash-crumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/requests`}>Uygun Talepler</Link>
        <span aria-hidden="true">/</span>
        <span>{request.category.name}</span>
      </p>

      <header className="pdash-page-head">
        <h1 className="pdash-page-title">{request.category.name}</h1>
        <p className="pdash-page-sub">
          <span className={providerQualityBadgeClass(request.qualityLabel)}>
            {qualityLabel(request.qualityLabel)} · {request.qualityScore}/100
          </span>
          <span style={{ marginLeft: 8 }}>· {formatDateTime(request.submittedAt)}</span>
        </p>
      </header>

      <div className="pdash-detail-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="pdash-detail-card">
            <h2>Talep Özeti</h2>
            <dl className="pdash-info-grid">
              <div className="pdash-info-row">
                <dt>Konum</dt>
                <dd>
                  {request.city}/{request.district}
                  {request.neighborhood ? `/${request.neighborhood}` : ''}
                </dd>
              </div>
              {request.addressNote ? (
                <div className="pdash-info-row">
                  <dt>Adres notu</dt>
                  <dd>{request.addressNote}</dd>
                </div>
              ) : null}
              <div className="pdash-info-row">
                <dt>Bütçe</dt>
                <dd>{formatBudgetRange(request.budgetMin, request.budgetMax, (n) => formatPrice(n))}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Tercih edilen tarih</dt>
                <dd>{request.preferredDate ? formatDate(request.preferredDate) : '-'}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Aciliyet</dt>
                <dd>{urgencyLabel(request.urgency)}</dd>
              </div>
              {request.description ? (
                <div className="pdash-info-row">
                  <dt>Açıklama</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>{request.description}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          {request.answers.length > 0 ? (
            <section className="pdash-table-card">
              <div className="pdash-table-head">
                <h2>Dinamik Yanıtlar</h2>
              </div>
              <div className="pdash-table-scroll">
                <table className="pdash-table">
                  <thead>
                    <tr>
                      <th>Soru</th>
                      <th>Yanıt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {request.answers.map((answer) => (
                      <tr key={answer.id}>
                        <td>{answer.questionLabel}</td>
                        <td>{formatValue(answer.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="pdash-table-card">
            <div className="pdash-table-head">
              <h2>Kalite Kırılımı</h2>
            </div>
            <div className="pdash-table-scroll">
              <table className="pdash-table">
                <thead>
                  <tr>
                    <th>Bileşen</th>
                    <th>Puan</th>
                    <th>Maks.</th>
                    <th>Geçti</th>
                  </tr>
                </thead>
                <tbody>{renderBreakdownRows(request.qualityScoreBreakdown)}</tbody>
              </table>
            </div>
          </section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="pdash-detail-card">
            <h2>Teklif Ver</h2>
            <p className="pdash-card-sub" style={{ marginTop: -4 }}>
              Mevcut kredi: <strong>{creditBalance}</strong> · Bu teklif 1 kredi kullanır.
            </p>

            {request.existingOffer ? (
              <>
                <div className="pdash-card" style={{ padding: 14 }}>
                  <div className="pdash-card-head">
                    <strong>{formatPrice(request.existingOffer.priceAmount)}</strong>
                    <span className={providerStatusBadgeClass(request.existingOffer.status)}>
                      {statusLabel(request.existingOffer.status)}
                    </span>
                  </div>
                  <p className="pdash-card-sub">
                    Gönderim: {formatDateTime(request.existingOffer.submittedAt)} · Kullanılan kredi:{' '}
                    {request.existingOffer.creditCost}
                  </p>
                  <p style={{ margin: 0, fontSize: 13 }}>
                    Kredi iadesi:{' '}
                    {request.existingOffer.creditRefundedAt
                      ? `${formatDateTime(request.existingOffer.creditRefundedAt)} — ${
                          request.existingOffer.creditRefundReason ?? '-'
                        }`
                      : 'Yok'}
                  </p>
                  <p style={{ margin: 0, fontSize: 13 }}>
                    İade politikası:{' '}
                    <span
                      className={providerRefundBadgeClass(
                        request.existingOffer.refundEligibility.recommendedAction,
                      )}
                    >
                      {refundActionLabel(request.existingOffer.refundEligibility.recommendedAction)}
                    </span>
                  </p>
                </div>
                <div className="pdash-notice">
                  Bu talebe daha önce teklif gönderdiniz. Aynı talebe yeniden teklif verilemez.
                </div>
                <div className="pdash-actions">
                  <Link
                    className="pdash-btn pdash-btn-primary"
                    href={`/providers/${id}/offers/${request.existingOffer.id}`}
                  >
                    Teklif Detayını Gör
                  </Link>
                  <Link className="pdash-btn pdash-btn-secondary" href={`/providers/${id}/offers`}>
                    Tekliflerime Git
                  </Link>
                </div>
              </>
            ) : (
              <form action={createOfferAction} className="pdash-form">
                <input type="hidden" name="providerId" value={id} />
                <input type="hidden" name="requestId" value={requestId} />
                <div className="pdash-form-grid">
                  <label className="pdash-form-row">
                    <span>Fiyat *</span>
                    <input name="priceAmount" type="number" min="1" required />
                  </label>
                  <label className="pdash-form-row">
                    <span>Para birimi</span>
                    <input name="currency" defaultValue="TRY" />
                  </label>
                  <label className="pdash-form-row">
                    <span>Tahmini başlangıç</span>
                    <input name="estimatedStartDate" type="date" />
                  </label>
                  <label className="pdash-form-row">
                    <span>Tahmini bitiş</span>
                    <input name="estimatedCompletionDate" type="date" />
                  </label>
                </div>
                <label className="pdash-form-row">
                  <span>Mesaj *</span>
                  <textarea name="message" required placeholder="Müşteriye iletmek istediğiniz açıklama" />
                </label>
                <label className="pdash-form-row">
                  <span>Garanti notu</span>
                  <textarea name="warrantyNote" />
                </label>
                <label className="pdash-form-row">
                  <span>İç not</span>
                  <textarea name="internalNote" placeholder="Müşteri görmez, sadece sizin notunuz" />
                </label>
                {creditBalance < 1 ? (
                  <div className="pdash-notice pdash-notice-warn">
                    Teklif göndermek için en az 1 kredi gerekir.
                  </div>
                ) : null}
                <div>
                  <button
                    className="pdash-btn pdash-btn-primary pdash-btn-block"
                    type="submit"
                    disabled={creditBalance < 1}
                  >
                    Teklifi Gönder
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      </div>
    </ProviderShell>
  );
}

function renderBreakdownRows(breakdown: Record<string, RequestQualityBreakdownComponent> | null) {
  if (!breakdown) {
    return (
      <tr>
        <td colSpan={4} style={{ color: 'var(--muted)' }}>
          Kırılım kaydı yok.
        </td>
      </tr>
    );
  }

  return Object.entries(breakdown).map(([key, component]) => (
    <tr key={key}>
      <td>{key}</td>
      <td>{component.points}</td>
      <td>{component.max}</td>
      <td>
        <span
          className={
            component.passed
              ? 'pdash-badge pdash-badge-success'
              : 'pdash-badge pdash-badge-muted'
          }
        >
          {component.passed ? 'Evet' : 'Hayır'}
        </span>
      </td>
    </tr>
  ));
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.join(', ');
  }

  if (typeof value === 'boolean') {
    return value ? 'Evet' : 'Hayır';
  }

  if (value === null || value === undefined) {
    return '-';
  }

  return String(value);
}
