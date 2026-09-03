import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  getCurrentUser,
  OfferCreditPackage,
  PaymentMode,
  ProviderCredits,
  getRefundPolicy,
  creditTxnTypeLabel,
  formatPrice,
  formatDateTime,
} from '../../../../lib/api';
import { IconArrowRight } from '../../../landing-icons';
import { createPackagePurchaseAction } from '../package-purchases/actions';
import { ProviderShell } from '../../provider-shell';

type ProviderCreditsPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderCreditsPage({ params }: ProviderCreditsPageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/credits`);
  }

  const [credits, packages, paymentMode, refundPolicy] = await Promise.all([
    apiFetch<ProviderCredits>(`/providers/${id}/credits`),
    apiFetch<OfferCreditPackage[]>('/credit-packages'),
    apiFetch<PaymentMode>('/payments/mode'),
    // The window a new offer would carry: this panel describes the promise
    // attached to the credits sitting in the balance, not to any one offer.
    getRefundPolicy(),
  ]);

  const activePackages = packages.filter((p) => p.isActive);
  const refundedTotal = credits.transactions
    .filter((t) => t.type === 'OFFER_REFUND')
    .reduce((sum, t) => sum + t.amount, 0);
  const spentTotal = credits.transactions
    .filter((t) => t.type === 'OFFER_SPEND')
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const spendCount = credits.transactions.filter((t) => t.type === 'OFFER_SPEND').length;

  /*
   * "How much of the last package is left" needs the last package purchase to
   * exist. When there is none, the bar and its caption are simply not drawn —
   * a denominator is never assumed.
   */
  const lastPurchase = credits.transactions.find((t) => t.type === 'PACKAGE_PURCHASE') ?? null;
  const lastPurchaseAmount = lastPurchase ? Math.abs(lastPurchase.amount) : null;
  const remainingShare =
    lastPurchaseAmount && lastPurchaseAmount > 0
      ? Math.max(0, Math.min(100, Math.round((credits.balance / lastPurchaseAmount) * 100)))
      : null;

  // The cheapest per-credit package is the reference the others compare against.
  const bestUnitPrice = activePackages.reduce<number | null>((best, pkg) => {
    if (pkg.creditAmount <= 0) return best;
    const unit = pkg.priceAmount / pkg.creditAmount;
    return best === null || unit < best ? unit : best;
  }, null);
  const referenceUnitPrice = activePackages.reduce<number | null>((worst, pkg) => {
    if (pkg.creditAmount <= 0) return worst;
    const unit = pkg.priceAmount / pkg.creditAmount;
    return worst === null || unit > worst ? unit : worst;
  }, null);

  return (
    <ProviderShell user={user} providerId={id} active="credits" creditBalance={credits.balance}>
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Krediler</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">Bakiye</span>
        <h1 className="pdash-page-title">Krediler ve paketler</h1>
        <p className="pdash-page-sub">
          Kredi bakiyeni takip et, paket alarak bakiyeni doldur. Teklif maliyeti kategoriye göre
          değişir; her talebin kredi bedeli o talebin detay ekranında yazılıdır.
        </p>
      </header>

      <section className="credit-panel" aria-label="Kredi bakiyesi">
        <div className="credit-panel-top">
          <div className="credit-panel-cell">
            <span className="metric-label" style={{ textAlign: 'left' }}>
              Mevcut bakiye
            </span>
            <span className="credit-balance">
              {credits.balance}
              <small>kredi</small>
            </span>

            {remainingShare !== null && lastPurchaseAmount !== null ? (
              <div>
                <div className="credit-bar-head">
                  <span>Son paketten kalan</span>
                  <span>
                    {credits.balance} / {lastPurchaseAmount}
                  </span>
                </div>
                <div className="databar" style={{ marginTop: 6 }}>
                  <div className="databar-fill" style={{ width: `${remainingShare}%` }} />
                </div>
              </div>
            ) : null}

            <p className="pdash-credit-note" style={{ margin: 0 }}>
              Teklif maliyeti kategoriye göre değişir; her talebin kredi bedeli detay ekranında
              yazılıdır.
            </p>
          </div>

          <div className="credit-panel-cell">
            <span className="metric-label" style={{ textAlign: 'left' }}>
              Kullanım
            </span>
            <span className="pkg-credits" style={{ fontSize: 28 }}>
              {spendCount} teklif · {spentTotal} kredi
            </span>
            <p className="pdash-credit-note" style={{ margin: 0 }}>
              Kredi bedeli her talebin detayında yazılıdır.
            </p>
            <a className="pdash-btn pdash-btn-primary pdash-btn-block" href="#paketler">
              Kredi yükle
              <IconArrowRight size={12} />
            </a>
          </div>
        </div>

        <div className="credit-panel-foot">
          <div className="metric-cell">
            <span className="metric-label">Harcanan</span>
            <span className="metric-value" style={{ fontSize: 28 }}>
              {spentTotal}
            </span>
          </div>
          <div className="metric-cell">
            <span className="metric-label">İade edilen</span>
            <span className="metric-value" style={{ fontSize: 28 }}>
              {refundedTotal}
            </span>
          </div>
          <div className="metric-cell">
            <span className="metric-label">Son yükleme</span>
            <span className="metric-value" style={{ fontSize: 28 }}>
              {lastPurchaseAmount ?? '—'}
            </span>
          </div>
        </div>
      </section>

      {/*
        The refund promise, on the screen where a provider reads their balance.
        One builder, the same one every other surface uses, so the panel and the
        worker cannot drift apart — including when an administrator changes the
        window.
      */}
      <div className="pdash-notice" data-testid="credit-refund-policy" style={{ marginTop: 24 }}>
        <span>
          <strong>Kredi iadesi:</strong> {refundPolicy.unviewedOfferRefundNotice}{' '}
          <Link href={`/providers/${id}/offers`}>Tekliflerimin iade durumunu gör</Link>
        </span>
      </div>

      <div className="pdash-notice" data-testid="payment-mode-notice" style={{ marginTop: 24 }}>
        <span>
          <strong>Test ödemesi:</strong>{' '}
          {paymentMode.provider === 'lemon-squeezy-test'
            ? 'Paket satın alma akışı Lemon Squeezy sandbox (test) ortamında çalışır. Gerçek bir tahsilat yapılmaz ve kartınızdan para çekilmez; yalnızca test kartları kabul edilir.'
            : 'Paket satın alma akışı uygulama içi mock ödeme ile çalışır. Gerçek ödeme sağlayıcısı veya gerçek kart işlemi yoktur.'}{' '}
          Krediler yalnızca doğrulanmış ödeme bildirimi sonrasında hesabınıza yüklenir.{' '}
          <Link href={`/providers/${id}/package-purchases`}>Geçmiş satın almalarımı gör</Link>
        </span>
      </div>

      <div className="pdash-notice" style={{ marginTop: 16 }}>
        <span>
          <strong>Aylık kota ve limitsiz paketler:</strong> Kredi bakiyesinin yanı sıra 30 gün
          geçerli dönemsel paketler de alabilirsiniz.{' '}
          <Link href={`/providers/${id}/subscriptions`}>Paketlerim sayfasına git</Link>
        </span>
      </div>

      <div className="pdash-section-head" id="paketler">
        <h2 className="pdash-section-title">
          <span>Kredi paketleri</span>
          <span className="pdash-section-count">{activePackages.length}</span>
        </h2>
      </div>

      {activePackages.length === 0 ? (
        <div className="pdash-empty">
          <h3>Şu an aktif paket yok</h3>
          <p>Yeni paket eklendiğinde burada listelenecek.</p>
        </div>
      ) : (
        <div className="pkg-grid">
          {activePackages.map((creditPackage) => {
            const unitPrice =
              creditPackage.creditAmount > 0
                ? creditPackage.priceAmount / creditPackage.creditAmount
                : null;
            const isBest =
              unitPrice !== null && bestUnitPrice !== null && unitPrice === bestUnitPrice;
            // The advantage is computed against the dearest active package —
            // never a figure written into the design.
            const advantage =
              unitPrice !== null && referenceUnitPrice !== null && referenceUnitPrice > 0
                ? Math.round(((referenceUnitPrice - unitPrice) / referenceUnitPrice) * 100)
                : 0;

            return (
              <article
                className={`pkg-card${isBest && activePackages.length > 1 ? ' pkg-card-featured' : ''}`}
                key={creditPackage.id}
              >
                <div className="pkg-head">
                  <span className="pkg-name">{creditPackage.name}</span>
                  {isBest && activePackages.length > 1 ? (
                    <span className="pkg-head-tag">Kredi başı en uygun</span>
                  ) : null}
                </div>

                <div className="pkg-body">
                  <span className="pkg-credits">
                    {creditPackage.creditAmount}
                    <small>kredi</small>
                  </span>
                  <span className="pkg-note">
                    Teklif maliyeti kategoriye göre değişir; her talebin kredi bedeli detayında
                    yazılıdır.
                  </span>

                  <div className="pkg-price-block">
                    <span className="pkg-price">
                      {formatPrice(creditPackage.priceAmount, creditPackage.currency)}
                    </span>
                    {unitPrice !== null ? (
                      <span className="pkg-unit">
                        kredi başı {formatPrice(Math.round(unitPrice), creditPackage.currency)}
                      </span>
                    ) : null}
                    {advantage > 0 ? (
                      <span className="tag tag-accent">%{advantage} avantaj</span>
                    ) : (
                      <span className="tag tag-neutral">Referans fiyat</span>
                    )}
                  </div>

                  {creditPackage.description ? (
                    <ul className="pkg-benefits">
                      <li>{creditPackage.description}</li>
                    </ul>
                  ) : null}
                </div>

                <div className="pkg-foot">
                  <form action={createPackagePurchaseAction} className="pdash-form">
                    <input type="hidden" name="providerId" value={id} />
                    <input type="hidden" name="packageId" value={creditPackage.id} />
                    <label className="pdash-form-row">
                      <span>Not (isteğe bağlı)</span>
                      <input name="providerNote" placeholder="Satın alma için kısa not" />
                    </label>
                    <button className="pdash-btn pdash-btn-primary pdash-btn-block" type="submit">
                      Test Ödemesiyle Paket Al
                    </button>
                  </form>
                  <span className="pkg-note">Krediler süresizdir.</span>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <section className="pdash-table-card" style={{ marginTop: 32 }}>
        <div className="pdash-table-head">
          <h2>İşlem geçmişi</h2>
          <span className="pdash-card-sub">{credits.transactions.length} kayıt</span>
        </div>
        {credits.transactions.length === 0 ? (
          <div className="pdash-empty" style={{ border: 0 }}>
            <h3>Henüz kredi işlemi yok</h3>
            <p>Bir paket satın aldığınızda veya teklif gönderdiğinizde işlemler burada görünecek.</p>
          </div>
        ) : (
          <div className="pdash-table-scroll">
            <table className="pdash-table">
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>İşlem</th>
                  <th>Açıklama</th>
                  <th>Tutar</th>
                  <th>Bakiye</th>
                </tr>
              </thead>
              <tbody>
                {credits.transactions.map((transaction) => (
                  <tr key={transaction.id}>
                    <td>{formatDateTime(transaction.createdAt)}</td>
                    <td>{creditTxnTypeLabel(transaction.type)}</td>
                    <td className="muted">{transaction.reason ?? '-'}</td>
                    <td>
                      <span className={transaction.amount >= 0 ? 'tag tag-ink' : 'tag tag-neutral'}>
                        {transaction.amount > 0 ? `+${transaction.amount}` : transaction.amount}
                      </span>
                    </td>
                    <td>{transaction.balanceAfter}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </ProviderShell>
  );
}
