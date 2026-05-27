import Link from 'next/link';
import {
  apiFetch,
  PackagePurchase,
  statusLabel,
  statusBadgeClass,
  formatPrice,
  formatDateTime,
} from '../../../../lib/api';

type ProviderPackagePurchasesPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderPackagePurchasesPage({ params }: ProviderPackagePurchasesPageProps) {
  const { id } = await params;
  const purchases = await apiFetch<PackagePurchase[]>(`/providers/${id}/package-purchases`);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/credits`}>Kredilerim</Link>
        <span aria-hidden="true">/</span>
        <span>Satın alma geçmişi</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">Paket Satın Alma Geçmişi</h1>
        <p className="page-subtitle">Tüm paket talepleriniz ve durumları.</p>
      </header>

      {purchases.length === 0 ? (
        <div className="empty-state">
          <h2>Henüz paket talebi yok</h2>
          <p className="muted">Krediler sayfasından bir paket satın almayı deneyebilirsiniz.</p>
          <Link className="btn btn-primary" href={`/providers/${id}/credits`} style={{ marginTop: 8 }}>
            Paketleri gör
          </Link>
        </div>
      ) : null}

      <div className="list-stack">
        {purchases.map((purchase) => (
          <article className="list-card" key={purchase.id}>
            <div className="list-card-header">
              <div>
                <h2 className="list-card-title">{purchase.packageNameSnapshot}</h2>
                <p className="list-card-meta">
                  <span>{formatDateTime(purchase.createdAt)}</span>
                  <span>Ref: {purchase.mockPaymentReference ?? '-'}</span>
                </p>
              </div>
              <div className="inline-actions">
                <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span>
                <span className="badge badge-info">{purchase.creditAmountSnapshot} kredi</span>
                <span className="badge">{formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}</span>
              </div>
            </div>
            <div className="inline-actions">
              <Link className="btn btn-secondary btn-sm" href={`/providers/${id}/package-purchases/${purchase.id}`}>
                Detay
              </Link>
              {purchase.status === 'PENDING' ? (
                <Link
                  className="btn btn-primary btn-sm"
                  href={`/providers/${id}/package-purchases/${purchase.id}/checkout`}
                >
                  Ödeme ekranı
                </Link>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
