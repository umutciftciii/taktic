import Link from 'next/link';
import { getCurrentUser } from '../../../lib/api';

type RequestSuccessPageProps = {
  searchParams: Promise<{ id?: string }>;
};

export default async function RequestSuccessPage({ searchParams }: RequestSuccessPageProps) {
  const { id } = await searchParams;
  const user = await getCurrentUser();

  return (
    <main>
      <h1>Talebiniz alındı ve ön incelemeye gönderildi.</h1>
      {id ? <p>Talep referansi: {id}</p> : null}
      <p>Talebiniz onaylandıktan sonra uygun hizmet verenler teklif verebilir.</p>
      <p className="actions">
        {id ? <Link className="button" href={`/requests/${id}/offers`}>Teklifleri görüntüle</Link> : null}
        {user?.role === 'CUSTOMER' ? (
          <Link className="button" href="/requests/my">Taleplerime git</Link>
        ) : null}
        <Link href="/categories">Kategorilere dön</Link>
      </p>
    </main>
  );
}
