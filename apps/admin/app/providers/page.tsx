import Link from 'next/link';
import { apiFetch, ProviderProfile } from '../../lib/api';

export default async function AdminProvidersPage() {
  const providers = await apiFetch<ProviderProfile[]>('/providers');

  return (
    <main>
      <p>
        <Link href="/">Admin home</Link>
      </p>
      <h1>Providers</h1>
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
              <td>{provider.status}</td>
              <td>
                <Link href={`/providers/${provider.id}`}>Open</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {providers.length === 0 ? <p>No providers yet.</p> : null}
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
