import Link from 'next/link';
import {
  apiFetch,
  PackagePurchase,
  statusLabel,
  statusBadgeClass,
  formatPrice,
  formatDateTime,
} from '../../../../../lib/api';

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
      <p className="breadcrumbs">
        <Link href={`/providers/${id}/package-purchases`}>Satın alma geçmişi</Link>
        <span aria-hidden="true">/</span>
        <span>Detay</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">{purchase.packageNameSnapshot}</h1>
        <p className="page-subtitle">
          <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span>{' '}
          <span className="muted">· {formatDateTime(purchase.createdAt)}</span>
        </p>
      </header>

      <div className="page-narrow">
        <section className="card" style={{ margin: 0 }}>
          <h2>Detaylar</h2>
          <dl className="meta-row">
            <dt>Kredi</dt>
            <dd>{purchase.creditAmountSnapshot}</dd>
            <dt>Tutar</dt>
            <dd>{formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}</dd>
            <dt>Oluşturulma</dt>
            <dd>{formatDateTime(purchase.createdAt)}</dd>
            <dt>Ödendi</dt>
            <dd>{purchase.paidAt ? formatDateTime(purchase.paidAt) : '-'}</dd>
            <dt>Başarısız</dt>
            <dd>{purchase.failedAt ? formatDateTime(purchase.failedAt) : '-'}</dd>
            <dt>Mock ödeme ref.</dt>
            <dd>{purchase.mockPaymentReference ?? '-'}</dd>
            <dt>Başarısızlık nedeni</dt>
            <dd>{purchase.mockPaymentFailureReason ?? '-'}</dd>
            <dt>Kredi işlem kaydı</dt>
            <dd>{purchase.creditTransactionId ?? '-'}</dd>
            <dt>Not</dt>
            <dd className="muted">{purchase.providerNote ?? '-'}</dd>
          </dl>

          {purchase.status === 'PENDING' ? (
            <div className="form-actions" style={{ borderTop: 0, paddingTop: 14 }}>
              <Link className="btn btn-primary" href={`/providers/${id}/package-purchases/${purchase.id}/checkout`}>
                Ödeme ekranına git
              </Link>
              <Link className="btn btn-secondary" href={`/providers/${id}/credits`}>
                Kredilerim
              </Link>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
