import Link from 'next/link';
import {
  apiFetch,
  Offer,
  OfferStatus,
  statusLabel,
  statusBadgeClass,
  refundActionLabel,
  refundActionBadgeClass,
  formatPrice,
  formatDateTime,
} from '../../../lib/api';
import { refundOfferCreditAction, updateOfferStatusAction } from '../actions';

const statuses: OfferStatus[] = [
  'SUBMITTED',
  'VIEWED',
  'SHORTLISTED',
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED',
  'CANCELLED',
];

const refundReasonCodes = [
  'NOT_VIEWED_48H',
  'VIEWED_MANUAL_REVIEW',
  'INVALID_REQUEST',
  'CUSTOMER_UNREACHABLE',
  'DUPLICATE_REQUEST',
  'ADMIN_OVERRIDE',
  'OTHER',
];

type OfferDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OfferDetailPage({ params }: OfferDetailPageProps) {
  const { id } = await params;
  const offer = await apiFetch<Offer>(`/offers/${id}`);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/">Dashboard</Link>
        <span aria-hidden="true">/</span>
        <Link href="/offers">Teklifler</Link>
        <span aria-hidden="true">/</span>
        <span>Detay</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">{offer.provider.businessName}</h1>
        <p className="page-subtitle">
          <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>{' '}
          <span className="muted">
            · {formatPrice(offer.priceAmount, offer.currency)} · {offer.request.category.name}
          </span>
        </p>
      </header>

      <div className="inline-actions" style={{ marginBottom: 18 }}>
        <Link className="btn btn-secondary btn-sm" href={`/requests/${offer.request.id}`}>Talebi aç</Link>
        <Link className="btn btn-secondary btn-sm" href={`/providers/${offer.provider.id}`}>
          Hizmet vereni aç
        </Link>
        <Link className="btn btn-ghost btn-sm" href={`/offers?requestId=${offer.request.id}`}>
          Bu talebin tüm teklifleri
        </Link>
      </div>

      <div className="detail-grid">
        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Özet</h2>
            <dl className="meta-row">
              <dt>Teklif ID</dt>
              <dd><code style={{ fontSize: 12 }}>{offer.id}</code></dd>
              <dt>Fiyat</dt>
              <dd><strong>{formatPrice(offer.priceAmount, offer.currency)}</strong></dd>
              <dt>Mesaj</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{offer.message}</dd>
              <dt>Garanti</dt>
              <dd className="muted">{offer.warrantyNote ?? '-'}</dd>
              <dt>İç not</dt>
              <dd className="muted">{offer.internalNote ?? '-'}</dd>
              <dt>Gönderim</dt>
              <dd>{formatDateTime(offer.submittedAt)}</dd>
              <dt>Görüntülendi</dt>
              <dd>{offer.viewedAt ? formatDateTime(offer.viewedAt) : '-'}</dd>
              <dt>Kabul</dt>
              <dd>{offer.acceptedAt ? formatDateTime(offer.acceptedAt) : '-'}</dd>
              <dt>Ret</dt>
              <dd>{offer.rejectedAt ? formatDateTime(offer.rejectedAt) : '-'}</dd>
              <dt>Geri çekildi</dt>
              <dd>{offer.withdrawnAt ? formatDateTime(offer.withdrawnAt) : '-'}</dd>
            </dl>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Kredi ve İade</h2>
            <dl className="meta-row">
              <dt>Kredi maliyeti</dt>
              <dd>{offer.creditCost}</dd>
              <dt>Harcama işlemi</dt>
              <dd>{offer.creditSpentTransactionId ?? '-'}</dd>
              <dt>İade işlemi</dt>
              <dd>{offer.creditRefundedTransactionId ?? '-'}</dd>
              <dt>İade tarihi</dt>
              <dd>{offer.creditRefundedAt ? formatDateTime(offer.creditRefundedAt) : '-'}</dd>
              <dt>İade sebebi</dt>
              <dd className="muted">{offer.creditRefundReason ?? '-'}</dd>
              <dt>Uygunluk</dt>
              <dd>
                <span className={offer.refundEligibility.eligible ? 'badge badge-good' : 'badge badge-muted'}>
                  {offer.refundEligibility.eligible ? 'Uygun' : 'Uygun değil'}
                </span>
              </dd>
              <dt>Öneri</dt>
              <dd>
                <span className={refundActionBadgeClass(offer.refundEligibility.recommendedAction)}>
                  {refundActionLabel(offer.refundEligibility.recommendedAction)}
                </span>
              </dd>
              <dt>Sebep kodu</dt>
              <dd><code style={{ fontSize: 12 }}>{offer.refundEligibility.reasonCode}</code></dd>
              <dt>Sebep</dt>
              <dd>{offer.refundEligibility.reasonLabel}</dd>
              <dt>Detay</dt>
              <dd className="muted">{offer.refundEligibility.details}</dd>
              <dt>Gönderim sonrası saat</dt>
              <dd>{offer.refundEligibility.hoursSinceSubmitted ?? '-'}</dd>
            </dl>
          </section>
        </div>

        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Hizmet Veren</h2>
            <dl className="meta-row">
              <dt>İşletme</dt>
              <dd>{offer.provider.businessName}</dd>
              <dt>Yetkili</dt>
              <dd>{offer.provider.contactName}</dd>
              <dt>Telefon</dt>
              <dd>{offer.provider.phone}</dd>
              <dt>E-posta</dt>
              <dd>{offer.provider.email ?? '-'}</dd>
            </dl>
            <Link className="btn btn-ghost btn-sm" href={`/providers/${offer.provider.id}/credits`}>
              Kredi geçmişi
            </Link>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Talep</h2>
            <dl className="meta-row">
              <dt>Kategori</dt>
              <dd>{offer.request.category.name}</dd>
              <dt>Konum</dt>
              <dd>{offer.request.city}/{offer.request.district}</dd>
              <dt>Kalite</dt>
              <dd>{offer.request.qualityScore}/100</dd>
            </dl>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Durumu Güncelle</h2>
            <form action={updateOfferStatusAction} style={{ display: 'grid', gap: 12 }}>
              <input type="hidden" name="id" value={offer.id} />
              <label className="form-row">
                <span>Durum</span>
                <select name="status" defaultValue={offer.status}>
                  {statuses.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <button className="btn btn-primary btn-block" type="submit">Durumu Kaydet</button>
              </div>
            </form>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Kredi İadesi</h2>
            {offer.creditRefundedAt ? (
              <div className="notice-success">Bu teklif için kredi zaten iade edilmiş.</div>
            ) : offer.creditSpentTransactionId ? (
              <form action={refundOfferCreditAction} style={{ display: 'grid', gap: 12 }}>
                <input type="hidden" name="id" value={offer.id} />
                <label className="form-row">
                  <span>Sebep kodu *</span>
                  <select name="reasonCode" defaultValue={offer.refundEligibility.reasonCode}>
                    {refundReasonCodes.map((reasonCode) => (
                      <option key={reasonCode} value={reasonCode}>
                        {reasonCode}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form-row">
                  <span>Yönetici notu</span>
                  <textarea name="reason" />
                </label>
                {offer.refundEligibility.recommendedAction === 'NO_REFUND' ? (
                  <label className="checkbox-row">
                    <input type="checkbox" name="override" value="true" />
                    <span>"İade yok" önerisini geçersiz kıl</span>
                  </label>
                ) : null}
                <div>
                  <button className="btn btn-danger btn-block" type="submit">Kredi iade et</button>
                </div>
              </form>
            ) : (
              <div className="notice-warning">Bu teklifin kredi harcama işlemi yok.</div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
