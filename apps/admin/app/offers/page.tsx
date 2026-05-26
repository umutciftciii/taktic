import Link from 'next/link';
import { apiFetch, Offer } from '../../lib/api';

export default async function AdminOffersPage() {
  const offers = await apiFetch<Offer[]>('/offers');

  return (
    <main>
      <p>
        <Link href="/">Admin home</Link>
      </p>
      <h1>Offers</h1>
      <table>
        <thead>
          <tr>
            <th>Submitted</th>
            <th>Provider</th>
            <th>Request category</th>
            <th>Location</th>
            <th>Price</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {offers.map((offer) => (
            <tr key={offer.id}>
              <td>{formatDate(offer.submittedAt)}</td>
              <td>{offer.provider.businessName}</td>
              <td>{offer.request.category.name}</td>
              <td>
                {offer.request.city}/{offer.request.district}
              </td>
              <td>
                {offer.priceAmount} {offer.currency}
              </td>
              <td>{offer.status}</td>
              <td>
                <Link href={`/offers/${offer.id}`}>Open</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {offers.length === 0 ? <p>No offers yet.</p> : null}
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
