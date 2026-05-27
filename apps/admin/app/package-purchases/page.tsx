import Link from 'next/link';
import {
  apiFetch,
  PackagePurchase,
  PackagePurchaseStatus,
  statusLabel,
  statusBadgeClass,
  formatPrice,
  formatDateTime,
} from '../../lib/api';

type AdminPackagePurchasesPageProps = {
  searchParams?: Promise<{
    status?: PackagePurchaseStatus;
    providerId?: string;
    packageId?: string;
  }>;
};

export default async function AdminPackagePurchasesPage({ searchParams }: AdminPackagePurchasesPageProps) {
  const params = (await searchParams) ?? {};
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.providerId) query.set('providerId', params.providerId);
  if (params.packageId) query.set('packageId', params.packageId);
  const purchases = await apiFetch<PackagePurchase[]>(
    `/package-purchases${query.toString() ? `?${query.toString()}` : ''}`,
  );

  return (
    <main>
      <header className="page-header">
        <h1 className="page-title">Paket Talepleri</h1>
        <p className="page-subtitle">Hizmet verenlerin paket satın alma kayıtları.</p>
      </header>

      {query.toString() ? (
        <div className="notice" style={{ marginBottom: 18 }}>
          Filtre aktif. <Link href="/package-purchases">Filtreleri temizle</Link>
        </div>
      ) : null}

      <div className="table-card">
        <div className="table-header">
          <h2>Paket talep listesi</h2>
          <span className="muted" style={{ fontSize: 13 }}>{purchases.length} kayıt</span>
        </div>
        {purchases.length === 0 ? (
          <div style={{ padding: 18 }} className="empty-state">Henüz paket talebi yok.</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Oluşturulma</th>
                  <th>Hizmet Veren</th>
                  <th>Paket</th>
                  <th>Kredi</th>
                  <th>Tutar</th>
                  <th>Durum</th>
                  <th>Mock referans</th>
                  <th>İşlem</th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((purchase) => (
                  <tr key={purchase.id}>
                    <td>{formatDateTime(purchase.createdAt)}</td>
                    <td><strong>{purchase.provider.businessName}</strong></td>
                    <td>{purchase.packageNameSnapshot}</td>
                    <td>{purchase.creditAmountSnapshot}</td>
                    <td>{formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}</td>
                    <td>
                      <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{purchase.mockPaymentReference ?? '-'}</td>
                    <td>
                      <div className="inline-actions">
                        <Link className="btn btn-secondary btn-sm" href={`/package-purchases/${purchase.id}`}>
                          Detay
                        </Link>
                        <Link className="btn btn-ghost btn-sm" href={`/providers/${purchase.providerId}`}>
                          HV
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
