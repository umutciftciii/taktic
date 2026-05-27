import Link from 'next/link';
import {
  apiFetch,
  QualityScoreBreakdown,
  ServiceRequest,
  ServiceRequestStatus,
  statusLabel,
  statusBadgeClass,
  qualityLabel,
  qualityBadgeClass,
  urgencyLabel,
  formatDate,
  formatDateTime,
  formatPrice,
} from '../../../lib/api';
import { recalculateRequestQualityAction, updateRequestStatusAction } from '../actions';

const statuses: ServiceRequestStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
];

type RequestDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function RequestDetailPage({ params }: RequestDetailPageProps) {
  const { id } = await params;
  const request = await apiFetch<ServiceRequest>(`/service-requests/${id}`);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/">Dashboard</Link>
        <span aria-hidden="true">/</span>
        <Link href="/requests">Talepler</Link>
        <span aria-hidden="true">/</span>
        <span>Detay</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">{request.category.name}</h1>
        <p className="page-subtitle">
          <span className={statusBadgeClass(request.status)}>{statusLabel(request.status)}</span>{' '}
          <span className={qualityBadgeClass(request.qualityLabel)}>
            Kalite {request.qualityScore}/100 · {qualityLabel(request.qualityLabel)}
          </span>{' '}
          <span className="muted">· {formatDateTime(request.submittedAt)}</span>
        </p>
      </header>

      <div className="inline-actions" style={{ marginBottom: 18 }}>
        <Link className="btn btn-secondary btn-sm" href={`/offers?requestId=${request.id}`}>
          Teklifleri görüntüle
        </Link>
      </div>

      <div className="detail-grid">
        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Özet</h2>
            <dl className="meta-row">
              <dt>Talep ID</dt>
              <dd><code style={{ fontSize: 12 }}>{request.id}</code></dd>
              <dt>Kategori</dt>
              <dd>{request.category.name}</dd>
              <dt>Gönderim</dt>
              <dd>{formatDateTime(request.submittedAt)}</dd>
              <dt>Moderasyon</dt>
              <dd>{request.moderatedAt ? formatDateTime(request.moderatedAt) : '-'}</dd>
              <dt>Moderasyon notu</dt>
              <dd className="muted">{request.moderationNote ?? '-'}</dd>
              <dt>Ret gerekçesi</dt>
              <dd className="muted">{request.rejectionReason ?? '-'}</dd>
            </dl>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Müşteri</h2>
            <dl className="meta-row">
              <dt>Ad soyad</dt>
              <dd>{request.customerName}</dd>
              <dt>Telefon</dt>
              <dd>{request.customerPhone}</dd>
              <dt>E-posta</dt>
              <dd>{request.customerEmail ?? '-'}</dd>
              <dt>Bağlı hesap</dt>
              <dd>{request.customer?.email ?? '-'}</dd>
            </dl>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Konum</h2>
            <dl className="meta-row">
              <dt>İl/İlçe</dt>
              <dd>{request.city}/{request.district}</dd>
              <dt>Mahalle</dt>
              <dd>{request.neighborhood ?? '-'}</dd>
              <dt>Adres notu</dt>
              <dd>{request.addressNote ?? '-'}</dd>
            </dl>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Bütçe ve Zaman</h2>
            <dl className="meta-row">
              <dt>Min. bütçe</dt>
              <dd>{request.budgetMin !== null ? formatPrice(request.budgetMin) : '-'}</dd>
              <dt>Maks. bütçe</dt>
              <dd>{request.budgetMax !== null ? formatPrice(request.budgetMax) : '-'}</dd>
              <dt>Tercih tarih</dt>
              <dd>{request.preferredDate ? formatDate(request.preferredDate) : '-'}</dd>
              <dt>Aciliyet</dt>
              <dd>{urgencyLabel(request.urgency)}</dd>
              <dt>Açıklama</dt>
              <dd>{request.description ?? '-'}</dd>
            </dl>
          </section>

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

          {(request.answers ?? []).length > 0 ? (
            <section className="table-card">
              <div className="table-header">
                <h2>Dinamik Yanıtlar</h2>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Soru</th>
                      <th>Anahtar</th>
                      <th>Tip</th>
                      <th>Yanıt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(request.answers ?? []).map((answer) => (
                      <tr key={answer.id}>
                        <td>{answer.questionLabel}</td>
                        <td><code style={{ fontSize: 12 }}>{answer.questionKey}</code></td>
                        <td>{answer.questionType}</td>
                        <td>{formatValue(answer.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>

        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Durum Güncelle</h2>
            <form action={updateRequestStatusAction} style={{ display: 'grid', gap: 12 }}>
              <input type="hidden" name="id" value={request.id} />
              <label className="form-row">
                <span>Durum değiştir</span>
                <select name="status" defaultValue={request.status}>
                  {statuses.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-row">
                <span>Moderasyon notu</span>
                <textarea name="moderationNote" defaultValue={request.moderationNote ?? ''} />
              </label>
              <label className="form-row">
                <span>Ret gerekçesi</span>
                <textarea name="rejectionReason" defaultValue={request.rejectionReason ?? ''} />
              </label>
              <div>
                <button className="btn btn-primary btn-block" type="submit">Durumu Kaydet</button>
              </div>
            </form>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Kalite</h2>
            <form action={recalculateRequestQualityAction}>
              <input type="hidden" name="id" value={request.id} />
              <button className="btn btn-secondary btn-block" type="submit">
                Kalite skorunu yeniden hesapla
              </button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}

function renderBreakdownRows(breakdown: QualityScoreBreakdown | null) {
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
