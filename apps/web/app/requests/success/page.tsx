import Link from 'next/link';
import { apiFetch, CustomerServiceRequest, getCurrentUser } from '../../../lib/api';

type RequestSuccessPageProps = {
  searchParams: Promise<{ id?: string }>;
};

export default async function RequestSuccessPage({ searchParams }: RequestSuccessPageProps) {
  const { id } = await searchParams;
  const user = await getCurrentUser();

  let referenceLabel: string | null = null;
  if (id) {
    if (user?.role === 'CUSTOMER') {
      try {
        const myRequests = await apiFetch<CustomerServiceRequest[]>('/service-requests/my');
        const match = myRequests.find((r) => r.id === id);
        referenceLabel = match?.requestNumber ?? `#${id.slice(-6).toUpperCase()}`;
      } catch {
        referenceLabel = `#${id.slice(-6).toUpperCase()}`;
      }
    } else {
      referenceLabel = `#${id.slice(-6).toUpperCase()}`;
    }
  }

  return (
    <main>
      <div className="page-narrow">
        <section className="card" style={{ margin: 0, textAlign: 'center', padding: 32 }}>
          <span className="badge badge-good" style={{ fontSize: 13, padding: '8px 14px' }}>Talep alındı</span>
          <h1 className="page-title" style={{ marginTop: 14 }}>Talebiniz ön incelemeye gönderildi</h1>
          <p className="muted" style={{ marginBottom: 0 }}>
            Onay sonrasında uygun hizmet verenler teklif gönderebilir.
          </p>
          {referenceLabel ? (
            <p style={{ marginTop: 14 }}>
              Talep referansı: <code>{referenceLabel}</code>
            </p>
          ) : null}
          <div className="inline-actions" style={{ justifyContent: 'center', marginTop: 18 }}>
            {id ? (
              <Link className="btn btn-primary" href={`/requests/${id}/offers`}>
                Teklifleri görüntüle
              </Link>
            ) : null}
            {user?.role === 'CUSTOMER' ? (
              <Link className="btn btn-secondary" href="/requests/my">
                Taleplerim
              </Link>
            ) : null}
            <Link className="btn btn-ghost" href="/categories">
              Kategorilere dön
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
