import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  CustomerServiceRequest,
  getCurrentUser,
  statusLabel,
  statusBadgeClass,
  qualityBadgeClass,
  qualityLabel,
  formatDateTime,
} from '../../../lib/api';

export default async function MyRequestsPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'CUSTOMER') {
    redirect('/login?redirectTo=/requests/my');
  }

  const requests = await apiFetch<CustomerServiceRequest[]>('/service-requests/my');

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/">Ana sayfa</Link>
        <span aria-hidden="true">/</span>
        <span>Taleplerim</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">Taleplerim</h1>
        <p className="page-subtitle">Oluşturduğunuz talepler ve aldığınız teklifler.</p>
      </header>

      {requests.length === 0 ? (
        <div className="empty-state">
          <h2>Henüz talep oluşturmadınız</h2>
          <p className="muted">Bir kategori seçerek ilk talebinizi oluşturabilirsiniz.</p>
          <Link className="btn btn-primary" href="/categories" style={{ marginTop: 8 }}>
            Hizmet kategorilerine git
          </Link>
        </div>
      ) : null}

      <div className="list-stack">
        {requests.map((request) => {
          const hasOffers = request.offersCount > 0;
          const offersBadgeText = hasOffers
            ? `${request.offersCount} teklif geldi`
            : 'Henüz teklif yok';
          const offersBadgeClass = hasOffers ? 'badge badge-info' : 'badge badge-muted';
          const ctaLabel = hasOffers ? 'Teklifleri görüntüle' : 'Talebi görüntüle';
          const ctaClass = hasOffers ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm';

          return (
            <article className="list-card" key={request.id}>
              <div className="list-card-header">
                <div>
                  <h2 className="list-card-title">{request.category.name}</h2>
                  <p className="list-card-meta">
                    <span>{request.city}/{request.district}</span>
                    <span>{formatDateTime(request.submittedAt)}</span>
                  </p>
                </div>
                <div className="inline-actions">
                  <span className={offersBadgeClass}>{offersBadgeText}</span>
                  <span className={statusBadgeClass(request.status)}>{statusLabel(request.status)}</span>
                  <span className={qualityBadgeClass(request.qualityLabel)}>
                    Kalite {request.qualityScore} · {qualityLabel(request.qualityLabel)}
                  </span>
                </div>
              </div>
              <div className="inline-actions">
                <Link className={ctaClass} href={`/requests/${request.id}/offers`}>
                  {ctaLabel}
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </main>
  );
}
