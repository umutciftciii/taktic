import Link from 'next/link';
import {
  apiFetch,
  ProviderRequestDetail,
  RequestQualityBreakdownComponent,
  formatPrice,
  formatDate,
  formatDateTime,
  qualityLabel,
  qualityBadgeClass,
  statusLabel,
  statusBadgeClass,
  urgencyLabel,
  refundActionLabel,
  refundActionBadgeClass,
} from '../../../../../lib/api';
import { createOfferAction } from './actions';

type ProviderRequestDetailPageProps = {
  params: Promise<{ id: string; requestId: string }>;
};

export default async function ProviderRequestDetailPage({ params }: ProviderRequestDetailPageProps) {
  const { id, requestId } = await params;
  const request = await apiFetch<ProviderRequestDetail>(`/providers/${id}/requests/${requestId}`);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/requests`}>Eşleşen talepler</Link>
        <span aria-hidden="true">/</span>
        <span>{request.category.name}</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">{request.category.name}</h1>
        <p className="page-subtitle">
          <span className={qualityBadgeClass(request.qualityLabel)}>
            Kalite {request.qualityScore}/100 · {qualityLabel(request.qualityLabel)}
          </span>{' '}
          <span className="muted">{formatDateTime(request.submittedAt)}</span>
        </p>
      </header>

      <div className="detail-grid">
        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Talep Özeti</h2>
            <dl className="meta-row">
              <dt>Konum</dt>
              <dd>{request.city}/{request.district}{request.neighborhood ? `/${request.neighborhood}` : ''}</dd>
              <dt>Adres notu</dt>
              <dd>{request.addressNote ?? '-'}</dd>
              <dt>Bütçe</dt>
              <dd>{formatBudget(request.budgetMin, request.budgetMax)}</dd>
              <dt>Tercih edilen tarih</dt>
              <dd>{request.preferredDate ? formatDate(request.preferredDate) : '-'}</dd>
              <dt>Aciliyet</dt>
              <dd>{urgencyLabel(request.urgency)}</dd>
              <dt>Açıklama</dt>
              <dd>{request.description ?? '-'}</dd>
            </dl>
          </section>

          {request.answers.length > 0 ? (
            <section className="table-card">
              <div className="table-header">
                <h2>Dinamik Yanıtlar</h2>
              </div>
              <div className="table-scroll">
                <table className="data-table">
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

          <section className="table-card">
            <div className="table-header">
              <h2>Kalite Kırılımı</h2>
            </div>
            <div className="table-scroll">
              <table className="data-table">
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

        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Teklif Ver</h2>
            <p className="muted" style={{ marginTop: -4 }}>
              Mevcut kredi: <strong>{request.providerCreditBalance ?? 0}</strong> · Bu teklif 1 kredi kullanır.
            </p>

            {request.existingOffer ? (
              <div className="list-card" style={{ padding: 14, marginTop: 8 }}>
                <div className="list-card-header">
                  <strong>{formatPrice(request.existingOffer.priceAmount)}</strong>
                  <span className={statusBadgeClass(request.existingOffer.status)}>
                    {statusLabel(request.existingOffer.status)}
                  </span>
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
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
                    className={refundActionBadgeClass(request.existingOffer.refundEligibility.recommendedAction)}
                  >
                    {refundActionLabel(request.existingOffer.refundEligibility.recommendedAction)}
                  </span>
                </p>
              </div>
            ) : (
              <form action={createOfferAction} className="form-card" style={{ maxWidth: 'none' }}>
                <input type="hidden" name="providerId" value={id} />
                <input type="hidden" name="requestId" value={requestId} />
                <div className="form-grid">
                  <label className="form-row">
                    <span>Fiyat *</span>
                    <input name="priceAmount" type="number" min="1" required />
                  </label>
                  <label className="form-row">
                    <span>Para birimi</span>
                    <input name="currency" defaultValue="TRY" />
                  </label>
                  <label className="form-row">
                    <span>Tahmini başlangıç</span>
                    <input name="estimatedStartDate" type="date" />
                  </label>
                  <label className="form-row">
                    <span>Tahmini bitiş</span>
                    <input name="estimatedCompletionDate" type="date" />
                  </label>
                </div>
                <label className="form-row">
                  <span>Mesaj *</span>
                  <textarea name="message" required placeholder="Müşteriye iletmek istediğiniz açıklama" />
                </label>
                <label className="form-row">
                  <span>Garanti notu</span>
                  <textarea name="warrantyNote" />
                </label>
                <label className="form-row">
                  <span>İç not</span>
                  <textarea name="internalNote" placeholder="Müşteri görmez, sadece sizin notunuz" />
                </label>
                {(request.providerCreditBalance ?? 0) < 1 ? (
                  <div className="notice-warning">Teklif göndermek için en az 1 kredi gerekir.</div>
                ) : null}
                <div>
                  <button
                    className="btn btn-primary btn-block"
                    type="submit"
                    disabled={(request.providerCreditBalance ?? 0) < 1}
                  >
                    Teklifi Gönder
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function renderBreakdownRows(breakdown: Record<string, RequestQualityBreakdownComponent> | null) {
  if (!breakdown) {
    return (
      <tr>
        <td colSpan={4} className="muted">Kırılım kaydı yok.</td>
      </tr>
    );
  }

  return Object.entries(breakdown).map(([key, component]) => (
    <tr key={key}>
      <td>{key}</td>
      <td>{component.points}</td>
      <td>{component.max}</td>
      <td>
        <span className={component.passed ? 'badge badge-good' : 'badge badge-muted'}>
          {component.passed ? 'Evet' : 'Hayır'}
        </span>
      </td>
    </tr>
  ));
}

function formatBudget(min: number | null, max: number | null) {
  if (min !== null && max !== null) {
    return `${formatPrice(min)} - ${formatPrice(max)}`;
  }
  if (min !== null) return `${formatPrice(min)}+`;
  if (max !== null) return `≤ ${formatPrice(max)}`;
  return '-';
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
