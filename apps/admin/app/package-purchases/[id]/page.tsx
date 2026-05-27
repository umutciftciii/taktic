import Link from 'next/link';
import { apiFetch, PackagePurchase, statusLabel } from '../../../lib/api';
import { updatePackagePurchaseStatusAction } from '../actions';

type AdminPackagePurchaseDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function AdminPackagePurchaseDetailPage({ params }: AdminPackagePurchaseDetailPageProps) {
  const { id } = await params;
  const purchase = await apiFetch<PackagePurchase>(`/package-purchases/${id}`);

  return (
    <main>
      <p>
        <Link href="/package-purchases">Back to package purchases</Link>{' '}
        <Link href={`/providers/${purchase.providerId}`}>Provider</Link>{' '}
        <Link href={`/providers/${purchase.providerId}/credits`}>Provider credits</Link>
      </p>
      <h1>Package Purchase Detail</h1>
      <section>
        <h2>Summary</h2>
        <p>ID: {purchase.id}</p>
        <p>Status: <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span></p>
        <p>Provider: {purchase.provider.businessName}</p>
        <p>Provider email: {purchase.provider.email ?? '-'}</p>
        <p>Package snapshot: {purchase.packageNameSnapshot}</p>
        <p>Credits: {purchase.creditAmountSnapshot}</p>
        <p>
          Price: {purchase.priceAmountSnapshot} {purchase.currencySnapshot}
        </p>
        <p>Created: {formatDate(purchase.createdAt)}</p>
        <p>Paid: {purchase.paidAt ? formatDate(purchase.paidAt) : '-'}</p>
        <p>Failed: {purchase.failedAt ? formatDate(purchase.failedAt) : '-'}</p>
        <p>Cancelled: {purchase.cancelledAt ? formatDate(purchase.cancelledAt) : '-'}</p>
        <p>Expired: {purchase.expiredAt ? formatDate(purchase.expiredAt) : '-'}</p>
        <p>Mock payment reference: {purchase.mockPaymentReference ?? '-'}</p>
        <p>Failure reason: {purchase.mockPaymentFailureReason ?? '-'}</p>
        <p>Credit transaction: {purchase.creditTransactionId ?? '-'}</p>
        <p>Provider note: {purchase.providerNote ?? '-'}</p>
        <p>Admin note: {purchase.adminNote ?? '-'}</p>
      </section>

      {purchase.status === 'PENDING' ? (
        <section>
          <h2>Manual correction</h2>
          <p className="notice">Admin correction only supports CANCELLED or EXPIRED and does not grant credits.</p>
          <form action={updatePackagePurchaseStatusAction}>
            <input type="hidden" name="id" value={purchase.id} />
            <p>
              <label>
                Status
                <select name="status" defaultValue="CANCELLED">
                  <option value="CANCELLED">CANCELLED</option>
                  <option value="EXPIRED">EXPIRED</option>
                </select>
              </label>
            </p>
            <p>
              <label>
                Admin note
                <textarea name="adminNote" />
              </label>
            </p>
            <button type="submit">Update status</button>
          </form>
        </section>
      ) : null}
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
