import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  getCurrentUser,
  PackagePurchase,
  statusLabel,
  formatPrice,
} from '../../../../../../lib/api';
import { ProviderShell } from '../../../../provider-shell';
import { providerStatusBadgeClass } from '../../../../provider-ui';
import { mockPayPackagePurchaseAction } from './actions';

type ProviderPackagePurchaseCheckoutPageProps = {
  params: Promise<{ id: string; purchaseId: string }>;
};

export default async function ProviderPackagePurchaseCheckoutPage({
  params,
}: ProviderPackagePurchaseCheckoutPageProps) {
  const { id, purchaseId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/package-purchases/${purchaseId}/checkout`);
  }

  const purchase = await apiFetch<PackagePurchase>(`/providers/${id}/package-purchases/${purchaseId}`);
  const hostedCheckoutUrl =
    purchase.status === 'PENDING' ? purchase.providerCheckoutUrl : null;

  return (
    <ProviderShell user={user} providerId={id} active="packages">
      <p className="pdash-crumbs">
        <Link href={`/providers/${id}/package-purchases/${purchase.id}`}>← İptal Et ve Dön</Link>
      </p>

      <header className="pdash-page-head">
        <h1 className="pdash-page-title">Paket Ödeme</h1>
        <p className="pdash-page-sub">Seçtiğiniz paketi tamamlamak için lütfen aşağıdaki bilgileri doldurun.</p>
      </header>

      <div className="pdash-notice">
        <strong>Test Ortamı Bildirimi:</strong> Bu bir <strong>Mock Paket Ödeme</strong> ekranıdır. Gerçek
        bir tahsilat yapılmayacaktır. Lütfen test kartı bilgilerini kullanınız. İpucu: kart numarası{' '}
        <code>0000</code> ile biterse mock ödeme deterministik olarak başarısız olur.
      </div>

      <div className="pdash-detail-grid">
        <section className="pdash-detail-card">
          <h2>Kart Bilgileri</h2>
          {hostedCheckoutUrl ? (
            /*
             * This purchase was opened against a hosted sandbox checkout, so
             * the in-app mock form must not be offered for it: paying it here
             * would settle a purchase the payment provider still considers
             * open.
             */
            <div className="pdash-notice pdash-notice-warn">
              Bu satın alma sağlayıcının test (sandbox) ödeme sayfası üzerinden başlatıldı. Ödemeyi
              o sayfada tamamlayın; kredi yalnızca doğrulanmış ödeme bildirimi ulaştığında yüklenir.
              <p style={{ marginBottom: 0, marginTop: 12 }}>
                <a className="pdash-btn pdash-btn-primary" href={hostedCheckoutUrl}>
                  Test Ödeme Sayfasını Aç
                </a>
              </p>
            </div>
          ) : purchase.paymentProvider === 'lemon-squeezy-test' ? (
            <div className="pdash-notice pdash-notice-warn">
              Bu satın alma sağlayıcının test ödeme sayfası üzerinden başlatıldı ve o sayfanın
              süresi doldu. Kredilerim ekranından yeni bir test ödemesi başlatabilirsiniz.
            </div>
          ) : purchase.status === 'PENDING' ? (
            <form action={mockPayPackagePurchaseAction} className="pdash-form">
              <input type="hidden" name="providerId" value={id} />
              <input type="hidden" name="purchaseId" value={purchase.id} />
              <label className="pdash-form-row">
                <span>Kart Üzerindeki İsim</span>
                <input name="cardholderName" required placeholder="Test Kullanıcısı" />
              </label>
              <label className="pdash-form-row">
                <span>Kart Numarası</span>
                <input
                  name="cardNumber"
                  required
                  inputMode="numeric"
                  placeholder="4242 4242 4242 4242"
                />
              </label>
              <div className="pdash-form-grid">
                <label className="pdash-form-row">
                  <span>Ay</span>
                  <input name="expiryMonth" required type="number" min="1" max="12" defaultValue={12} />
                </label>
                <label className="pdash-form-row">
                  <span>Yıl</span>
                  <input
                    name="expiryYear"
                    required
                    type="number"
                    min={new Date().getFullYear()}
                    defaultValue={2030}
                  />
                </label>
                <label className="pdash-form-row">
                  <span>CVV</span>
                  <input name="cvv" required inputMode="numeric" placeholder="123" />
                </label>
              </div>
              <div className="pdash-notice">🔒 256-bit SSL ile güvenli ödeme (mock)</div>
              <button className="pdash-btn pdash-btn-primary pdash-btn-block" type="submit">
                Mock Ödemeyi Tamamla
              </button>
            </form>
          ) : (
            <div className="pdash-notice pdash-notice-warn">
              Bu satın alma artık ödeme alamaz. Durum:{' '}
              <span className={providerStatusBadgeClass(purchase.status)}>
                {statusLabel(purchase.status)}
              </span>
            </div>
          )}
        </section>

        <aside
          className="pdash-detail-card"
          aria-label="Sipariş özeti"
          style={{ position: 'sticky', top: 96 }}
        >
          <h2>Sipariş Özeti</h2>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <h3 className="pdash-card-title">{purchase.packageNameSnapshot}</h3>
              <p className="pdash-card-sub" style={{ marginTop: 4 }}>
                {purchase.creditAmountSnapshot} Kredi
              </p>
            </div>
            <span className={providerStatusBadgeClass(purchase.status)}>
              {statusLabel(purchase.status)}
            </span>
          </div>

          <div
            style={{
              borderTop: '1px solid var(--border-2)',
              paddingTop: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 12,
              }}
            >
              <span className="pdash-card-price-label">Toplam Tutar</span>
              <span className="pdash-card-price">
                {formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}
              </span>
            </div>
          </div>

          <p className="pdash-card-sub" style={{ marginTop: -4 }}>
            Ödemeyi tamamlayarak Kullanıcı Sözleşmesi'ni kabul etmiş olursunuz.
          </p>
        </aside>
      </div>
    </ProviderShell>
  );
}
