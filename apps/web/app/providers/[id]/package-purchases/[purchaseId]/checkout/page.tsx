import Link from 'next/link';
import {
  apiFetch,
  PackagePurchase,
  statusLabel,
  statusBadgeClass,
  formatPrice,
} from '../../../../../../lib/api';
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
      <p className="breadcrumbs">
        <Link href={`/providers/${id}/package-purchases`}>Satın almalar</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/package-purchases/${purchase.id}`}>Detay</Link>
        <span aria-hidden="true">/</span>
        <span>Ödeme</span>
      </p>

      <header className="page-header page-narrow">
        <h1 className="page-title">Mock Paket Ödeme</h1>
        <p className="page-subtitle">Bu ödeme ekranı test amaçlıdır. Gerçek kart bilgisi girmeyin.</p>
      </header>

      <div className="form-card" style={{ maxWidth: 560 }}>
        <section className="form-section">
          <h2>{purchase.packageNameSnapshot}</h2>
          <dl className="meta-row">
            <dt>Kredi</dt>
            <dd>{purchase.creditAmountSnapshot}</dd>
            <dt>Tutar</dt>
            <dd><strong>{formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}</strong></dd>
            <dt>Durum</dt>
            <dd><span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span></dd>
          </dl>
        </section>

        {purchase.status === 'PENDING' ? (
          <form action={mockPayPackagePurchaseAction} className="form-section">
            <h2>Kart Bilgileri</h2>
            <p className="form-section-subtitle">Mock — gerçek kart işlemi yapılmaz.</p>
            <input type="hidden" name="providerId" value={id} />
            <input type="hidden" name="purchaseId" value={purchase.id} />
            <label className="form-row">
              <span>Kart üzerindeki isim</span>
              <input name="cardholderName" required placeholder="Test User" />
            </label>
            <label className="form-row">
              <span>Kart numarası</span>
              <input name="cardNumber" required inputMode="numeric" placeholder="4242 4242 4242 4242" />
            </label>
            <div className="form-grid">
              <label className="form-row">
                <span>Ay</span>
                <input name="expiryMonth" required type="number" min="1" max="12" defaultValue={12} />
              </label>
              <label className="form-row">
                <span>Yıl</span>
                <input
                  name="expiryYear"
                  required
                  type="number"
                  min={new Date().getFullYear()}
                  defaultValue={2030}
                />
              </label>
              <label className="form-row">
                <span>CVV</span>
                <input name="cvv" required inputMode="numeric" placeholder="123" />
              </label>
            </div>
            <p className="help-text">
              İpucu: Kart numarası 0000 ile biterse mock ödeme deterministik olarak başarısız olur.
            </p>
            <div>
              <button className="btn btn-primary btn-block" type="submit">
                Mock Ödemeyi Tamamla
              </button>
            </div>
          </form>
        ) : (
          <div className="notice-warning">
            Bu satın alma artık ödeme alamaz. Durum: {statusLabel(purchase.status)}
          </div>
        )}
      </div>
    </main>
  );
}
