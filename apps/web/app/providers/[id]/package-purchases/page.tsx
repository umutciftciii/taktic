import Link from 'next/link';
import { apiFetch, PackagePurchase, statusLabel } from '../../../../lib/api';

type ProviderPackagePurchasesPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderPackagePurchasesPage({ params }: ProviderPackagePurchasesPageProps) {
  const { id } = await params;
  const purchases = await apiFetch<PackagePurchase[]>(`/providers/${id}/package-purchases`);

  return (
    <main>
      <p>
        <Link href="/providers/me">Panelim</Link> <Link href={`/providers/${id}/credits`}>Kredilerim</Link>
      </p>
      <h1>Paket Satın Alma Geçmişi</h1>
      {purchases.length === 0 ? <div className="empty-state">Henüz paket satın alma kaydı yok.</div> : null}
      {purchases.map((purchase) => (
        <article className="card" key={purchase.id}>
          <h2>{purchase.packageNameSnapshot}</h2>
          <p>
            <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span>
            <span className="badge">{purchase.creditAmountSnapshot} kredi</span>
            <span className="badge">
              {purchase.priceAmountSnapshot} {purchase.currencySnapshot}
            </span>
          </p>
          <p>Oluşturulma: {formatDate(purchase.createdAt)}</p>
          <p>Ödeme referansı: {purchase.mockPaymentReference ?? '-'}</p>
          <p>
            <Link href={`/providers/${id}/package-purchases/${purchase.id}`}>Detay</Link>
            {purchase.status === 'PENDING' ? (
              <>
                {' '}
                <Link href={`/providers/${id}/package-purchases/${purchase.id}/checkout`}>Ödeme ekranı</Link>
              </>
            ) : null}
          </p>
        </article>
      ))}
    </main>
  );
}

function statusBadgeClass(status: string) {
  if (status === 'PAID') return 'badge badge-good';
  if (status === 'FAILED' || status === 'CANCELLED' || status === 'EXPIRED' || status === 'REFUNDED') {
    return 'badge badge-bad';
  }

  return 'badge badge-warn';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
