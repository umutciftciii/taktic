import Link from 'next/link';
import { apiFetch, ProviderCredits } from '../../../../lib/api';
import { deductProviderCreditsAction, grantProviderCreditsAction } from './actions';

type AdminProviderCreditsPageProps = {
  params: Promise<{ id: string }>;
};

export default async function AdminProviderCreditsPage({ params }: AdminProviderCreditsPageProps) {
  const { id } = await params;
  const credits = await apiFetch<ProviderCredits>(`/providers/${id}/credits`);

  return (
    <main>
      <p>
        <Link href={`/providers/${id}`}>Back to provider</Link>
      </p>
      <h1>Provider Credits</h1>
      <p>Current balance: {credits.balance}</p>

      <section>
        <h2>Manual Grant</h2>
        <form action={grantProviderCreditsAction}>
          <input type="hidden" name="providerId" value={id} />
          <CreditFormFields />
          <button type="submit">Grant credits</button>
        </form>
      </section>

      <section>
        <h2>Manual Deduct</h2>
        <form action={deductProviderCreditsAction}>
          <input type="hidden" name="providerId" value={id} />
          <CreditFormFields />
          <button type="submit">Deduct credits</button>
        </form>
      </section>

      <section>
        <h2>Transactions</h2>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Balance after</th>
              <th>Reason</th>
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

function CreditFormFields() {
  return (
    <>
      <p>
        <label>
          Amount
          <input name="amount" type="number" min="1" required />
        </label>
      </p>
      <p>
        <label>
          Reason
          <input name="reason" />
        </label>
      </p>
    </>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
