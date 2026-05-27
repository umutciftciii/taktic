import Link from 'next/link';
import { apiFetch, PackagePurchase, statusLabel } from '../../../../../../lib/api';
import { mockPayPackagePurchaseAction } from './actions';

type ProviderPackagePurchaseCheckoutPageProps = {
  params: Promise<{ id: string; purchaseId: string }>;
};

export default async function ProviderPackagePurchaseCheckoutPage({
  params,
}: ProviderPackagePurchaseCheckoutPageProps) {
  const { id, purchaseId } = await params;
  const purchase = await apiFetch<PackagePurchase>(`/providers/${id}/package-purchases/${purchaseId}`);

  return (
    <main>
      <p>
        <Link href={`/providers/${id}/package-purchases/${purchase.id}`}>Satın alma detayı</Link>{' '}
        <Link href={`/providers/${id}/credits`}>Kredilerim</Link>
      </p>
      <h1>Mock Paket Ödeme</h1>
      <p className="notice">Bu ödeme ekranı test amaçlıdır. Gerçek kart bilgisi girmeyin.</p>

      <section className="summary-card">
        <p className="muted">Paket</p>
        <h2>{purchase.packageNameSnapshot}</h2>
        <p>{purchase.creditAmountSnapshot} kredi</p>
        <p>
          {purchase.priceAmountSnapshot} {purchase.currencySnapshot}
        </p>
        <p>
          Durum: <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span>
        </p>
      </section>

      {purchase.status === 'PENDING' ? (
        <form action={mockPayPackagePurchaseAction}>
          <input type="hidden" name="providerId" value={id} />
          <input type="hidden" name="purchaseId" value={purchase.id} />
          <p>
            <label>
              Kart üzerindeki isim
              <input name="cardholderName" required placeholder="Test User" />
            </label>
          </p>
          <p>
            <label>
              Kart numarası
              <input name="cardNumber" required inputMode="numeric" placeholder="4242424242424242" />
            </label>
          </p>
          <p className="actions">
            <label>
              Ay
              <input name="expiryMonth" required type="number" min="1" max="12" defaultValue={12} />
            </label>
            <label>
              Yıl
              <input name="expiryYear" required type="number" min={new Date().getFullYear()} defaultValue={2030} />
            </label>
            <label>
              CVV
              <input name="cvv" required inputMode="numeric" placeholder="123" />
            </label>
          </p>
          <p className="muted">Kart numarası 0000 ile biterse mock ödeme deterministik olarak başarısız olur.</p>
          <button type="submit">Mock Ödemeyi Tamamla</button>
        </form>
      ) : (
        <p className="notice">
          Bu satın alma artık ödeme alamaz. Durum: {statusLabel(purchase.status)}
        </p>
      )}
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
