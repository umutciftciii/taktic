import Link from 'next/link';
import {
  apiFetch,
  OfferCreditPackage,
  ProviderCredits,
  creditTxnTypeLabel,
  formatPrice,
  formatDateTime,
} from '../../../../lib/api';
import { createPackagePurchaseAction } from '../package-purchases/actions';

type ProviderCreditsPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderCreditsPage({ params }: ProviderCreditsPageProps) {
  const { id } = await params;
  const [credits, packages] = await Promise.all([
    apiFetch<ProviderCredits>(`/providers/${id}/credits`),
    apiFetch<OfferCreditPackage[]>('/credit-packages'),
  ]);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}`}>Profil</Link>
        <span aria-hidden="true">/</span>
        <span>Teklif Kredileri</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">Teklif Kredileri</h1>
        <p className="page-subtitle">Kredi bakiyenizi takip edin, paket alarak bakiyeni doldurun.</p>
      </header>

      <section className="stat-grid">
        <div className="stat-card">
          <span className="muted">Kredi bakiyesi</span>
          <span className="metric">{credits.balance}</span>
        </div>
        <div className="stat-card">
          <span className="muted">İşlem sayısı</span>
          <span className="metric">{credits.transactions.length}</span>
        </div>
        <div className="stat-card">
          <span className="muted">Mevcut paket</span>
          <span className="metric">{packages.filter((p) => p.isActive).length}</span>
        </div>
      </section>

      <div className="notice" style={{ marginTop: 18 }}>
        Paket satın alma akışı mock ödeme ile çalışır. Gerçek ödeme sağlayıcısı veya gerçek kart işlemi yoktur.{' '}
        <Link href={`/providers/${id}/package-purchases`}>Geçmiş satın almalarımı gör</Link>
      </div>

      <section style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 18 }}>Paketler</h2>
        <div className="list-stack">
          {packages.map((creditPackage) => (
            <article className="list-card" key={creditPackage.id}>
              <div className="list-card-header">
                <div>
                  <h3 className="list-card-title">{creditPackage.name}</h3>
                  {creditPackage.description ? (
                    <p className="muted" style={{ margin: 0, fontSize: 13 }}>{creditPackage.description}</p>
                  ) : null}
                </div>
                <div className="inline-actions">
                  <span className="badge badge-info">{creditPackage.creditAmount} kredi</span>
                  <span className="badge">{formatPrice(creditPackage.priceAmount, creditPackage.currency)}</span>
                </div>
              </div>
              <form action={createPackagePurchaseAction} style={{ display: 'grid', gap: 10 }}>
                <input type="hidden" name="providerId" value={id} />
                <input type="hidden" name="packageId" value={creditPackage.id} />
                <label className="form-row">
                  <span>Not (isteğe bağlı)</span>
                  <input name="providerNote" placeholder="Satın alma için kısa not" />
                </label>
                <div>
                  <button className="btn btn-primary" type="submit">Paket Satın Al</button>
                </div>
              </form>
            </article>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 18 }}>
        <div className="table-card">
          <div className="table-header">
            <h2>İşlem Geçmişi</h2>
            <span className="muted" style={{ fontSize: 13 }}>{credits.transactions.length} kayıt</span>
          </div>
          {credits.transactions.length === 0 ? (
            <div style={{ padding: 18 }} className="empty-state">Henüz kredi işlemi yok.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
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
                        <span className={transaction.amount >= 0 ? 'badge badge-good' : 'badge badge-bad'}>
                          {transaction.amount > 0 ? `+${transaction.amount}` : transaction.amount}
                        </span>
                      </td>
                      <td>{transaction.balanceAfter}</td>
                      <td className="muted">{transaction.reason ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
