import Link from 'next/link';
import { redirect } from 'next/navigation';
import { apiFetch, CustomerServiceRequest, getCurrentUser } from '../../../lib/api';

export default async function MyRequestsPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'CUSTOMER') {
    redirect('/login?redirectTo=/requests/my');
  }

  const requests = await apiFetch<CustomerServiceRequest[]>('/service-requests/my');

  return (
    <main>
      <p>
        <Link href="/">Ana sayfa</Link>
      </p>
      <h1>Taleplerim</h1>
      {requests.length === 0 ? <p>Henüz hesabınıza bağlı talep yok.</p> : null}
      <ul>
        {requests.map((request) => (
          <li key={request.id}>
            <Link href={`/requests/${request.id}/offers`}>
              {request.category.name} - {request.city}/{request.district}
            </Link>{' '}
            ({request.status}, {request.offersCount} teklif, {formatDate(request.submittedAt)})
          </li>
        ))}
      </ul>
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
