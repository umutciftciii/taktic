import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  getCurrentUser,
  OfferCreditPackage,
  ProviderCredits,
  creditTxnTypeLabel,
  formatPrice,
  formatDateTime,
} from '../../../../lib/api';
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

  const [credits, packages] = await Promise.all([
    apiFetch<ProviderCredits>(`/providers/${id}/credits`),
    apiFetch<OfferCreditPackage[]>('/credit-packages'),
  ]);

  const activePackages = packages.filter((p) => p.isActive);
  const refundedTotal = credits.transactions
    .filter((t) => t.type === 'OFFER_REFUND')
    .reduce((sum, t) => sum + t.amount, 0);
  const spentTotal = credits.transactions
    .filter((t) => t.type === 'OFFER_SPEND')
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);

  return (
    <ProviderShell user={user} providerId={id} active="credits">
      <p className="pdash-crumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Kredilerim</span>
      </p>

      <header className="pdash-page-head">
        <h1 className="pdash-page-title">Kredilerim</h1>
        <p className="pdash-page-sub">
          Kredi bakiyenizi takip edin, paket alarak bakiyenizi doldurun.
        </p>
      </header>

      <section className="pdash-stat-grid" aria-label="Kredi özetleri">
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">Mevcut Bakiye</span>
          <span className="pdash-stat-value">{credits.balance}</span>
          <span className="pdash-stat-hint">Kredi</span>
        </div>
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">Harcanan</span>
          <span className="pdash-stat-value">{spentTotal}</span>
          <span className="pdash-stat-hint">Teklif gönderim toplamı</span>
        </div>
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">İade Edilen</span>
          <span className="pdash-stat-value">{refundedTotal}</span>
          <span className="pdash-stat-hint">Kredi iade işlemi toplamı</span>
        </div>
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">Aktif Paket</span>
          <span className="pdash-stat-value">{activePackages.length}</span>
          <span className="pdash-stat-hint">Satın alınabilir paket sayısı</span>
        </div>
      </section>

      <div className="pdash-notice">
        Paket satın alma akışı mock ödeme ile çalışır. Gerçek ödeme sağlayıcısı veya gerçek kart işlemi
        yoktur.{' '}
        <Link href={`/providers/${id}/package-purchases`}>Geçmiş satın almalarımı gör</Link>
      </div>

      <div className="pdash-section-head">
        <h2 className="pdash-section-title">
          Kredi Paketleri
          <span className="pdash-section-count">{activePackages.length}</span>
        </h2>
      </div>

      {activePackages.length === 0 ? (
        <div className="pdash-empty">
          <h3>Şu an aktif paket yok</h3>
          <p>Yeni paket eklendiğinde burada listelenecek.</p>
        </div>
      ) : (
        <div className="pdash-grid">
          {activePackages.map((creditPackage) => (
            <article className="pdash-card" key={creditPackage.id}>
              <div className="pdash-card-head">
                <div style={{ minWidth: 0 }}>
                  <h3 className="pdash-card-title">{creditPackage.name}</h3>
                  {creditPackage.description ? (
                    <p className="pdash-card-sub">{creditPackage.description}</p>
                  ) : null}
                </div>
                <span className="pdash-badge pdash-badge-info">
                  {creditPackage.creditAmount} kredi
                </span>
              </div>

              <div className="pdash-card-foot">
                <div>
                  <div className="pdash-card-price-label">Fiyat</div>
                  <div className="pdash-card-price">
                    {formatPrice(creditPackage.priceAmount, creditPackage.currency)}
                  </div>
                </div>
              </div>

              <form action={createPackagePurchaseAction} className="pdash-form">
                <input type="hidden" name="providerId" value={id} />
                <input type="hidden" name="packageId" value={creditPackage.id} />
                <label className="pdash-form-row">
                  <span>Not (isteğe bağlı)</span>
                  <input name="providerNote" placeholder="Satın alma için kısa not" />
                </label>
                <button className="pdash-btn pdash-btn-primary pdash-btn-block" type="submit">
                  Paket Satın Al
                </button>
              </form>
            </article>
          ))}
        </div>
      )}

      <section className="pdash-table-card">
        <div className="pdash-table-head">
          <h2>İşlem Geçmişi</h2>
          <span className="pdash-card-sub">{credits.transactions.length} kayıt</span>
        </div>
        {credits.transactions.length === 0 ? (
          <div className="pdash-empty" style={{ borderTop: 0, borderRadius: 0, borderLeft: 0, borderRight: 0 }}>
            <h3>Henüz kredi işlemi yok</h3>
            <p>Bir paket satın aldığınızda veya teklif gönderdiğinizde işlemler burada görünecek.</p>
          </div>
        ) : (
          <div className="pdash-table-scroll">
            <table className="pdash-table">
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Tip</th>
                  <th>Tutar</th>
                  <th>Bakiye</th>
                  <th>Açıklama</th>
                </tr>
              </thead>
              <tbody>
                {credits.transactions.map((transaction) => (
                  <tr key={transaction.id}>
                    <td>{formatDateTime(transaction.createdAt)}</td>
                    <td>{creditTxnTypeLabel(transaction.type)}</td>
                    <td>
                      <span
                        className={
                          transaction.amount >= 0
                            ? 'pdash-badge pdash-badge-success'
                            : 'pdash-badge pdash-badge-muted'
                        }
                      >
                        {transaction.amount > 0 ? `+${transaction.amount}` : transaction.amount}
                      </span>
                    </td>
                    <td>{transaction.balanceAfter}</td>
                    <td style={{ color: 'var(--muted)' }}>{transaction.reason ?? '-'}</td>
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
