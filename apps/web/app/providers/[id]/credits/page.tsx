import Link from 'next/link';
import { apiFetch, OfferCreditPackage, ProviderCredits } from '../../../../lib/api';
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
      <p>
        <Link href="/providers/me">Panelim</Link> <Link href={`/providers/${id}`}>Profil</Link>{' '}
        <Link href={`/providers/${id}/package-purchases`}>Paket satın alma geçmişi</Link>
      </p>
      <h1>Teklif Kredileri</h1>
      <section className="summary-card">
        <p className="muted">Kredi Bakiyesi</p>
        <p className="metric">{credits.balance}</p>
      </section>
      <p className="notice">
        Paket satın alma akışı mock ödeme ile çalışır. Gerçek ödeme sağlayıcısı veya gerçek kart işlemi yoktur.
      </p>

      <section>
        <h2>Paketler</h2>
        {packages.map((creditPackage) => (
          <article className="card" key={creditPackage.id}>
            <h3>{creditPackage.name}</h3>
            <p>Kredi: {creditPackage.creditAmount}</p>
            <p>
              Fiyat: {creditPackage.priceAmount} {creditPackage.currency}
            </p>
            {creditPackage.description ? <p>{creditPackage.description}</p> : null}
            <form action={createPackagePurchaseAction}>
              <input type="hidden" name="providerId" value={id} />
              <input type="hidden" name="packageId" value={creditPackage.id} />
              <p>
                <label>
                  Not
                  <input name="providerNote" placeholder="İsteğe bağlı" />
                </label>
              </p>
              <button type="submit">Paket Satın Al</button>
            </form>
          </article>
        ))}
      </section>

      <section>
        <h2>İşlem Geçmişi</h2>
        {credits.transactions.length === 0 ? <p>Henüz kredi işlemi yok.</p> : null}
        <table>
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
                <td>{formatDate(transaction.createdAt)}</td>
                <td>{formatTransactionType(transaction.type)}</td>
                <td>{transaction.amount}</td>
                <td>{transaction.balanceAfter}</td>
                <td>{transaction.reason ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function formatTransactionType(type: string) {
  if (type === 'OFFER_SPEND') {
    return 'Teklif harcaması';
  }

  if (type === 'OFFER_REFUND') {
    return 'Teklif iadesi';
  }

  if (type === 'ADMIN_GRANT') {
    return 'Admin kredi yükleme';
  }

  if (type === 'ADMIN_DEDUCT') {
    return 'Admin kredi düşme';
  }

  if (type === 'PACKAGE_PURCHASE') {
    return 'Paket satın alma';
  }

  return type;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
