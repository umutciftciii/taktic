import Link from 'next/link';
import { apiFetch, PackagePurchase, statusLabel } from '../../../../../lib/api';

type ProviderPackagePurchaseDetailPageProps = {
  params: Promise<{ id: string; purchaseId: string }>;
};

export default async function ProviderPackagePurchaseDetailPage({
  params,
}: ProviderPackagePurchaseDetailPageProps) {
  const { id, purchaseId } = await params;
  const purchase = await apiFetch<PackagePurchase>(`/providers/${id}/package-purchases/${purchaseId}`);

  return (
    <main>
      <p>
        <Link href={`/providers/${id}/package-purchases`}>Satın alma geçmişi</Link>{' '}
        <Link href={`/providers/${id}/credits`}>Kredilerim</Link>
      </p>
      <h1>Paket Satın Alma Detayı</h1>
      <section className="card">
        <h2>{purchase.packageNameSnapshot}</h2>
        <p>
          Durum: <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span>
        </p>
        <p>Kredi: {purchase.creditAmountSnapshot}</p>
        <p>
          Tutar: {purchase.priceAmountSnapshot} {purchase.currencySnapshot}
        </p>
        <p>Oluşturulma: {formatDate(purchase.createdAt)}</p>
        <p>Ödendi: {purchase.paidAt ? formatDate(purchase.paidAt) : '-'}</p>
        <p>Başarısız: {purchase.failedAt ? formatDate(purchase.failedAt) : '-'}</p>
        <p>Mock ödeme referansı: {purchase.mockPaymentReference ?? '-'}</p>
        <p>Başarısızlık nedeni: {purchase.mockPaymentFailureReason ?? '-'}</p>
        <p>Kredi işlem kaydı: {purchase.creditTransactionId ?? '-'}</p>
        <p>Not: {purchase.providerNote ?? '-'}</p>
        {purchase.status === 'PENDING' ? (
          <p>
            <Link className="button" href={`/providers/${id}/package-purchases/${purchase.id}/checkout`}>
              Ödeme ekranına git
            </Link>
          </p>
        ) : null}
      </section>
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
