import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../lib/api';
import { IconPlus } from '../../landing-icons';
import { CustomerShell } from '../customer-shell';
import { loadCustomerRequests } from '../customer-panel-data';
import { RequestsBoard } from './requests-board';

export default async function MyRequestsPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'CUSTOMER') {
    redirect('/login?redirectTo=/requests/my');
  }

  // The same memoised load the sidebar counters use, so the panel asks for
  // this list once per render however many parts of it need the list.
  const requests = await loadCustomerRequests();

  /*
   * Every number on this screen is counted from the customer's own requests.
   * There is no separate summary endpoint, and nothing here is a placeholder.
   */
  const live = requests.filter((request) => request.status === 'APPROVED').length;
  const matched = requests.filter((request) => request.status === 'MATCHED').length;
  const completed = requests.filter((request) => request.status === 'COMPLETED').length;
  const offers = requests.reduce((total, request) => total + request.offersCount, 0);

  return (
    <CustomerShell user={user} active="requests">
      <header className="cdash-page-head">
        <div className="panel-head-row">
          <div>
            <span className="kicker">Genel bakış</span>
            <h1 className="cdash-page-title">Taleplerim</h1>
            <p className="cdash-page-sub">
              Tüm servis taleplerinizi buradan takip edebilirsiniz.
            </p>
          </div>
          <Link className="cdash-btn cdash-btn-primary" href="/categories">
            <IconPlus size={14} />
            Yeni Talep
          </Link>
        </div>
      </header>

      <section className="metric-strip" aria-label="Talep özeti">
        <div className="metric-cell">
          <span className="metric-label">Yayında talep</span>
          <span className="metric-value">{live}</span>
          <span className="metric-hint">teklif alıyor</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">Gelen teklif</span>
          <span className="metric-value">{offers}</span>
          <span className="metric-hint">tüm talepler</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">Eşleşen iş</span>
          <span className="metric-value">{matched}</span>
          <span className="metric-hint">devam ediyor</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">Tamamlanan</span>
          <span className="metric-value">{completed}</span>
          <span className="metric-hint">toplam</span>
        </div>
      </section>

      <RequestsBoard requests={requests} />
    </CustomerShell>
  );
}
