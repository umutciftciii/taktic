import Link from 'next/link';
import {
  apiFetch,
  RequestOfferDetail,
  statusLabel,
  statusBadgeClass,
  formatPrice,
  formatDate,
  formatDateTime,
} from '../../../../../lib/api';
import { customerOfferAction } from './actions';

type RequestOfferDetailPageProps = {
  params: Promise<{ id: string; offerId: string }>;
};

export default async function RequestOfferDetailPage({ params }: RequestOfferDetailPageProps) {
  const { id, offerId } = await params;
  const offer = await apiFetch<RequestOfferDetail>(`/service-requests/${id}/offers/${offerId}/view`, {
    method: 'POST',
  });

  const actionable = offer.status !== 'ACCEPTED' && offer.status !== 'REJECTED' && offer.status !== 'WITHDRAWN';

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/requests/my">Taleplerim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/requests/${id}/offers`}>Teklifler</Link>
        <span aria-hidden="true">/</span>
        <span>Teklif detayı</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">{offer.provider.businessName}</h1>
        <p className="page-subtitle">
          <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>{' '}
          <span className="muted">· {offer.provider.city}/{offer.provider.district}</span>
        </p>
      </header>

      <div className="detail-grid">
        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Teklif</h2>
            <dl className="meta-row">
              <dt>Fiyat</dt>
              <dd><strong>{formatPrice(offer.priceAmount, offer.currency)}</strong></dd>
              <dt>Durum</dt>
              <dd><span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span></dd>
              <dt>Tahmini başlangıç</dt>
              <dd>{offer.estimatedStartDate ? formatDate(offer.estimatedStartDate) : '-'}</dd>
              <dt>Tahmini bitiş</dt>
              <dd>{offer.estimatedCompletionDate ? formatDate(offer.estimatedCompletionDate) : '-'}</dd>
              <dt>Gönderim</dt>
              <dd>{formatDateTime(offer.submittedAt)}</dd>
              <dt>Görüntülenme</dt>
              <dd>{offer.viewedAt ? formatDateTime(offer.viewedAt) : '-'}</dd>
            </dl>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Mesaj</h2>
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{offer.message}</p>
            {offer.warrantyNote ? (
              <>
                <h3 style={{ marginTop: 14, fontSize: 14 }}>Garanti notu</h3>
                <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{offer.warrantyNote}</p>
              </>
            ) : null}
          </section>
        </div>

        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Hizmet Veren</h2>
            <dl className="meta-row">
              <dt>İşletme</dt>
              <dd>{offer.provider.businessName}</dd>
              <dt>Konum</dt>
              <dd>{offer.provider.city}/{offer.provider.district}</dd>
            </dl>
          </section>

          {actionable ? (
            <section className="card" style={{ margin: 0 }}>
              <h2>Aksiyonlar</h2>
              <div className="inline-actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <ActionButton requestId={id} offerId={offerId} action="ACCEPT" label="Kabul Et" variant="primary" />
                <ActionButton requestId={id} offerId={offerId} action="SHORTLIST" label="Kısa Listeye Al" variant="secondary" />
                <ActionButton requestId={id} offerId={offerId} action="REJECT" label="Reddet" variant="danger" />
              </div>
            </section>
          ) : null}

          <div className="notice">
            Ödeme ve doğrudan iletişim akışı henüz aktif değildir. Teklifi kabul ettiğinizde hizmet veren
            bilgilendirilir.
          </div>
        </div>
      </div>
    </main>
  );
}

function ActionButton({
  requestId,
  offerId,
  action,
  label,
  variant,
}: {
  requestId: string;
  offerId: string;
  action: 'SHORTLIST' | 'REJECT' | 'ACCEPT';
  label: string;
  variant: 'primary' | 'secondary' | 'danger';
}) {
  const className =
    variant === 'primary'
      ? 'btn btn-primary btn-block'
      : variant === 'danger'
        ? 'btn btn-danger btn-block'
        : 'btn btn-secondary btn-block';

  return (
    <form action={customerOfferAction}>
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="action" value={action} />
      <button className={className} type="submit">
        {label}
      </button>
    </form>
  );
}
