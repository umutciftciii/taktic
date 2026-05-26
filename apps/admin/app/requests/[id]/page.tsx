import Link from 'next/link';
import { apiFetch, ServiceRequest, ServiceRequestStatus } from '../../../lib/api';
import { updateRequestStatusAction } from '../actions';

const statuses: ServiceRequestStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
];

type RequestDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function RequestDetailPage({ params }: RequestDetailPageProps) {
  const { id } = await params;
  const request = await apiFetch<ServiceRequest>(`/service-requests/${id}`);

  return (
    <main>
      <p>
        <Link href="/requests">Back to requests</Link>
      </p>
      <h1>Service Request</h1>

      <section>
        <h2>Summary</h2>
        <p>ID: {request.id}</p>
        <p>Category: {request.category.name}</p>
        <p>Submitted: {formatDate(request.submittedAt)}</p>
        <p>Status: {request.status}</p>
        <form action={updateRequestStatusAction}>
          <input type="hidden" name="id" value={request.id} />
          <label>
            Change status
            <select name="status" defaultValue={request.status}>
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Save status</button>
        </form>
      </section>

      <section>
        <h2>Customer</h2>
        <p>Name: {request.customerName}</p>
        <p>Phone: {request.customerPhone}</p>
        <p>Email: {request.customerEmail ?? '-'}</p>
      </section>

      <section>
        <h2>Location</h2>
        <p>
          {request.city}/{request.district}
        </p>
        <p>Neighborhood: {request.neighborhood ?? '-'}</p>
        <p>Address note: {request.addressNote ?? '-'}</p>
      </section>

      <section>
        <h2>Budget and Timing</h2>
        <p>Budget min: {request.budgetMin ?? '-'}</p>
        <p>Budget max: {request.budgetMax ?? '-'}</p>
        <p>Preferred date: {request.preferredDate ? formatDate(request.preferredDate) : '-'}</p>
        <p>Urgency: {request.urgency ?? '-'}</p>
        <p>Description: {request.description ?? '-'}</p>
      </section>

      <section>
        <h2>Answers</h2>
        <table>
          <thead>
            <tr>
              <th>Question</th>
              <th>Key</th>
              <th>Type</th>
              <th>Answer</th>
            </tr>
          </thead>
          <tbody>
            {(request.answers ?? []).map((answer) => (
              <tr key={answer.id}>
                <td>{answer.questionLabel}</td>
                <td>{answer.questionKey}</td>
                <td>{answer.questionType}</td>
                <td>{formatValue(answer.value)}</td>
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

function formatValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.join(', ');
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (value === null || value === undefined) {
    return '-';
  }

  return String(value);
}
