import Link from 'next/link';
import { apiFetch, QualityScoreBreakdown, ServiceRequest, ServiceRequestStatus, statusLabel } from '../../../lib/api';
import { recalculateRequestQualityAction, updateRequestStatusAction } from '../actions';

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
        <Link href="/requests">Taleplere dön</Link>{' '}
        <Link href={`/offers?requestId=${request.id}`}>Teklifleri Gör</Link>
      </p>
      <h1>Service Request</h1>

      <section>
        <h2>Summary</h2>
        <p>ID: {request.id}</p>
        <p>Category: {request.category.name}</p>
        <p>Submitted: {formatDate(request.submittedAt)}</p>
        <p>Status: <span className={statusBadgeClass(request.status)}>{statusLabel(request.status)}</span></p>
        <p>
          <strong className={qualityBadgeClass(request.qualityLabel)}>
            Talep Kalite Skoru: {request.qualityScore}/100 - {request.qualityLabel}
          </strong>
        </p>
        <p>Moderated at: {request.moderatedAt ? formatDate(request.moderatedAt) : '-'}</p>
        <form action={updateRequestStatusAction}>
          <input type="hidden" name="id" value={request.id} />
          <p>
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
          </p>
          <p>
            <label>
              Moderation note
              <textarea name="moderationNote" defaultValue={request.moderationNote ?? ''} />
            </label>
          </p>
          <p>
            <label>
              Rejection reason
              <textarea name="rejectionReason" defaultValue={request.rejectionReason ?? ''} />
            </label>
          </p>
          <button type="submit">Save status</button>
        </form>
        <form action={recalculateRequestQualityAction}>
          <input type="hidden" name="id" value={request.id} />
          <button type="submit">Recalculate quality score</button>
        </form>
      </section>

      <section>
        <h2>Quality Breakdown</h2>
        <table>
          <thead>
            <tr>
              <th>Component</th>
              <th>Points</th>
              <th>Max</th>
              <th>Passed</th>
            </tr>
          </thead>
          <tbody>{renderBreakdownRows(request.qualityScoreBreakdown)}</tbody>
        </table>
      </section>

      <section>
        <h2>Customer</h2>
        <p>Name: {request.customerName}</p>
        <p>Phone: {request.customerPhone}</p>
        <p>Email: {request.customerEmail ?? '-'}</p>
        <p>Linked account email: {request.customer?.email ?? '-'}</p>
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

function statusBadgeClass(status: string) {
  if (status === 'APPROVED') return 'badge badge-good';
  if (status === 'REJECTED' || status === 'CANCELLED') return 'badge badge-bad';
  return 'badge badge-warn';
}

function qualityBadgeClass(label: string) {
  if (label === 'HIGH') return 'badge badge-good';
  if (label === 'MEDIUM') return 'badge badge-warn';
  return 'badge badge-bad';
}

function renderBreakdownRows(breakdown: QualityScoreBreakdown | null) {
  if (!breakdown) {
    return (
      <tr>
        <td colSpan={4}>No breakdown stored.</td>
      </tr>
    );
  }

  return Object.entries(breakdown).map(([key, component]) => (
    <tr key={key}>
      <td>{key}</td>
      <td>{component.points}</td>
      <td>{component.max}</td>
      <td>{component.passed ? 'Yes' : 'No'}</td>
    </tr>
  ));
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
