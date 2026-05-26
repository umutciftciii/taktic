import Link from 'next/link';
import { apiFetch, QualityLabel, ServiceRequest } from '../../lib/api';

type AdminRequestsPageProps = {
  searchParams: Promise<{ quality?: string }>;
};

const qualityFilters: Array<{ label: string; value: QualityLabel | 'all' }> = [
  { label: 'All', value: 'all' },
  { label: 'Low', value: 'LOW' },
  { label: 'Medium', value: 'MEDIUM' },
  { label: 'High', value: 'HIGH' },
];

export default async function AdminRequestsPage({ searchParams }: AdminRequestsPageProps) {
  const { quality } = await searchParams;
  const activeQuality = normalizeQualityFilter(quality);
  const requests = await apiFetch<ServiceRequest[]>('/service-requests');
  const filteredRequests =
    activeQuality === 'all'
      ? requests
      : requests.filter((request) => request.qualityLabel === activeQuality);

  return (
    <main>
      <p>
        <Link href="/categories">Categories</Link>
      </p>
      <h1>Service Requests</h1>
      <p>
        {qualityFilters.map((filter) => (
          <Link
            key={filter.value}
            href={filter.value === 'all' ? '/requests' : `/requests?quality=${filter.value.toLowerCase()}`}
          >
            {activeQuality === filter.value ? `[${filter.label}]` : filter.label}{' '}
          </Link>
        ))}
      </p>
      <table>
        <thead>
          <tr>
            <th>Submitted</th>
            <th>Category</th>
            <th>Customer</th>
            <th>Phone</th>
            <th>Location</th>
            <th>Status</th>
            <th>Quality</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {filteredRequests.map((request) => (
            <tr key={request.id}>
              <td>{formatDate(request.submittedAt)}</td>
              <td>{request.category.name}</td>
              <td>{request.customerName}</td>
              <td>{request.customerPhone}</td>
              <td>
                {request.city}/{request.district}
              </td>
              <td>{request.status}</td>
              <td>
                {request.qualityScore}/100 - {request.qualityLabel}
              </td>
              <td>
                <Link href={`/requests/${request.id}`}>Open</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {filteredRequests.length === 0 ? <p>No service requests found.</p> : null}
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function normalizeQualityFilter(value: string | undefined): QualityLabel | 'all' {
  const normalized = value?.toUpperCase();

  if (normalized === 'LOW' || normalized === 'MEDIUM' || normalized === 'HIGH') {
    return normalized;
  }

  return 'all';
}
