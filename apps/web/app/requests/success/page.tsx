import Link from 'next/link';
import { apiFetch, CustomerServiceRequest, getCurrentUser } from '../../../lib/api';

type RequestSuccessPageProps = {
  searchParams: Promise<{ id?: string; published?: string }>;
};

/**
 * The screen after a request is sent.
 *
 * Two versions of the same page. A request born live — the API answered
 * `APPROVED`, and the form said so with `published=1` — is already in front of
 * providers, and the page must not promise a review that will never happen.
 * Anything else still goes through the operators first and keeps the old
 * wording. The flag is the form's report of what the API returned; the page
 * does not re-derive the status.
 */
export default async function RequestSuccessPage({ searchParams }: RequestSuccessPageProps) {
  const { id, published } = await searchParams;
  const isPublished = published === '1';
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
          {isPublished ? (
            <>
              <span className="kicker">Talebiniz yayında</span>
              <h1 className="page-title" data-testid="request-success-title">
                Talebiniz uygun hizmet verenlere iletildi
              </h1>
              <p className="page-subtitle">Talebiniz 14 gün boyunca teklif alır.</p>
            </>
          ) : (
            <>
              <span className="kicker">Talep alındı</span>
              <h1 className="page-title" data-testid="request-success-title">
                Talebiniz ön incelemeye gönderildi
              </h1>
              <p className="page-subtitle">
                Onay sonrasında uygun hizmet verenler teklif gönderebilir. Talebiniz 14 gün boyunca
                teklif alır.
              </p>
            </>
          )}
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
