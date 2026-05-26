import Link from 'next/link';
import { apiFetch, ServiceRequest } from '../../lib/api';

export default async function AdminRequestsPage() {
  const requests = await apiFetch<ServiceRequest[]>('/service-requests');

  return (
    <main>
      <p>
        <Link href="/categories">Categories</Link>
      </p>
      <h1>Service Requests</h1>
      <table>
        <thead>
          <tr>
            <th>Submitted</th>
            <th>Category</th>
            <th>Customer</th>
            <th>Phone</th>
            <th>Location</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
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
                <Link href={`/requests/${request.id}`}>Open</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {requests.length === 0 ? <p>No service requests yet.</p> : null}
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
