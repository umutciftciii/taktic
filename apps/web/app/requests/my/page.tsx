import Link from 'next/link';
import { redirect } from 'next/navigation';
import { apiFetch, CustomerServiceRequest, getCurrentUser, statusLabel } from '../../../lib/api';

export default async function MyRequestsPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'CUSTOMER') {
    redirect('/login?redirectTo=/requests/my');
  }

  const requests = await apiFetch<CustomerServiceRequest[]>('/service-requests/my');

  return (
    <main>
      <p>
        <Link href="/">Ana sayfa</Link>
      </p>
      <h1>Taleplerim</h1>
      {requests.length === 0 ? <div className="empty-state">Henüz talep oluşturmadınız.</div> : null}
      <section className="card-grid">
        {requests.map((request) => (
          <article className="card" key={request.id}>
            <h2>{request.category.name}</h2>
            <p>
              <span className={statusBadgeClass(request.status)}>{statusLabel(request.status)}</span>
              <span className={qualityBadgeClass(request.qualityLabel)}>
                Kalite {request.qualityScore}/100
              </span>
              <span className="badge">{request.offersCount} teklif</span>
            </p>
            <p>
              Konum: {request.city}/{request.district}
            </p>
            <p>Gönderim: {formatDate(request.submittedAt)}</p>
            <p className="actions">
              <Link className="button" href={`/requests/${request.id}/offers`}>
                Teklifleri görüntüle
              </Link>
            </p>
          </article>
        ))}
      </section>
    </main>
  );
}

function statusBadgeClass(status: string) {
  if (status === 'APPROVED') return 'badge badge-good';
  if (status === 'REJECTED' || status === 'CANCELLED') return 'badge badge-bad';
  return 'badge badge-warn';
}

function qualityBadgeClass(label: string) {
  if (label === 'HIGH') return 'badge badge-good';
  if (label === 'MEDIUM') return 'badge badge-warn';
  return 'badge badge-bad';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
