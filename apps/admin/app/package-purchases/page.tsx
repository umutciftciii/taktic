import Link from 'next/link';
import { apiFetch, PackagePurchase, PackagePurchaseStatus, statusLabel } from '../../lib/api';

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
      <p>
        <Link href="/">Admin home</Link>
      </p>
      <h1>Package Purchases</h1>
      {query.toString() ? (
        <p className="notice">
          Filtered list. <Link href="/package-purchases">Clear filters</Link>
        </p>
      ) : null}
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Provider</th>
            <th>Package</th>
            <th>Credits</th>
            <th>Price</th>
            <th>Status</th>
            <th>Mock reference</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {purchases.map((purchase) => (
            <tr key={purchase.id}>
              <td>{formatDate(purchase.createdAt)}</td>
              <td>{purchase.provider.businessName}</td>
              <td>{purchase.packageNameSnapshot}</td>
              <td>{purchase.creditAmountSnapshot}</td>
              <td>
                {purchase.priceAmountSnapshot} {purchase.currencySnapshot}
              </td>
              <td><span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span></td>
              <td>{purchase.mockPaymentReference ?? '-'}</td>
              <td>
                <Link href={`/package-purchases/${purchase.id}`}>Open</Link>{' '}
                <Link href={`/providers/${purchase.providerId}`}>Provider</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {purchases.length === 0 ? <div className="empty-state">No package purchases yet.</div> : null}
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
