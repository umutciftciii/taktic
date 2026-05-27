import Link from 'next/link';
import { apiFetch, RequestOfferDetail, statusLabel } from '../../../../../lib/api';
import { customerOfferAction } from './actions';

type RequestOfferDetailPageProps = {
  params: Promise<{ id: string; offerId: string }>;
};

export default async function RequestOfferDetailPage({ params }: RequestOfferDetailPageProps) {
  const { id, offerId } = await params;
  const offer = await apiFetch<RequestOfferDetail>(`/service-requests/${id}/offers/${offerId}/view`, {
    method: 'POST',
  });

  return (
    <main>
      <p>
        <Link href={`/requests/${id}/offers`}>Tekliflere dön</Link>
      </p>
      <h1>Teklif Detayı</h1>
      <p>Bu fazda ödeme ve iletişim akışı henüz aktif değildir.</p>
      {offer.status === 'ACCEPTED' ? (
        <p className="notice">Bu fazda ödeme ve iletişim akışı henüz aktif değildir.</p>
      ) : null}

      <section>
        <h2>Sağlayıcı</h2>
        <p>{offer.provider.businessName}</p>
        <p>
          Konum: {offer.provider.city}/{offer.provider.district}
        </p>
      </section>

      <section>
        <h2>Teklif</h2>
        <p><span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span></p>
        <p>
          Fiyat: {offer.priceAmount} {offer.currency}
        </p>
        <p>Başlangıç: {offer.estimatedStartDate ? formatDate(offer.estimatedStartDate) : '-'}</p>
        <p>Bitiş: {offer.estimatedCompletionDate ? formatDate(offer.estimatedCompletionDate) : '-'}</p>
        <p>Mesaj: {offer.message}</p>
        <p>Garanti notu: {offer.warrantyNote ?? '-'}</p>
        <p>Gönderim: {formatDate(offer.submittedAt)}</p>
        <p>Görüntülenme: {offer.viewedAt ? formatDate(offer.viewedAt) : '-'}</p>
      </section>

      <section>
        <h2>Aksiyonlar</h2>
        <div className="actions">
          <ActionButton requestId={id} offerId={offerId} action="SHORTLIST" label="Kısa Listeye Al" />
          <ActionButton requestId={id} offerId={offerId} action="REJECT" label="Reddet" />
          <ActionButton requestId={id} offerId={offerId} action="ACCEPT" label="Kabul Et" />
        </div>
      </section>
    </main>
  );
}

function statusBadgeClass(status: string) {
  if (status === 'ACCEPTED' || status === 'SHORTLISTED') return 'badge badge-good';
  if (status === 'REJECTED') return 'badge badge-bad';
  return 'badge badge-warn';
}

function ActionButton({
  requestId,
  offerId,
  action,
  label,
}: {
  requestId: string;
  offerId: string;
  action: 'SHORTLIST' | 'REJECT' | 'ACCEPT';
  label: string;
}) {
  return (
    <form action={customerOfferAction}>
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="action" value={action} />
      <button type="submit">{label}</button>
    </form>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
