import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  CustomerServiceRequest,
  OfferStatus,
  RequestOfferPreview,
  formatDateTime,
  formatPrice,
  getCurrentUser,
  statusLabel,
} from '../../../../lib/api';
import { CustomerShell } from '../../customer-shell';
import { completeRequestAction } from './actions';

type RequestOffersPageProps = {
  params: Promise<{ id: string }>;
};

export default async function RequestOffersPage({ params }: RequestOffersPageProps) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user || user.role !== 'CUSTOMER') {
    redirect(`/login?redirectTo=/requests/${id}/offers`);
  }

  const [offers, myRequests] = await Promise.all([
    apiFetch<RequestOfferPreview[]>(`/service-requests/${id}/offers`),
    safeFetchMyRequests(),
  ]);

  const summary = myRequests.find((request) => request.id === id) ?? null;
  const sortedOffers = [...offers].sort((a, b) => a.priceAmount - b.priceAmount);
  const offerCount = sortedOffers.length;
  const requestReference =
    summary?.requestNumber ?? `#${id.slice(-6).toUpperCase()}`;

  return (
    <CustomerShell user={user} active="requests">
      <Link className="cdash-page-back" href="/requests/my">
        <span aria-hidden="true">←</span>
        <span>Taleplere Dön</span>
      </Link>

      <section className="cdash-summary">
        <div className="cdash-summary-head">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            <span className={requestStatusClass(summary?.status)}>
              <span className="cdash-badge-dot" aria-hidden="true" />
              {statusLabel(summary?.status ?? 'SUBMITTED')}
            </span>
            <h2 className="cdash-summary-title">{summary?.category?.name ?? 'Talep Detayı'}</h2>
            <div className="cdash-summary-meta">
              <span>
                <span aria-hidden="true">📍</span>
                {summary ? (
                  <>
                    {summary.city}
                    {summary.district ? `, ${summary.district}` : ''}
                  </>
                ) : (
                  '—'
                )}
              </span>
              <span>
                <span aria-hidden="true">📅</span>
                {summary ? formatDateTime(summary.submittedAt) : '—'}
              </span>
              <span>
                <span aria-hidden="true">🔖</span>
                {requestReference}
              </span>
            </div>
          </div>
        </div>

        <div className="cdash-summary-divider" />

        <div>
          <span className="cdash-summary-label">Talep Özeti</span>
          <p className="cdash-summary-body">{summaryBody(summary)}</p>

          {summary?.status === 'MATCHED' ? (
            <form action={completeRequestAction} style={{ marginTop: 12 }}>
              <input type="hidden" name="requestId" value={id} />
              <button className="cdash-btn cdash-btn-primary" type="submit">
                Hizmet tamamlandı
              </button>
            </form>
          ) : null}
        </div>
      </section>

      <div className="cdash-section-head">
        <div className="cdash-section-title">
          <span>Gelen Teklifler</span>
          <span className="cdash-section-count">{offerCount}</span>
        </div>
        <label className="cdash-sort">
          <span>Sırala:</span>
          <select aria-label="Teklif sıralama" disabled defaultValue="lowest">
            <option value="lowest">En Düşük Fiyat</option>
          </select>
        </label>
      </div>

      {offerCount === 0 ? (
        <div className="cdash-empty">
          <h3>Henüz teklif gelmedi</h3>
          <p>
            Talebiniz hizmet verenlere ulaştı. Teklifler geldikçe burada görüntülenecektir.
          </p>
          <Link className="cdash-btn cdash-btn-secondary" href="/requests/my">
            Taleplere dön
          </Link>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sortedOffers.map((offer) => (
            <OfferCard key={offer.id} offer={offer} requestId={id} />
          ))}
        </div>
      )}
    </CustomerShell>
  );
}

function summaryBody(summary: CustomerServiceRequest | null) {
  if (!summary) {
    return 'Bu talebe ait özet bilgileri görüntülenemiyor. Talebiniz başka bir hesaptan oluşturulmuş olabilir.';
  }

  if (summary.status === 'MATCHED') {
    return 'Bir teklifi kabul ettiniz. Talebiniz artık yeni teklif almıyor. Hizmet tamamlandığında aşağıdan işaretleyebilirsiniz.';
  }

  if (summary.status === 'COMPLETED') {
    return 'Bu talep tamamlandı olarak işaretlendi.';
  }

  return 'Talebiniz hizmet verenlere iletildi. Aşağıdaki kartlarda gelen teklifleri inceleyebilirsiniz.';
}

function OfferCard({ offer, requestId }: { offer: RequestOfferPreview; requestId: string }) {
  const initials = getInitials(offer.provider.businessName);
  const offerReference =
    offer.offerNumber ?? `#${offer.id.slice(-6).toUpperCase()}`;
  return (
    <article className="cdash-offer">
      <div className="cdash-offer-head">
        <span className={offerStatusClass(offer.status)}>{offerStatusLabel(offer.status)}</span>
        <div className="cdash-offer-provider">
          <span className="cdash-offer-avatar" aria-hidden="true">
            {initials}
          </span>
          <div style={{ minWidth: 0 }}>
            <h3 className="cdash-offer-name">{offer.provider.businessName}</h3>
            <p className="cdash-offer-sub">
              {offer.provider.city}
              {offer.provider.district ? `, ${offer.provider.district}` : ''} · {formatDateTime(offer.submittedAt)}
            </p>
            <p
              className="cdash-offer-sub"
              style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 2 }}
            >
              {offerReference}
            </p>
          </div>
        </div>
        {offer.message ? <p className="cdash-offer-message">{offer.message}</p> : null}
        {offer.warrantyNote ? (
          <p className="cdash-offer-warranty">Garanti notu: {offer.warrantyNote}</p>
        ) : null}
      </div>

      <div className="cdash-offer-side">
        <span className="cdash-offer-price-label">Teklif Edilen Tutar</span>
        <span className="cdash-offer-price">{formatPrice(offer.priceAmount, offer.currency)}</span>
        <div className="cdash-offer-actions">
          <Link
            className="cdash-btn cdash-btn-primary"
            href={`/requests/${requestId}/offers/${offer.id}`}
          >
            Teklifi İncele
          </Link>
        </div>
      </div>
    </article>
  );
}

const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  SUBMITTED: 'Bekliyor',
  VIEWED: 'Görüntülendi',
  SHORTLISTED: 'Kısa listede',
  ACCEPTED: 'Kabul edildi',
  REJECTED: 'Reddedildi',
  WITHDRAWN: 'Geri çekildi',
  EXPIRED: 'Süresi doldu',
  CANCELLED: 'İptal edildi',
};

function offerStatusLabel(status: OfferStatus): string {
  return OFFER_STATUS_LABELS[status] ?? statusLabel(status);
}

function offerStatusClass(status: OfferStatus): string {
  switch (status) {
    case 'ACCEPTED':
      return 'cdash-badge cdash-badge-success';
    case 'REJECTED':
    case 'WITHDRAWN':
    case 'EXPIRED':
    case 'CANCELLED':
      return 'cdash-badge cdash-badge-danger';
    case 'SUBMITTED':
    case 'VIEWED':
    case 'SHORTLISTED':
    default:
      return 'cdash-badge cdash-badge-info';
  }
}

async function safeFetchMyRequests(): Promise<CustomerServiceRequest[]> {
  try {
    return await apiFetch<CustomerServiceRequest[]>('/service-requests/my');
  } catch {
    return [];
  }
}

function requestStatusClass(status: string | undefined): string {
  switch (status) {
    case 'APPROVED':
    case 'MATCHED':
    case 'COMPLETED':
      return 'cdash-badge cdash-badge-success';
    case 'REJECTED':
    case 'CANCELLED':
    case 'EXPIRED':
      return 'cdash-badge cdash-badge-danger';
    case 'SUBMITTED':
    case 'IN_REVIEW':
    case 'PENDING':
    case 'PENDING_REVIEW':
    default:
      return 'cdash-badge cdash-badge-info';
  }
}

function getInitials(value: string): string {
  const cleaned = value.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!cleaned) return 'H';
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toLocaleUpperCase('tr-TR')).join('') || 'H';
}
