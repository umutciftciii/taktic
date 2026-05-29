import { redirect } from 'next/navigation';
import { apiFetch, CustomerServiceRequest, getCurrentUser } from '../../../lib/api';
import { CustomerShell } from '../customer-shell';
import { RequestsBoard } from './requests-board';

export default async function MyRequestsPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'CUSTOMER') {
    redirect('/login?redirectTo=/requests/my');
  }

  const requests = await apiFetch<CustomerServiceRequest[]>('/service-requests/my');

  return (
    <CustomerShell user={user} active="requests">
      <header className="cdash-page-head">
        <h1 className="cdash-page-title">Taleplerim</h1>
        <p className="cdash-page-sub">Tüm servis taleplerinizi buradan takip edebilirsiniz.</p>
      </header>

      <RequestsBoard requests={requests} />
    </CustomerShell>
  );
}
