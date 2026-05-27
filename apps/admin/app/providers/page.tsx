import Link from 'next/link';
import { apiFetch, ProviderProfile, statusLabel } from '../../lib/api';

export default async function AdminProvidersPage() {
  const providers = await apiFetch<ProviderProfile[]>('/providers');

  return (
    <main>
      <p>
        <Link href="/">Admin home</Link>
      </p>
      <h1>Providers</h1>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Business</th>
            <th>Contact</th>
            <th>Phone</th>
            <th>Location</th>
            <th>Categories</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr key={provider.id}>
              <td>{formatDate(provider.createdAt)}</td>
              <td>{provider.businessName}</td>
              <td>{provider.contactName}</td>
              <td>{provider.phone}</td>
              <td>
                {provider.city}/{provider.district}
              </td>
              <td>{provider.serviceCategories.map((item) => item.category.name).join(', ')}</td>
              <td><span className={statusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span></td>
              <td>
                <Link href={`/providers/${provider.id}`}>Open</Link>{' '}
                <Link href={`/offers?providerId=${provider.id}`}>Offers</Link>{' '}
                <Link href={`/providers/${provider.id}/credits`}>Credits</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {providers.length === 0 ? <div className="empty-state">No providers yet.</div> : null}
    </main>
  );
}

function statusBadgeClass(status: string) {
  if (status === 'APPROVED') return 'badge badge-good';
  if (status === 'REJECTED' || status === 'SUSPENDED') return 'badge badge-bad';
  return 'badge badge-warn';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
