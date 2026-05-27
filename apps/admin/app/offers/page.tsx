import Link from 'next/link';
import { apiFetch, Offer, statusLabel } from '../../lib/api';

type AdminOffersPageProps = {
  searchParams?: Promise<{
    providerId?: string;
    requestId?: string;
  }>;
};

export default async function AdminOffersPage({ searchParams }: AdminOffersPageProps) {
  const params = (await searchParams) ?? {};
  const query = new URLSearchParams();
  if (params.providerId) query.set('providerId', params.providerId);
  if (params.requestId) query.set('requestId', params.requestId);
  const offers = await apiFetch<Offer[]>(`/offers${query.toString() ? `?${query.toString()}` : ''}`);

  return (
    <main>
      <p>
        <Link href="/">Admin home</Link>
      </p>
      <h1>Offers</h1>
      {params.providerId || params.requestId ? (
        <p className="notice">
          Filtre aktif. <Link href="/offers">Filtreleri temizle</Link>
        </p>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>Submitted</th>
            <th>Provider</th>
            <th>Request category</th>
            <th>Location</th>
            <th>Price</th>
            <th>Credit</th>
            <th>Refund</th>
            <th>Refund policy</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {offers.map((offer) => (
            <tr key={offer.id}>
              <td>{formatDate(offer.submittedAt)}</td>
              <td>{offer.provider.businessName}</td>
              <td>{offer.request.category.name}</td>
              <td>
                {offer.request.city}/{offer.request.district}
              </td>
              <td>
                {offer.priceAmount} {offer.currency}
              </td>
              <td>{offer.creditCost}</td>
              <td><span className={offer.creditRefundedAt ? 'badge badge-good' : 'badge'}>{offer.creditRefundedAt ? 'Refunded' : 'Not refunded'}</span></td>
              <td><span className="badge">{offer.refundEligibility.recommendedAction}</span></td>
              <td><span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span></td>
              <td>
                <Link href={`/offers/${offer.id}`}>Open</Link>{' '}
                <Link href={`/requests/${offer.request.id}`}>Request</Link>{' '}
                <Link href={`/providers/${offer.provider.id}`}>Provider</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {offers.length === 0 ? <div className="empty-state">No offers yet.</div> : null}
    </main>
  );
}

function statusBadgeClass(status: string) {
  if (status === 'ACCEPTED' || status === 'SHORTLISTED') return 'badge badge-good';
  if (status === 'REJECTED' || status === 'WITHDRAWN' || status === 'CANCELLED' || status === 'EXPIRED') return 'badge badge-bad';
  return 'badge badge-warn';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
