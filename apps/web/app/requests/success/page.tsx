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
        <section>
          <span className="kicker">Talep alındı</span>
          <h1 className="page-title">Talebiniz ön incelemeye gönderildi</h1>
          <p className="page-subtitle">
            Onay sonrasında uygun hizmet verenler teklif gönderebilir. Talebiniz 14 gün boyunca
            teklif alır.
          </p>
          {referenceLabel ? (
            <p style={{ marginTop: 14 }}>
              Talep referansı: <code>{referenceLabel}</code>
            </p>
          ) : null}
          <div className="inline-actions" style={{ marginTop: 24 }}>
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
            <Link className="btn btn-secondary" href="/categories">
              Kategorilere dön
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
