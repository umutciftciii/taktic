import Link from 'next/link';
import { apiFetch, ProviderProfile, ProviderStatus, statusLabel } from '../../../lib/api';
import { updateProviderStatusAction } from '../actions';

const statuses: ProviderStatus[] = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'];

type ProviderDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderDetailPage({ params }: ProviderDetailPageProps) {
  const { id } = await params;
  const provider = await apiFetch<ProviderProfile>(`/providers/${id}`);

  return (
    <main>
      <p>
        <Link href="/providers">Sağlayıcılara dön</Link>{' '}
        <Link href={`/offers?providerId=${provider.id}`}>Teklifleri Gör</Link>{' '}
        <Link href={`/providers/${provider.id}/credits`}>Kredileri Gör</Link>
      </p>
      <h1>{provider.businessName}</h1>

      <section>
        <h2>Profile</h2>
        <p>ID: {provider.id}</p>
        <p>Contact: {provider.contactName}</p>
        <p>Phone: {provider.phone}</p>
        <p>Email: {provider.email ?? '-'}</p>
        <p>Linked user email: {provider.user?.email ?? '-'}</p>
        <p>
          Location: {provider.city}/{provider.district}
        </p>
        <p>Address note: {provider.addressNote ?? '-'}</p>
        <p>Description: {provider.description ?? '-'}</p>
        <p>Status: <span className={statusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span></p>
        <p>Approved at: {provider.approvedAt ? formatDate(provider.approvedAt) : '-'}</p>
        <p>Rejected at: {provider.rejectedAt ? formatDate(provider.rejectedAt) : '-'}</p>
        <p>Suspended at: {provider.suspendedAt ? formatDate(provider.suspendedAt) : '-'}</p>
      </section>

      <section>
        <h2>Categories</h2>
        <ul>
          {provider.serviceCategories.map((item) => (
            <li key={item.id}>{item.category.name}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Service Areas</h2>
        <ul>
          {provider.serviceAreas.map((area) => (
            <li key={area.id}>
              {area.city}
              {area.district ? `/${area.district}` : ''}
              {area.neighborhood ? `/${area.neighborhood}` : ''}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Moderation</h2>
        <p>
          <a href={`http://localhost:3000/providers/${provider.id}/requests`}>Eşleşen talepleri görüntüle</a>
        </p>
        <form action={updateProviderStatusAction}>
          <input type="hidden" name="id" value={provider.id} />
          <p>
            <label>
              Status
              <select name="status" defaultValue={provider.status}>
                {statuses.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              Moderation note
              <textarea name="moderationNote" defaultValue={provider.moderationNote ?? ''} />
            </label>
          </p>
          <p>
            <label>
              Rejection reason
              <textarea name="rejectionReason" defaultValue={provider.rejectionReason ?? ''} />
            </label>
          </p>
          <button type="submit">Save status</button>
        </form>
      </section>
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
