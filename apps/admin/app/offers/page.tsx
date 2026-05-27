import Link from 'next/link';
import {
  apiFetch,
  Offer,
  statusLabel,
  statusBadgeClass,
  refundActionLabel,
  refundActionBadgeClass,
  formatPrice,
  formatDateTime,
} from '../../lib/api';

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

  const hasFilter = Boolean(params.providerId || params.requestId);

  return (
    <main>
      <header className="page-header">
        <h1 className="page-title">Teklifler</h1>
        <p className="page-subtitle">Tüm hizmet verenler tarafından gönderilen teklifler.</p>
      </header>

      {hasFilter ? (
        <div className="notice" style={{ marginBottom: 18 }}>
          Filtre aktif.{' '}
          <Link href="/offers">Filtreleri temizle</Link>
        </div>
      ) : null}

      <div className="table-card">
        <div className="table-header">
          <h2>Teklif listesi</h2>
          <span className="muted" style={{ fontSize: 13 }}>{offers.length} kayıt</span>
        </div>
        {offers.length === 0 ? (
          <div style={{ padding: 18 }} className="empty-state">Henüz teklif yok.</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Gönderim</th>
                  <th>Hizmet Veren</th>
                  <th>Kategori</th>
                  <th>Konum</th>
                  <th>Fiyat</th>
                  <th>Kredi</th>
                  <th>İade</th>
                  <th>İade önerisi</th>
                  <th>Durum</th>
                  <th>İşlem</th>
                </tr>
              </thead>
              <tbody>
                {offers.map((offer) => (
                  <tr key={offer.id}>
                    <td>{formatDateTime(offer.submittedAt)}</td>
                    <td><strong>{offer.provider.businessName}</strong></td>
                    <td>{offer.request.category.name}</td>
                    <td>{offer.request.city}/{offer.request.district}</td>
                    <td>{formatPrice(offer.priceAmount, offer.currency)}</td>
                    <td>{offer.creditCost}</td>
                    <td>
                      <span className={offer.creditRefundedAt ? 'badge badge-good' : 'badge badge-muted'}>
                        {offer.creditRefundedAt ? 'İade edildi' : 'İade yok'}
                      </span>
                    </td>
                    <td>
                      <span className={refundActionBadgeClass(offer.refundEligibility.recommendedAction)}>
                        {refundActionLabel(offer.refundEligibility.recommendedAction)}
                      </span>
                    </td>
                    <td>
                      <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
                    </td>
                    <td>
                      <div className="inline-actions">
                        <Link className="btn btn-secondary btn-sm" href={`/offers/${offer.id}`}>Detay</Link>
                        <Link className="btn btn-ghost btn-sm" href={`/requests/${offer.request.id}`}>Talep</Link>
                        <Link className="btn btn-ghost btn-sm" href={`/providers/${offer.provider.id}`}>HV</Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
