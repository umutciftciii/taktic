import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  RequestOfferDetail,
  formatDate,
  formatDateTime,
  formatPrice,
  getCurrentUser,
  statusLabel,
} from '../../../../../lib/api';
import { CustomerShell } from '../../../customer-shell';
import { IconArrowLeft } from '../../../../landing-icons';
import { customerOfferAction } from './actions';

type RequestOfferDetailPageProps = {
  params: Promise<{ id: string; offerId: string }>;
};

export default async function RequestOfferDetailPage({ params }: RequestOfferDetailPageProps) {
  const { id, offerId } = await params;

  const user = await getCurrentUser();
  if (!user || user.role !== 'CUSTOMER') {
    redirect(`/login?redirectTo=/requests/${id}/offers/${offerId}`);
  }

  // Unknown offer, offer on another request, another customer's request: all
  // one 404, never the error boundary.
  const offer = await fetchOrNotFound(() =>
    apiFetch<RequestOfferDetail>(`/service-requests/${id}/offers/${offerId}/view`, {
      method: 'POST',
    }),
  );

  const actionable =
    offer.status !== 'ACCEPTED' && offer.status !== 'REJECTED' && offer.status !== 'WITHDRAWN';

  return (
    <CustomerShell user={user} active="requests">
      <Link className="cdash-page-back" href={`/requests/${id}/offers`}>
        <IconArrowLeft size={14} />
        <span>Tekliflere dön</span>
      </Link>

      <header className="cdash-page-head">
        <span className="kicker">Teklif detayı</span>
        <h1 className="cdash-page-title">{offer.provider.businessName}</h1>
        <p className="cdash-page-sub">
          {offer.provider.city}
          {offer.provider.district ? `, ${offer.provider.district}` : ''}
        </p>
      </header>

      <div className="cdash-detail-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section className="cdash-detail-card">
            <h2>Teklif</h2>
            <dl className="cdash-meta-list">
              <dt>Fiyat</dt>
              <dd>
                <strong>{formatPrice(offer.priceAmount, offer.currency)}</strong>
              </dd>
              <dt>Durum</dt>
              <dd>
                <span className={offerStatusClass(offer.status)} data-testid="offer-status">
                  {statusLabel(offer.status)}
                </span>
              </dd>
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

          <section className="cdash-detail-card">
            <h2>Mesaj</h2>
            <p style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 14 }}>
              {offer.message}
            </p>
            {offer.warrantyNote ? (
              <>
                <h2 style={{ marginTop: 6, fontSize: 14 }}>Garanti notu</h2>
                <p
                  style={{
                    whiteSpace: 'pre-wrap',
                    margin: 0,
                    fontSize: 13,
                    color: 'var(--muted)',
                  }}
                >
                  {offer.warrantyNote}
                </p>
              </>
            ) : null}
          </section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section className="cdash-detail-card">
            <h2>Hizmet Veren</h2>
            <dl className="cdash-meta-list">
              <dt>İşletme</dt>
              <dd>{offer.provider.businessName}</dd>
              <dt>Konum</dt>
              <dd>
                {offer.provider.city}
                {offer.provider.district ? `, ${offer.provider.district}` : ''}
              </dd>
            </dl>
          </section>

          {/*
            Only the two actions that decide something. Shortlisting was removed:
            it moved the offer into a state with no product rule behind it —
            nothing filtered on it, nobody was notified, and the customer could
            not undo it — so the button promised a decision the platform never
            made. Accepting and rejecting are unchanged, and so is every state
            that makes them unavailable.
          */}
          {actionable ? (
            <section className="cdash-detail-card">
              <h2>Aksiyonlar</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="offer-actions">
                <ActionButton
                  requestId={id}
                  offerId={offerId}
                  action="ACCEPT"
                  label="Kabul Et"
                  variant="primary"
                />
                <ActionButton
                  requestId={id}
                  offerId={offerId}
                  action="REJECT"
                  label="Reddet"
                  variant="danger"
                />
              </div>
            </section>
          ) : null}

          <div className="cdash-notice">
            Ödeme ve doğrudan iletişim akışı henüz aktif değildir. Teklifi kabul ettiğinizde hizmet
            veren bilgilendirilir.
          </div>
        </div>
      </div>
    </CustomerShell>
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
  action: 'REJECT' | 'ACCEPT';
  label: string;
  variant: 'primary' | 'danger';
}) {
  const className =
    variant === 'primary'
      ? 'cdash-btn cdash-btn-primary cdash-btn-block'
      : 'cdash-btn cdash-btn-danger cdash-btn-block';

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

function offerStatusClass(status: string): string {
  switch (status) {
    case 'ACCEPTED':
      return 'tag tag-ink';
    case 'REJECTED':
    case 'WITHDRAWN':
    case 'EXPIRED':
    case 'CANCELLED':
      return 'tag tag-neutral';
    case 'SHORTLISTED':
      return 'tag tag-accent';
    case 'SUBMITTED':
    case 'VIEWED':
    default:
      return 'tag tag-neutral';
  }
}
