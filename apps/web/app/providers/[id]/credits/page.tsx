import Link from 'next/link';
import { apiFetch, OfferCreditPackage, ProviderCredits } from '../../../../lib/api';

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
        <Link href={`/providers/${id}`}>Provider profile</Link>
      </p>
      <h1>Teklif Kredileri</h1>
      <p>Mevcut bakiye: {credits.balance}</p>
      <p>Bu fazda paket satın alma ve teklif kredisi harcama aktif değildir.</p>

      <section>
        <h2>Paketler</h2>
        {packages.map((creditPackage) => (
          <article key={creditPackage.id}>
            <h3>{creditPackage.name}</h3>
            <p>Kredi: {creditPackage.creditAmount}</p>
            <p>
              Fiyat: {creditPackage.priceAmount} {creditPackage.currency}
            </p>
            {creditPackage.description ? <p>{creditPackage.description}</p> : null}
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
                <td>{transaction.type}</td>
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

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
