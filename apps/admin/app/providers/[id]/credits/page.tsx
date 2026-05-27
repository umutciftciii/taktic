import Link from 'next/link';
import { apiFetch, ProviderCredits, creditTxnTypeLabel, formatDateTime } from '../../../../lib/api';
import { deductProviderCreditsAction, grantProviderCreditsAction } from './actions';

type AdminProviderCreditsPageProps = {
  params: Promise<{ id: string }>;
};

export default async function AdminProviderCreditsPage({ params }: AdminProviderCreditsPageProps) {
  const { id } = await params;
  const credits = await apiFetch<ProviderCredits>(`/providers/${id}/credits`);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/">Dashboard</Link>
        <span aria-hidden="true">/</span>
        <Link href="/providers">Hizmet Verenler</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}`}>Detay</Link>
        <span aria-hidden="true">/</span>
        <span>Krediler</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">Hizmet Veren Kredileri</h1>
        <p className="page-subtitle">Manuel kredi ekleyin, düşürün veya işlem geçmişine bakın.</p>
      </header>

      <section className="stat-grid">
        <div className="stat-card">
          <span className="muted">Mevcut bakiye</span>
          <span className="metric">{credits.balance}</span>
        </div>
        <div className="stat-card">
          <span className="muted">İşlem sayısı</span>
          <span className="metric">{credits.transactions.length}</span>
        </div>
      </section>

      <div className="detail-grid" style={{ marginTop: 18 }}>
        <div className="stack">
          <section className="table-card">
            <div className="table-header">
              <h2>İşlemler</h2>
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
                      <th>Sebep</th>
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
          </section>
        </div>

        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Manuel Kredi Ekle</h2>
            <form action={grantProviderCreditsAction} style={{ display: 'grid', gap: 12 }}>
              <input type="hidden" name="providerId" value={id} />
              <CreditFormFields />
              <div>
                <button className="btn btn-primary btn-block" type="submit">Kredi ekle</button>
              </div>
            </form>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Manuel Kredi Düş</h2>
            <form action={deductProviderCreditsAction} style={{ display: 'grid', gap: 12 }}>
              <input type="hidden" name="providerId" value={id} />
              <CreditFormFields />
              <div>
                <button className="btn btn-danger btn-block" type="submit">Kredi düş</button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}

function CreditFormFields() {
  return (
    <>
      <label className="form-row">
        <span>Tutar</span>
        <input name="amount" type="number" min="1" required />
      </label>
      <label className="form-row">
        <span>Sebep</span>
        <input name="reason" placeholder="Yönetici notu" />
      </label>
    </>
  );
}
